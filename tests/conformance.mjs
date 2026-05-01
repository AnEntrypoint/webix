import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRuntime, parseELF32, PagedMemory, PERM, MemoryFault, createTar, VFS, loadRootfsTar } from "../src/index.js";

const hello = readFileSync(new URL("../samples/hello.elf", import.meta.url));
const elf = parseELF32(hello);
assert.equal(elf.header.machine, 3);
assert.ok(elf.ph.some(p => p.type === 1));

const mem = new PagedMemory();
mem.map(0x1000, 4096, PERM.RW, "[test]");
mem.write32(0x1000, 0x12345678);
assert.equal(mem.read32(0x1000), 0x12345678);
mem.protect(0x1000, 4096, PERM.R);
assert.throws(() => mem.write8(0x1000, 1), MemoryFault);

const root = new VFS();
await loadRootfsTar(root, createTar({ "bin/hello": hello, "etc/message": "ok\n" }));
const rt = createRuntime({ vfs: root });
rt.loadExecutableFromVFS("/bin/hello", { argv: ["/bin/hello"] });
const result = await rt.runAsync({ maxSteps: 100000 });
assert.equal(result.exitCode, 0);
assert.match(result.output, /Hello from clean-room/);

console.log("conformance tests passed");
