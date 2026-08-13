import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { strict as assert } from "node:assert";
import { parseELF64 } from "./src/elf.js";
import { architectures, x86_64, i386 } from "./src/arch.js";
import { createBlinkHost } from "./src/x86_64-blink.js";
import { createApk } from "./src/alpine-apk.js";
import { mkdirp } from "./src/apk-format.js";
import { runPipeline, isPipeline, splitPipeline } from "./src/shell-pipeline.js";

// Build a minimal gzipped .apk (tar.gz) in-memory: a .PKGINFO member + one file.
function tarHeader(name, size, type="0", mode=0o644){
  const b=Buffer.alloc(512);
  b.write(name.slice(0,100), 0);
  b.write((mode & 0o7777).toString(8).padStart(7,"0")+"\0", 100);
  b.write("0000000\0", 108); b.write("0000000\0", 116);
  b.write(size.toString(8).padStart(11,"0")+"\0", 124);
  b.write("00000000000\0", 136);
  b.write(type, 156);
  b.write("        ", 148); // checksum field as spaces before computing
  let sum=0; for(let i=0;i<512;i++) sum+=b[i];
  b.write(sum.toString(8).padStart(6,"0")+"\0 ", 148);
  return b;
}
function makeApk(pkgname, pkgver, files){
  const parts=[];
  const pkginfo=`pkgname = ${pkgname}\npkgver = ${pkgver}\n`;
  parts.push(tarHeader(".PKGINFO", Buffer.byteLength(pkginfo)), padBlock(Buffer.from(pkginfo)));
  for(const [name,content] of files){
    const buf=Buffer.from(content);
    parts.push(tarHeader(name, buf.length), padBlock(buf));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks = end of archive
  return zlib.gzipSync(Buffer.concat(parts));
}
function padBlock(buf){ const pad=(512-(buf.length%512))%512; return Buffer.concat([buf, Buffer.alloc(pad)]); }

const tmo = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms)), ms));
const race = (p, ms) => Promise.race([p, tmo(ms)]);
const blob = (path) => fs.readFileSync(path);
const ALPINE_TAR = zlib.gunzipSync(blob("containers/alpine-minirootfs-x86_64.tar.gz"));
const HELLO = blob("containers/hello-x86_64.elf");
const BUSYBOX_STATIC = blob("containers/busybox-x86_64.elf");
const guestBytes = (h, p) => Buffer.from(h.Module.FS.readFile(p));

// Every createBlinkHost() spins a real 8-worker pthread pool with no implicit
// teardown; test.js creates ~20 hosts in one run, and leaving them undisposed
// is the confirmed root cause of the Bun worker_threads OOM cascade (live
// witness: bun test.js went from 22/22 to 13 pass 9 fail "Out of memory",
// starting right after the first un-disposed host accumulated enough workers).
// newHost()/alpineHost() register every host they create; t()'s finally block
// disposes them all after each test, whether it passed, failed, or the test
// body already called dispose() itself (dispose() is idempotent).
const liveHosts=[];
async function newHost(opts={}){ const h=await createBlinkHost(opts); liveHosts.push(h); return h }
async function alpineHost(){ const h=await newHost({}); h.mountTarBytes(ALPINE_TAR); return h }

let pass=0, fail=0;
async function t(name, fn){
  try{ await fn(); console.log("PASS", name); pass++ }
  catch(e){ console.log("FAIL", name, e.message); fail++ }
  finally{
    while(liveHosts.length){ const h=liveHosts.pop(); try{ if(typeof h.dispose==="function") h.dispose(); }catch(_){} }
  }
}

