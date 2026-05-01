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

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, e.message); fail++; }
}

await t("ELF64 parse + arch dispatch", async () => {
  const h = new Uint8Array(64);
  h[0] = 0x7f; h[1] = 0x45; h[2] = 0x4c; h[3] = 0x46; h[4] = 2; h[5] = 1; h[6] = 1;
  new DataView(h.buffer).setUint16(16, 2, true);
  new DataView(h.buffer).setUint16(18, 62, true);
  const elf = parseELF64(h);
  assert.equal(elf.header.machine, 62);
  assert.equal(x86_64.matchesELF(elf), true);
  assert.equal(i386.matchesELF(elf), false);
  assert.deepEqual(architectures.list(), ["i386", "x86_64"]);
});

await t("hand-built hello-x86_64 ELF prints hi exit 42", async () => {
  const host = await createBlinkHost({});
  const elf = fs.readFileSync("containers/hello-x86_64.elf");
  const r = await race(host.runElf(elf, { argv: ["hello"], progname: "/program" }), 10000);
  assert.equal(r.exitCode, 42);
  assert.match(r.stdout, /hi/);
});

await t("kernel.runX86_64Bytes spawns ProcessActor + propagates exit", async () => {
  const kernel = createKernel({});
  const elf = fs.readFileSync("containers/hello-x86_64.elf");
  const r = await race(kernel.runX86_64Bytes(elf), 10000);
  assert.equal(r.exitCode, 42);
  assert.match(r.stdout, /hi/);
  assert.equal(typeof r.pid, "number");
  const snap = kernel.snapshot();
  assert.equal(snap.processes.length, 1);
  assert.equal(snap.processes[0][1].value, "exited");
});

await t("musl-static busybox: echo + uname + expr", async () => {
  const host = await createBlinkHost({});
  const bb = fs.readFileSync("containers/busybox-x86_64.elf");
  const echo = await race(host.runElf(bb, { argv: ["echo", "hello", "x86_64"], progname: "/program" }), 12000);
  assert.equal(echo.exitCode, 0);
  assert.match(echo.stdout, /hello x86_64/);
  const uname = await race(host.runElf(bb, { argv: ["uname", "-a"], progname: "/program" }), 12000);
  assert.equal(uname.exitCode, 0);
  assert.match(uname.stdout, /x86_64/);
  const expr = await race(host.runElf(bb, { argv: ["expr", "7", "*", "6"], progname: "/program" }), 12000);
  assert.equal(expr.exitCode, 0);
  assert.match(expr.stdout, /42/);
});

await t("alpine /bin/busybox + apk via dynamic ld-musl", async () => {
  const host = await createBlinkHost({});
  const tar = zlib.gunzipSync(fs.readFileSync("containers/alpine-minirootfs-x86_64.tar.gz"));
  host.mountTarBytes(new Uint8Array(tar));
  const bb = Buffer.from(host.Module.FS.readFile("/bin/busybox"));
  const ls = await race(host.runElf(bb, { argv: ["ls", "/etc"], progname: "/program" }), 15000);
  assert.equal(ls.exitCode, 0);
  assert.match(ls.stdout, /alpine-release/);
  const apk = Buffer.from(host.Module.FS.readFile("/sbin/apk"));
  const av = await race(host.runElf(apk, { argv: ["apk", "--version"], progname: "/program" }), 15000);
  assert.equal(av.exitCode, 0);
  assert.match(av.stdout, /apk-tools/);
});

await t("sh script from MEMFS: arithmetic + sequential statements", async () => {
  const host = await createBlinkHost({});
  const tar = zlib.gunzipSync(fs.readFileSync("containers/alpine-minirootfs-x86_64.tar.gz"));
  host.mountTarBytes(new Uint8Array(tar));
  host.Module.FS.writeFile("/tmp/t.sh", "echo a\necho b\necho $((3+4))\n");
  host.Module.FS.chmod("/tmp/t.sh", 0o755);
  const bb = Buffer.from(host.Module.FS.readFile("/bin/busybox"));
  const r = await race(host.runElf(bb, { argv: ["sh", "/tmp/t.sh"], progname: "/program" }), 15000);
  assert.match(r.stdout, /a\n/);
  assert.match(r.stdout, /b\n/);
  assert.match(r.stdout, /7\n/);
});

