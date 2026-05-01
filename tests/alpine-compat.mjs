import assert from "node:assert/strict";
import { CPU, PagedMemory, PERM, VFS, LinuxSyscalls, seedAlpineRuntimeFiles, buildAlpineRuntimeEnv, REG } from "../src/index.js";

// /proc should expose numeric process directories and stat/status files so BusyBox top can enumerate tasks.
{
  const mem = new PagedMemory();
  const vfs = new VFS();
  seedAlpineRuntimeFiles(vfs);
  const sys = new LinuxSyscalls(mem, { vfs, pid: 123, ppid: 1, uid: 0, gid: 0 });
  sys._refreshProcFiles();
  const entries = vfs.list("/proc");
  assert.ok(entries.includes("123"), `missing /proc/123 in ${entries.join(",")}`);
  assert.match(new TextDecoder().decode(vfs.readFile("/proc/123/stat")), /^123 \(sh\) R /);
  assert.match(new TextDecoder().decode(vfs.readFile("/proc/stat")), /procs_running/);
  assert.match(new TextDecoder().decode(vfs.readFile("/proc/meminfo")), /MemTotal/);
}

// apk exec environment should preload real guest zlib/openssl libraries when present.
{
  const vfs = new VFS();
  vfs.mkdirp("/lib");
  vfs.writeFile("/lib/libz.so.1", new Uint8Array([1]));
  vfs.writeFile("/lib/libcrypto.so.3", new Uint8Array([1]));
  vfs.writeFile("/lib/libssl.so.3", new Uint8Array([1]));
  const env = buildAlpineRuntimeEnv(vfs, {}, "/sbin/apk");
  assert.equal(env.LD_LIBRARY_PATH, "/lib:/usr/lib");
  assert.match(env.LD_PRELOAD, /libz\.so\.1/);
  assert.match(env.LD_PRELOAD, /libcrypto\.so\.3/);
  assert.match(env.LD_PRELOAD, /libssl\.so\.3/);
}

// x87 DC /2 is FCOM m64real. ping/musl math paths hit this encoding.
{
  const mem = new PagedMemory();
  mem.map(0x1000, 0x1000, PERM.RWX, "code");
  mem.map(0x2000, 0x1000, PERM.RW, "data");
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, 2.0, true);
  mem.writeBytes(0x2000, new Uint8Array(dv.buffer));
  mem.writeBytes(0x1000, new Uint8Array([
    0xdd,0x05,0x00,0x20,0x00,0x00, // fld qword [0x2000]
    0xdc,0x15,0x00,0x20,0x00,0x00, // fcom qword [0x2000]
    0xdf,0xe0,                       // fnstsw ax
    0xf4
  ]));
  const cpu = new CPU(mem, null, { eip: 0x1000 });
  for (let i = 0; i < 4; i++) { try { cpu.step(); } catch (e) { if (!/HLT/.test(e.message)) throw e; } }
  assert.ok((cpu.regs[REG.EAX] & (1 << 14)) !== 0, "FCOM equal should set C3 in status word");
}

console.log("alpine compatibility tests passed");
