import { createBlinkCore } from "./blink-core.js";

const WASM_CACHE="webix-wasm-v1";

// Fetch the wasm bytes with a Cache-API layer so repeat visits skip the network.
// Returns a Response (so the caller can stream-compile) plus the raw bytes fallback.
//
// NOTE: caching the COMPILED WebAssembly.Module (not just these bytes) in
// IndexedDB was investigated and reverted -- Chromium throws DataCloneError
// ("A WebAssembly.Module can not be serialized for storage") on every put();
// browsers briefly supported structured-cloning a compiled Module into IDB
// and later removed it platform-wide for security reasons. No browser today
// supports it, so recompiling from cached bytes via instantiateStreaming
// (below) is the fastest repeat-visit path actually available.
async function cachedWasmResponse(url){
  if(typeof caches==="undefined") return fetch(url);
  try{
    const cache=await caches.open(WASM_CACHE);
    let res=await cache.match(url);
    if(!res){
      res=await fetch(url);
      if(res.ok) await cache.put(url, res.clone());
    }
    return res;
  }catch(_){ return fetch(url); }
}

// emscripten instantiateWasm hook: compile while downloading via instantiateStreaming
// when the server sends application/wasm; otherwise fall back to arrayBuffer compile.
function makeInstantiateWasm(wasmResponsePromise){
  return (imports, success)=>{
    (async()=>{
      const res=await wasmResponsePromise;
      try{
        if(WebAssembly.instantiateStreaming && res.headers?.get("content-type")?.includes("application/wasm")){
          const { instance, module }=await WebAssembly.instantiateStreaming(res.clone(), imports);
          success(instance, module);
          return;
        }
      }catch(_){ /* fall through to arrayBuffer path */ }
      const buf=await res.clone().arrayBuffer();
      const { instance, module }=await WebAssembly.instantiate(buf, imports);
      success(instance, module);
    })();
    return {};
  };
}

export async function createBlinkHostBrowser(options={}){
  const wasmUrl=options.wasmUrl??"/containers/blinkenlib.wasm";
  const glueUrl=options.glueUrl??"/containers/blinkenlib.js";
  // Kick off the wasm fetch/cache-lookup BEFORE awaiting the glue import so
  // the (potentially large, threaded) wasm download+compile overlaps the glue
  // module's own network fetch + JS evaluation instead of waiting for it first.
  const wasmResponsePromise=options.wasmBinary?null:cachedWasmResponse(wasmUrl);
  // The glue is a runtime asset served at glueUrl, NOT a build-time module.
  // The magic comments tell bundlers (webpack/turbopack/vite) to leave this as
  // a native runtime import() instead of trying to resolve '/containers/...' at
  // build time (which fails with "server relative imports not implemented").
  const factory=(await import(/* webpackIgnore: true */ /* @vite-ignore */ glueUrl)).default;
  // If raw bytes were supplied (tests), keep the legacy path; else stream-compile.
  if(options.wasmBinary){
    return createBlinkCore({ wasmBinary:options.wasmBinary, factory, options });
  }
  return createBlinkCore({
    factory,
    options:{ ...options, instantiateWasm:makeInstantiateWasm(wasmResponsePromise) }
  });
}
