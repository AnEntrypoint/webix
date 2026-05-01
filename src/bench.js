import { createRuntime } from "./runtime.js";
import { BlockCacheJIT } from "./jit.js";

export async function benchmark(options = {}) {
  const iterations = options.iterations ?? 250000;
  const code = new Uint8Array([
    0xb9, iterations & 0xff, (iterations >>> 8) & 0xff, (iterations >>> 16) & 0xff, (iterations >>> 24) & 0xff, // mov ecx,N
    0x31, 0xc0,             // xor eax,eax
    0x40,                   // inc eax
    0xe2, 0xfd,             // loop -3
    0x31, 0xdb,             // xor ebx,ebx
    0xb8, 0x01,0,0,0,       // mov eax,1
    0xcd, 0x80              // int 80
  ]);
  const rt = createRuntime({ jit: options.jit ?? new BlockCacheJIT({ hotThreshold: 8 }) });
  rt.loadFlat(code, 0x08048000);
  const start = performanceNow();
  const result = await rt.runAsync({ maxSteps: Math.max(iterations * 4 + 1000, 10000), yieldEvery: 0 });
  const elapsedMs = performanceNow() - start;
  return { iterations, elapsedMs, steps: result.steps, stepsPerSecond: result.steps / (elapsedMs / 1000), jit: rt.jit?.stats ?? null, exitCode: result.exitCode };
}
function performanceNow() {
  if (globalThis.performance?.now) return globalThis.performance.now();
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}
