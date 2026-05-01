import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { strict as assert } from "node:assert";
import { parseELF64 } from "./src/elf.js";
import { architectures, x86_64, i386 } from "./src/arch.js";
import { createBlinkHost } from "./src/x86_64-blink.js";
import { createKernel } from "./src/kernel.js";

const tmo = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms)), ms));
const race = (p, ms) => Promise.race([p, tmo(ms)]);
const blob = (path) => fs.readFileSync(path);
const ALPINE_TAR = zlib.gunzipSync(blob("containers/alpine-minirootfs-x86_64.tar.gz"));
const HELLO = blob("containers/hello-x86_64.elf");
const BUSYBOX_STATIC = blob("containers/busybox-x86_64.elf");
async function alpineHost(){ const h=await createBlinkHost({}); h.mountTarBytes(ALPINE_TAR); return h }
const guestBytes = (h, p) => Buffer.from(h.Module.FS.readFile(p));

let pass=0, fail=0;
async function t(name, fn){
  try{ await fn(); console.log("PASS", name); pass++ }
  catch(e){ console.log("FAIL", name, e.message); fail++ }
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
  const host=await createBlinkHost({});
  const r=await race(host.runElf(HELLO, { argv:["hello"] }), 10000);
  assert.equal(r.exitCode, 42);
  assert.match(r.stdout, /hi/);
});

await t("kernel.runX86_64Bytes spawns ProcessActor + propagates exit", async () => {
  const kernel=createKernel({});
  const r=await race(kernel.runX86_64Bytes(HELLO), 10000);
  assert.equal(r.exitCode, 42);
  assert.match(r.stdout, /hi/);
  assert.equal(typeof r.pid, "number");
  const snap=kernel.snapshot();
  assert.equal(snap.processes.length, 1);
  assert.equal(snap.processes[0][1].value, "exited");
});

await t("musl-static busybox: echo + uname + expr", async () => {
  const host=await createBlinkHost({});
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
  const host=await createBlinkHost({});
  await race(host.runElf(HELLO, { argv:["hello"] }), 10000);
  const snap=host.snapshot();
  assert.equal(snap.registers.rax, 0x3cn);
  assert.equal(snap.registers.rdi, 0x2an);
  const dv=new DataView(host.Module.wasmExports.memory.buffer);
  const off=(i)=>dv.getUint32(host.clstruct + i*4, true);
  dv.setBigUint64(off(22), 0xdeadbeefn, true);
  new Uint8Array(host.Module.wasmExports.memory.buffer)[0x4000a0]=0xff;
  host.restore(snap);
  assert.equal(dv.getBigUint64(off(22), true), 0x3cn);
  assert.equal(new Uint8Array(host.Module.wasmExports.memory.buffer)[0x4000a0], 0);
});

await t("SSE2 supported, AVX not (Blink build coverage boundary)", async () => {
  const sse2=await (await createBlinkHost({})).runElf(blob("containers/sse2-test.elf"), { argv:["sse2"] });
  assert.equal(sse2.exitCode, 0);
  const avx=await (await createBlinkHost({})).runElf(blob("containers/avx-test.elf"), { argv:["avx"] });
  assert.equal(avx.exitCode, 132);
  assert.equal(avx.signal?.sig, 4);
});

await t("NODEFS: mount host dir, busybox cat reads it", async () => {
  const host=await createBlinkHost({});
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

await t("NOSOCK confirmed: socket(AF_INET) returns ENOSYS", async () => {
  const host=await alpineHost();
  const r=await race(host.runElf(guestBytes(host,"/bin/busybox"), { argv:["nc", "-z", "127.0.0.1", "80"] }), 12000);
  assert.match(r.stderr, /Function not implemented/);
});

console.log(`\nresult: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
