import assert from "node:assert/strict";
import { VFS, PagedMemory, FutexTable, BlockCacheJIT, createRuntime } from "../src/index.js";

// VFS binary snapshot roundtrip, including symlinks and metadata mutations.
{
  const v = new VFS();
  v.writeFile("/tmp/a.txt", "hello", 0o600);
  v.symlink("/tmp/a.txt", "/tmp/a-link");
  v.chmod("/tmp/a.txt", 0o644);
  const snap = v.snapshot({ binary: true });
  const r = VFS.fromSnapshot(snap);
  assert.equal(new TextDecoder().decode(r.readFile("/tmp/a.txt")), "hello");
  assert.equal(r.readlink("/tmp/a-link"), "/tmp/a.txt");
  assert.equal(r.stat("/tmp/a.txt").mode & 0o777, 0o644);
}

// Copy-on-write memory keeps forked child writes from mutating parent pages.
{
  const parent = new PagedMemory();
  parent.map(0x1000, 4096);
  parent.write32(0x1000, 0x12345678);
  const child = parent.clone({ copyOnWrite: true });
  child.write32(0x1000, 0xaabbccdd);
  assert.equal(parent.read32(0x1000), 0x12345678);
  assert.equal(child.read32(0x1000), 0xaabbccdd);
}

// Futex wait/wake is a real asynchronous wait queue, not a polling placeholder.
{
  const futex = new FutexTable();
  let woke = false;
  const p = futex.wait(0x2000, 1, 1000).then(v => { woke = v === 0; });
  assert.equal(futex.wake(0x2000, 1), 1);
  await p;
  assert.equal(woke, true);
}

// JIT cache compiles and invalidates hot blocks without changing observable output.
{
  const rt = createRuntime({ jit: new BlockCacheJIT({ hotThreshold: 1 }) });
  rt.loadELF(await import("node:fs/promises").then(fs => fs.readFile("samples/hello.elf")));
  const res = rt.run({ maxSteps: 10000 });
  assert.equal(res.exitCode, 0);
  assert.match(res.output, /Hello/);
  assert.ok(rt.jit.stats.compiled >= 1);
}

console.log("parity support tests passed");