await t("runShellScript: quoted strings + variables + arithmetic", async () => {
  const host = await createBlinkHost({});
  const tar = zlib.gunzipSync(fs.readFileSync("containers/alpine-minirootfs-x86_64.tar.gz"));
  host.mountTarBytes(new Uint8Array(tar));
  const bb = Buffer.from(host.Module.FS.readFile("/bin/busybox"));
  const r = await race(host.runShellScript(bb, 'echo "hello with spaces"\nA=42\necho "value=$A"\necho $((A*2))\n'), 15000);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello with spaces/);
  assert.match(r.stdout, /value=42/);
  assert.match(r.stdout, /84\n/);
});

await t("snapshot/restore: byte-exact memory + register round-trip", async () => {
  const host = await createBlinkHost({});
  const elf = fs.readFileSync("containers/hello-x86_64.elf");
  await race(host.runElf(elf, { argv: ["hello"], progname: "/program" }), 10000);
  const snap = host.snapshot();
  assert.equal(snap.registers.rax, 0x3cn);
  assert.equal(snap.registers.rdi, 0x2an);
  const dv = new DataView(host.Module.wasmExports.memory.buffer);
  const off = (i) => dv.getUint32(host.clstruct + i * 4, true);
  dv.setBigUint64(off(22), 0xdeadbeefn, true);
  new Uint8Array(host.Module.wasmExports.memory.buffer)[0x4000a0] = 0xff;
  host.restore(snap);
  assert.equal(dv.getBigUint64(off(22), true), 0x3cn);
  assert.equal(new Uint8Array(host.Module.wasmExports.memory.buffer)[0x4000a0], 0);
});

await t("SSE2 supported, AVX not (Blink build coverage boundary)", async () => {
  const host = await createBlinkHost({});
  const sse2 = fs.readFileSync("containers/sse2-test.elf");
  const r1 = await race(host.runElf(sse2, { argv: ["sse2"], progname: "/program" }), 10000);
  assert.equal(r1.exitCode, 0);
  const host2 = await createBlinkHost({});
  const avx = fs.readFileSync("containers/avx-test.elf");
  const r2 = await race(host2.runElf(avx, { argv: ["avx"], progname: "/program" }), 10000);
  assert.equal(r2.exitCode, 132);
  assert.equal(r2.signal?.sig, 4);
});

await t("NODEFS: mount host dir, busybox cat reads it", async () => {
  const host = await createBlinkHost({});
  if (!host.Module.FS.filesystems?.NODEFS) {
    console.log("(skip: NODEFS not in this wasm build)"); return;
  }
  const dir = os.tmpdir() + "/webix-nodefs-" + Date.now();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + "/numbers.txt", "1\n2\n3\n");
  host.mountNodeDir(dir, "/host");
  const list = host.Module.FS.readdir("/host");
  assert.ok(list.includes("numbers.txt"));
  const bb = fs.readFileSync("containers/busybox-x86_64.elf");
  const r = await race(host.runElf(bb, { argv: ["cat", "/host/numbers.txt"], progname: "/program" }), 12000);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /1\n2\n3/);
});

await t("NOSOCK confirmed: socket(AF_INET) returns ENOSYS", async () => {
  const host = await createBlinkHost({});
  const tar = zlib.gunzipSync(fs.readFileSync("containers/alpine-minirootfs-x86_64.tar.gz"));
  host.mountTarBytes(new Uint8Array(tar));
  const bb = Buffer.from(host.Module.FS.readFile("/bin/busybox"));
  const r = await race(host.runElf(bb, { argv: ["nc", "-z", "127.0.0.1", "80"], progname: "/program" }), 12000);
  assert.match(r.stderr, /Function not implemented/);
});

console.log(`\nresult: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
