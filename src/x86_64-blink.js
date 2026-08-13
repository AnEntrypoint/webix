import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBlinkCore } from "./blink-core.js";

function ensureWebEnv(){
  if(typeof window==="undefined"){
    globalThis.window=globalThis;
    globalThis.document={ currentScript:{src:"file:///"}, createElement:()=>({}), getElementsByTagName:()=>[] };
    if(typeof importScripts==="undefined") globalThis.importScripts=()=>{ throw new Error("importScripts unavailable") };
  }
  // The threaded (-pthread) emscripten glue references the worker-scope global
  // `self` at module-eval time; on Node's main thread that is undefined. Shim
  // it so the threaded blinkenlib loads under plain `node` (test.js, CI) without
  // each caller needing its own shim. The pthread pool spawns real
  // worker_threads which set their own scope.
  if(typeof globalThis.self==="undefined") globalThis.self=globalThis;
}

// Same 380KB wasm bytes are identical across every createBlinkHost call within
// a process (test.js alone instantiates ~18 hosts) -- cache by resolved path
// instead of re-reading from disk on every call.
const wasmBinaryCache=new Map();

export async function createBlinkHost(options={}){
  ensureWebEnv();
  const wasmPath=options.wasmPath??"containers/blinkenlib.wasm";
  const gluePath=options.gluePath??"containers/blinkenlib.js";
  let wasmBinary=options.wasmBinary;
  if(!wasmBinary){
    const resolved=path.resolve(wasmPath);
    wasmBinary=wasmBinaryCache.get(resolved);
    if(!wasmBinary){
      wasmBinary=fs.readFileSync(resolved);
      wasmBinaryCache.set(resolved, wasmBinary);
    }
  }
  const factory=(await import(pathToFileURL(path.resolve(gluePath)).href)).default;
  return createBlinkCore({ wasmBinary, factory, options });
}
