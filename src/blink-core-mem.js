// blink-core-mem.js — WASM linear-memory buffer accessor, shared by
// blink-core-boot.js, blink-core-io.js, and blink-core-fb.js.

// Return the live WASM linear-memory ArrayBuffer. Under -pthread the memory is
// IMPORTED + shared (--import-memory --shared-memory), so it is NOT an export:
// wasmExports.memory is undefined and only Module.wasmMemory / the HEAP views
// point at it. HEAPU8.buffer is the most portable + always-current handle
// (emscripten re-points the HEAP* views on every growth), so prefer it; fall
// back to wasmMemory then the (single-thread-only) wasmExports.memory.
export function memBuffer(Module){
  const b = Module.HEAPU8?.buffer || Module.wasmMemory?.buffer || Module.wasmExports?.memory?.buffer;
  if(!b) throw new Error("blink-core: cannot locate WASM memory buffer");
  return b;
}