// GNU base-256-size + PAX/long-name-safe tar walker, ported from
// build-blink.yml's XO-smoke step (the plain octal-only parseTar in
// apk-format.js silently mis-decodes this overlay's GNU extensions).
function untarOverlay(FS, tarBuf){
  const str=(o,l)=>Buffer.from(tarBuf.subarray(o,o+l)).toString("utf8").replace(/\0.*$/,"");
  const size=(o)=>{
    if(tarBuf[o]&0x80){ let n=0; for(let i=o+1;i<o+12;i++) n=n*256+tarBuf[i]; return n; }
    return parseInt(str(o,12).trim()||"0",8);
  };
  let off=0, made=0, pending=null, zeros=0;
  while(off+512<=tarBuf.length){
    let allZero=true; for(let i=0;i<512;i++){ if(tarBuf[off+i]!==0){allZero=false;break} }
    if(allZero){ if(++zeros>=2) break; off+=512; continue } zeros=0;
    let name=str(off,100);
    const sz=size(off+124), type=String.fromCharCode(tarBuf[off+156]||48);
    const body=tarBuf.subarray(off+512,off+512+sz);
    const adv=512+Math.ceil(sz/512)*512;
    if(type==="L"){ pending=Buffer.from(body).toString("utf8").replace(/\0.*$/,""); off+=adv; continue }
    if(type==="x"||type==="g"){ const m=Buffer.from(body).toString("utf8").match(/\d+ path=([^\n]+)\n/); if(m) pending=m[1]; off+=adv; continue }
    const prefix=str(off+345,155);
    if(pending){ name=pending; pending=null } else if(prefix){ name=prefix+"/"+name }
    off+=adv;
    if(!name) continue;
    const gp="/"+name.replace(/^\.?\/*/,"").replace(/\/$/,"");
    if(type==="5"){ mkdirp(FS,gp) }
    else if(type==="0"||type==="\0"||type==="7"){ mkdirp(FS,gp.replace(/\/[^/]*$/,"")); try{ FS.writeFile(gp,new Uint8Array(body)); FS.chmod(gp,0o755); made++ }catch(_){} }
  }
  return made;
}

await t("ELF64 parse + arch dispatch", async () => {
  const h=new Uint8Array(64);
  h[0]=0x7f; h[1]=0x45; h[2]=0x4c; h[3]=0x46; h[4]=2; h[5]=1; h[6]=1;
  new DataView(h.buffer).setUint16(16, 2, true);
  new DataView(h.buffer).setUint16(18, 62, true);
  const elf=parseELF64(h);
  assert.equal(elf.header.machine, 62);
  assert.equal(x86_64.matchesELF(elf), true);
  assert.equal(i386.matchesELF(elf), false);
  assert.deepEqual(architectures.list(), ["i386", "x86_64"]);
});

await t("hand-built hello-x86_64 ELF prints hi exit 42", async () => {
  const host=await newHost({});
  const r=await race(host.runElf(HELLO, { argv:["hello"] }), 10000);
  assert.equal(r.exitCode, 42);
  assert.match(r.stdout, /hi/);
});

await t("musl-static busybox: echo + uname + expr", async () => {
  const host=await newHost({});
  const echo=await race(host.runElf(BUSYBOX_STATIC, { argv:["echo", "hello", "x86_64"] }), 12000);
  assert.equal(echo.exitCode, 0);
  assert.match(echo.stdout, /hello x86_64/);
  const uname=await race(host.runElf(BUSYBOX_STATIC, { argv:["uname", "-a"] }), 12000);
  assert.equal(uname.exitCode, 0);
  assert.match(uname.stdout, /x86_64/);
  const expr=await race(host.runElf(BUSYBOX_STATIC, { argv:["expr", "7", "*", "6"] }), 12000);
  assert.equal(expr.exitCode, 0);
  assert.match(expr.stdout, /42/);
});

await t("alpine /bin/busybox + apk via dynamic ld-musl", async () => {
  const host=await alpineHost();
  const ls=await race(host.runElf(guestBytes(host,"/bin/busybox"), { argv:["ls", "/etc"] }), 15000);
  assert.equal(ls.exitCode, 0);
  assert.match(ls.stdout, /alpine-release/);
  const av=await race(host.runElf(guestBytes(host,"/sbin/apk"), { argv:["apk", "--version"] }), 15000);
  assert.equal(av.exitCode, 0);
  assert.match(av.stdout, /apk-tools/);
});

await t("sh script from MEMFS: arithmetic + sequential statements", async () => {
  const host=await alpineHost();
  host.Module.FS.writeFile("/tmp/t.sh", "echo a\necho b\necho $((3+4))\n");
  host.Module.FS.chmod("/tmp/t.sh", 0o755);
  const r=await race(host.runElf(guestBytes(host,"/bin/busybox"), { argv:["sh", "/tmp/t.sh"] }), 15000);
  assert.match(r.stdout, /a\n/);
  assert.match(r.stdout, /b\n/);
  assert.match(r.stdout, /7\n/);
});

await t("runShellScript: quoted strings + variables + arithmetic", async () => {
  const host=await alpineHost();
  const r=await race(host.runShellScript(guestBytes(host,"/bin/busybox"), 'echo "hello with spaces"\nA=42\necho "value=$A"\necho $((A*2))\n'), 15000);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello with spaces/);
  assert.match(r.stdout, /value=42/);
  assert.match(r.stdout, /84\n/);
});

await t("snapshot/restore: byte-exact memory + register round-trip", async () => {
  const host=await newHost({});
  await race(host.runElf(HELLO, { argv:["hello"] }), 10000);
  const snap=host.snapshot();
  assert.equal(snap.registers.rax, 0x3cn);
  assert.equal(snap.registers.rdi, 0x2an);
  // Use HEAPU8.buffer (live, always-current) rather than wasmExports.memory,
  // which is undefined under the -pthread shared/imported-memory build.
  const memBuf=()=>host.Module.HEAPU8?.buffer || host.Module.wasmMemory?.buffer || host.Module.wasmExports.memory.buffer;
  const dv=new DataView(memBuf());
  const off=(i)=>dv.getUint32(host.clstruct + i*4, true);
  dv.setBigUint64(off(22), 0xdeadbeefn, true);
  new Uint8Array(memBuf())[0x4000a0]=0xff;
  host.restore(snap);
  assert.equal(dv.getBigUint64(off(22), true), 0x3cn);
  assert.equal(new Uint8Array(memBuf())[0x4000a0], 0);
});

await t("SSE2 supported, AVX not (Blink build coverage boundary)", async () => {
  const sse2=await (await newHost({})).runElf(blob("containers/sse2-test.elf"), { argv:["sse2"] });
  assert.equal(sse2.exitCode, 0);
  const avx=await (await newHost({})).runElf(blob("containers/avx-test.elf"), { argv:["avx"] });
  assert.equal(avx.exitCode, 132);
  assert.equal(avx.signal?.sig, 4);
});

await t("NODEFS: mount host dir, busybox cat reads it", async () => {
  const host=await newHost({});
  if(!host.capabilities.nodefs){ console.log("(skip: NODEFS not in this wasm build)"); return }
  const dir=os.tmpdir() + "/webix-nodefs-" + Date.now();
  fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(dir + "/numbers.txt", "1\n2\n3\n");
  host.mountNodeDir(dir, "/host");
  assert.ok(host.Module.FS.readdir("/host").includes("numbers.txt"));
  const r=await race(host.runElf(BUSYBOX_STATIC, { argv:["cat", "/host/numbers.txt"] }), 12000);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /1\n2\n3/);
});

await t("NODEFS: guest write-back reaches the real host filesystem", async () => {
  const host=await newHost({});
  if(!host.capabilities.nodefs){ console.log("(skip: NODEFS not in this wasm build)"); return }
  const dir=os.tmpdir() + "/webix-nodefs-writeback-" + Date.now();
  fs.mkdirSync(dir, { recursive:true });
  host.mountNodeDir(dir, "/host");
  const r=await race(host.runShellScript(BUSYBOX_STATIC, 'echo "hello from guest" > /host/written.txt\n'), 12000);
  assert.equal(r.exitCode, 0);
  const hostPath=dir + "/written.txt";
  assert.ok(fs.existsSync(hostPath), "guest write did not appear on the real host fs at "+hostPath);
  assert.equal(fs.readFileSync(hostPath, "utf8"), "hello from guest\n");
});

await t("sockets enabled: socket(AF_INET) no longer ENOSYS", async () => {
  // The portabox build enables --enable-sockets, so socket() is implemented.
  // nc to a closed local port fails to *connect* (no listener / no real net),
  // but must NOT report ENOSYS ("Function not implemented") anymore.
  const host=await alpineHost();
  const r=await race(host.runElf(guestBytes(host,"/bin/busybox"), { argv:["nc", "-z", "127.0.0.1", "80"] }), 12000);
  assert.doesNotMatch(r.stderr, /Function not implemented/, "socket() should be implemented now: "+r.stderr);
});

await t("argv: multi-word argument survives the host->guest boundary", async () => {
  // Regression guard for the NUL-separated argv marshalling. The old
  // space-joined scheme split "hello world" into two args.
  const host=await alpineHost();
  const r=await race(host.runElf(guestBytes(host,"/bin/busybox"), { argv:["echo", "hello world", "second"] }), 12000);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello world second/);
});

await t("pipe() syscall implemented (no ENOSYS); shell pipelines remain fork-blocked", async () => {
  // pipe()/pipe2() are enabled (HAVE_PIPE2) so the syscall itself works and
  // does NOT report ENOSYS. A full shell pipeline (sh -c 'a | b') still cannot
  // run because each stage forks and emscripten has no fork() -- that is a
  // documented limitation, not a regression (see FORK-REALITY). We assert the
  // achievable surface: the pipe syscall does not fault with "not implemented".
  const host=await alpineHost();
  const r=await race(host.runElf(guestBytes(host,"/bin/busybox"), { argv:["sh", "-c", "echo hi | wc -c"] }), 12000);
  // Whatever the pipeline outcome, the failure mode must not be ENOSYS on pipe.
  assert.doesNotMatch(r.stderr, /pipe.*Function not implemented/i, "pipe() should be implemented: "+r.stderr);
});

await t("shell-pipeline.js: non-streaming batch emulation of a real pipe", async () => {
  assert.deepEqual(splitPipeline('echo "a|b"'), ['echo "a|b"']);
  assert.equal(isPipeline("echo hi | wc -c"), true);
  assert.equal(isPipeline("echo hi"), false);
  // Regression guard: `||` (bash OR, not a pipe) must NOT be misread as a
  // 2-stage pipeline -- splitPipeline used to .filter(Boolean) the empty
  // middle stage away, silently running it as a real pipe.
  assert.equal(isPipeline("echo a || echo b"), false);
  assert.equal(isPipeline("| echo a"), false);
  assert.equal(isPipeline("echo a |"), false);
  const host=await alpineHost();
  const busybox=guestBytes(host,"/bin/busybox");
  const r=await race(runPipeline(host, busybox, "echo hello webix world | wc -w"), 15000);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /\b3\b/, "wc -w should count 3 words: "+JSON.stringify(r.stdout));
  assert.equal(r.stageCount, 2);
  const three=await race(runPipeline(host, busybox, "printf 'b\\na\\nc\\n' | sort | tail -n 1"), 15000);
  assert.equal(three.exitCode, 0);
  assert.match(three.stdout, /c/, "three-stage pipeline should end sorted at c: "+JSON.stringify(three.stdout));
  // A preloaded handle (string) works the same as raw bytes -- the path the
  // browser CLI uses to avoid re-fetching busybox on every pipelined command.
  const handle=host.preloadFile("busybox-pipe", busybox);
  const viaHandle=await race(runPipeline(host, handle, "echo via handle | wc -w"), 15000);
  assert.equal(viaHandle.exitCode, 0);
  assert.match(viaHandle.stdout, /\b2\b/, "wc -w via preloaded handle should count 2 words: "+JSON.stringify(viaHandle.stdout));
});

await t("framebuffer: getters exist and report unset before guest registers", async () => {
  // The fb getters are exported and return 0 geometry until a guest registers
  // via syscall 0x5fb. fbInfo() returns null in that state.
  const host=await newHost({});
  assert.equal(typeof host.fbInfo, "function");
  assert.equal(typeof host.fbView, "function");
  assert.equal(host.fbInfo(), null);
  assert.equal(host.Module._blinkenlib_get_fb_width(), 0);
});

await t("framebuffer pipeline: guest fbtest registers gradient, host reads it zero-copy", async () => {
  // End-to-end display proof: a guest ELF mmaps an RGBA buffer, paints a
  // gradient, and publishes it via syscall 0x5fb. The host then reads geometry
  // through fbInfo() and the pixels zero-copy via fbView() (spy_address).
  // containers/fbtest.elf is git-tracked (`git ls-files containers/` confirms
  // it), so its absence is a real regression, not a "not built locally"
  // state -- a silent skip here previously still counted as a pass in the
  // final tally, exactly the hardcoded-assumption failure mode this repo's
  // test discipline exists to catch. Assert, don't skip.
  assert.ok(fs.existsSync("containers/fbtest.elf"), "containers/fbtest.elf is git-tracked and must be present");
  const host=await newHost({});
  const r=await race(host.runElf(blob("containers/fbtest.elf"), { argv:["fbtest"] }), 12000);
  assert.equal(r.exitCode, 42, "fbtest exit");
  const info=host.fbInfo();
  assert.ok(info, "fbInfo should be set after register");
  assert.equal(info.width, 320);
  assert.equal(info.height, 240);
  assert.ok(info.generation >= 1, "generation bumped on register");
  const view=host.fbView();
  assert.ok(view && view.pixels, "fbView returns pixels");
  // Pixel (0,0)=R0 G0 B0 A255; (1,0)=R1 G0 B1 A255 per the gradient.
  assert.equal(view.pixels[3], 255);
  assert.equal(view.pixels[4], 1);
  assert.equal(view.pixels[6], 1);
  // Non-uniform: at least one pixel differs from (0,0).
  let nonUniform=false;
  for(let i=4;i<Math.min(view.pixels.length,4000);i+=4){
    if(view.pixels[i]!==view.pixels[0]||view.pixels[i+1]!==view.pixels[1]){ nonUniform=true; break }
  }
  assert.ok(nonUniform, "framebuffer should be a non-uniform gradient");
});

await t("preloadFile: write ELF once, rerun via handle without re-supplying bytes", async () => {
  const host=await newHost({});
  const handle=host.preloadFile("hello", HELLO);
  assert.equal(host.isPreloaded(handle), true);
  const r1=await race(host.runElf(null, { argv:["hello"], path:handle }), 10000);
  assert.equal(r1.exitCode, 42);
  assert.match(r1.stdout, /hi/);
  // second run reuses the preloaded handle (no FS rewrite), still correct
  const r2=await race(host.runElf(null, { argv:["hello"], path:handle }), 10000);
  assert.equal(r2.exitCode, 42);
  assert.match(r2.stdout, /hi/);
});

await t("createApk: JS-driven apk add extracts package into rootfs + records db", async () => {
  const host=await alpineHost();
  const apk=createApk(host);
  const pkg=makeApk("hello-pkg", "1.2.3", [["usr/share/hello/msg.txt", "from the alpine ecosystem\n"]]);
  const res=await apk.addBytes(pkg);
  assert.equal(res.name, "hello-pkg");
  assert.equal(res.version, "1.2.3");
  assert.equal(apk.isInstalled("hello-pkg"), true);
  // file landed in the guest FS
  const content=Buffer.from(host.Module.FS.readFile("/usr/share/hello/msg.txt")).toString();
  assert.match(content, /from the alpine ecosystem/);
  // installed db updated
  const db=Buffer.from(host.Module.FS.readFile("/lib/apk/db/installed")).toString();
  assert.match(db, /P:hello-pkg/);
  assert.match(db, /V:1.2.3/);
  // installed executable is runnable end-to-end via busybox cat
  const r=await race(host.runElf(guestBytes(host,"/bin/busybox"), { argv:["cat", "/usr/share/hello/msg.txt"] }), 15000);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /from the alpine ecosystem/);
});

await t("createApk: real multi-member busybox-static.apk extracts data tarball", async () => {
  const host=await alpineHost();
  const apk=createApk(host);
  const real=blob("containers/busybox-static.apk"); // apk v2: concatenated gzip members
  const res=await apk.addBytes(real);
  assert.ok(res.files.length > 0, "expected extracted files from data.tar.gz");
  // busybox-static ships /bin/busybox.static (or similar) — at least one bin file
  assert.ok(res.files.some(f=>/bin\//.test(f)), "expected a bin/ file: "+res.files.slice(0,5));
});

await t("createApk: info + list reflect installed packages", async () => {
  const host=await alpineHost();
  const apk=createApk(host);
  await apk.addBytes(makeApk("pkg-a", "0.1", [["opt/a", "A"]]));
  await apk.addBytes(makeApk("pkg-b", "0.2", [["opt/b", "B"]]));
  assert.equal(apk.info("pkg-a").version, "0.1");
  assert.equal(apk.list().length, 2);
  assert.equal(apk.list().find(p=>p.name==="pkg-b").version, "0.2");
});

await t("createApk: remove unlinks files + drops db entry", async () => {
  const host=await alpineHost();
  const apk=createApk(host);
  await apk.addBytes(makeApk("removable", "1.0", [["opt/removable/f", "x"]]));
  assert.equal(apk.isInstalled("removable"), true);
  const res=apk.remove("removable");
  assert.equal(res.removed, true);
  assert.equal(apk.isInstalled("removable"), false);
  assert.throws(() => host.Module.FS.readFile("/opt/removable/f"));
  const db=Buffer.from(host.Module.FS.readFile("/lib/apk/db/installed")).toString();
  assert.doesNotMatch(db, /P:removable/);
});

await t("dispose(): tears down X pump + reaches PThread.terminateAllThreads when exported", async () => {
  const host=await newHost({});
  assert.equal(typeof host.dispose, "function");
  host.dispose(); // no X server running yet -- must be a safe no-op
  assert.equal(host.xRunning(), false);
  if(typeof host.Module.PThread?.terminateAllThreads === "function"){
    // exported build: confirm dispose() doesn't throw when it reaches the real teardown
    host.dispose();
  } else {
    console.log("(note: PThread not exported by this local wasm build; dispose() still safe)");
  }
});

await t("persistent X-server model: startXServer + launchXClient, real client talks X11", async () => {
  // Mirrors build-blink.yml's XO-smoke step (bundled overlay, no apk/network):
  // boot the patched GL-less Xvfb persistently, then run a real X client
  // (xdpyinfo) against it via the current startXServer/launchXClient API.
  // All three are git-tracked (`git ls-files containers/` confirms it), not
  // CI-only outputs, so a missing one is a real regression -- assert, don't
  // silently skip-and-pass (a skip here previously still counted as a pass
  // in the final tally, masking the exact class of gap a regressed/deleted
  // artifact would create).
  const need=["containers/Xvfb-patched","containers/server.xkm","containers/x-client-overlay.tar.gz"];
  for(const p of need) assert.ok(fs.existsSync(p), p+" is git-tracked and must be present");
  const host=await alpineHost();
  const FS=host.Module.FS;
  const made=untarOverlay(FS, zlib.gunzipSync(blob("containers/x-client-overlay.tar.gz")));
  assert.ok(made>0, "overlay should extract at least one file");
  // Same class as the artifact-presence checks above: the overlay archive
  // is git-tracked and asserted to exist, but a silent skip-and-return here
  // on its EXTRACTED CONTENT still counted as a full pass with the rest of
  // this test (the actual X11-client exercise) never running -- a corrupted
  // or regressed overlay would go completely undetected.
  assert.ok(FS.analyzePath("/usr/bin/xdpyinfo").exists, "x-client-overlay.tar.gz must extract /usr/bin/xdpyinfo");
  FS.writeFile("/usr/bin/Xvfb", blob("containers/Xvfb-patched")); FS.chmod("/usr/bin/Xvfb", 0o755);
  const xkm=blob("containers/server.xkm");
  for(const d of ["/tmp","/var/lib/xkb","/usr/share/X11/xkb/compiled",""]){
    mkdirp(FS, d);
    for(const n of ["server-99.xkm","server-98.xkm","server-0.xkm"]) try{ FS.writeFile(d+"/"+n, xkm) }catch(_){}
  }
  await host.startXServer(FS.readFile("/usr/bin/Xvfb"), { argv:[":99","-screen","0","640x480x16","-ac","-noreset","-nolock"] });
  assert.equal(host.xRunning(), true);
  await new Promise(r=>setTimeout(r, 4000)); // let the server reach its dispatch loop
  const c=await race(host.launchXClient(FS.readFile("/usr/bin/xdpyinfo"), { progname:"/usr/bin/xdpyinfo", argv:["-display",":99"], timeoutMs:30000 }), 35000);
  host.dispose();
  assert.equal(host.xRunning(), false);
  const cout=(c.stdout||"")+(c.stderr||"");
  // Was `regex.test(cout) || c.exitCode===0` -- an exit-0-with-empty-output
  // client (connected but never actually queried/printed anything) would
  // pass that OR without ever proving real X11 traffic happened. Require
  // the real content match; exit 0 is corroborating, not sufficient alone.
  assert.match(cout, /number of screens|dimensions:|X\.Org/i, "xdpyinfo should talk X11 to the in-page Xvfb: "+cout.slice(0,300));
});

console.log(`\nresult: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
