import { performance } from "node:perf_hooks";
import { runFlat, createRuntime, createTar, mountTar, VFS } from "../src/index.js";

export async function benchmarkRuntime() {
  const code = new Uint8Array([
    0xb9,0x00,0x10,0x00,0x00,       // mov ecx,4096
    0x49,                           // dec ecx
    0x75,0xfd,                      // jne -3
    0x31,0xdb,                      // xor ebx,ebx
    0xb8,0x01,0x00,0x00,0x00,       // mov eax,1
    0xcd,0x80                       // int 80
  ]);
  const t0 = performance.now();
  const r = await runFlat(code, 0x08048000, { maxSteps: 100000 });
  const t1 = performance.now();
  const vfs = new VFS();
  const tar = createTar({ "/a.txt": "a", "/b.txt": "b" });
  const fs0 = performance.now();
  mountTar(vfs, tar);
  const fs1 = performance.now();
  return {
    instructionLoop: { exitCode: r.exitCode, steps: r.steps, ms: +(t1 - t0).toFixed(3), stepsPerSecond: Math.round(r.steps / ((t1 - t0) / 1000 || 1)) },
    tarMount: { entries: vfs.list("/").length, ms: +(fs1 - fs0).toFixed(3) },
  };
}
