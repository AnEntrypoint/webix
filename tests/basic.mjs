import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runELF, runFlat } from "../src/index.js";

if (!existsSync(new URL("../samples/hello.elf", import.meta.url))) {
  const r = spawnSync(process.execPath, [new URL("../tools/make-samples.mjs", import.meta.url).pathname], { stdio: "inherit" });
  assert.equal(r.status, 0);
}

{
  const bytes = readFileSync(new URL("../samples/hello.elf", import.meta.url));
  const r = await runELF(bytes, { maxSteps: 100000 });
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /Hello from clean-room/);
}

{
  const bytes = readFileSync(new URL("../samples/read-hosts.elf", import.meta.url));
  const r = await runELF(bytes, { maxSteps: 100000 });
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /127\.0\.0\.1 localhost/);
}

{
  // Flat program: arithmetic, stack, conditional jumps, syscall exit(0).
  const code = new Uint8Array([
    0xb8, 0x03,0,0,0,       // mov eax,3
    0x83, 0xc0, 0x04,       // add eax,4
    0x83, 0xf8, 0x07,       // cmp eax,7
    0x75, 0x0c,             // jne fail
    0x50,                   // push eax
    0x5b,                   // pop ebx
    0x83, 0xfb, 0x07,       // cmp ebx,7
    0x75, 0x04,             // jne fail
    0x31, 0xdb,             // xor ebx,ebx
    0xeb, 0x05,             // jmp exit
    0xbb, 0x02,0,0,0,       // fail: mov ebx,2
    0xb8, 0x01,0,0,0,       // exit: mov eax,1
    0xcd, 0x80              // int 80
  ]);
  const r = await runFlat(code, 0x08048000, { maxSteps: 10000 });
  assert.equal(r.exitCode, 0);
}


{
  // Fork/wait smoke: child exits 7; parent waitpid observes 0x0700 and exits 0.
  const code = new Uint8Array([
    0xb8,0x02,0,0,0,0xcd,0x80,0x83,0xf8,0x00,0x74,0x30,
    0x89,0xc3,0x83,0xec,0x04,0x89,0xe1,0x31,0xd2,0xb8,0x07,0,0,0,0xcd,0x80,
    0x8b,0x1c,0x24,0x81,0xfb,0x00,0x07,0x00,0x00,0x75,0x0c,0x31,0xdb,0xb8,0x01,0,0,0,0xcd,0x80,
    0xbb,0x01,0,0,0,0xb8,0x01,0,0,0,0xcd,0x80,
    0xbb,0x07,0,0,0,0xb8,0x01,0,0,0,0xcd,0x80
  ]);
  const { createRuntime } = await import("../src/index.js");
  const rt = createRuntime();
  rt.loadFlat(code, 0x08048000);
  const r = await rt.runAsync({ maxSteps: 10000 });
  assert.equal(r.exitCode, 0);
}

console.log("all tests passed");

{
  const { VFS, serializeVfsBinary, restoreVfsBinary, ProcessManager } = await import("../src/index.js");
  const vfs = new VFS();
  vfs.mkdir("/work", 0o755);
  vfs.writeFile("/work/file.txt", "snapshot-ok\n");
  vfs.symlink("file.txt", "/work/link.txt");
  const snapshot = serializeVfsBinary(vfs);
  const restored = restoreVfsBinary(snapshot);
  assert.equal(new TextDecoder().decode(restored.readFile("/work/file.txt")), "snapshot-ok\n");
  assert.equal(restored.readlink("/work/link.txt"), "file.txt");
  const pm = new ProcessManager();
  assert.deepEqual(pm.list(), []);
}
