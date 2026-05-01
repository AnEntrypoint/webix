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
}

export async function createBlinkHost(options={}){
  ensureWebEnv();
  const wasmPath=options.wasmPath??"containers/blinkenlib.wasm";
  const gluePath=options.gluePath??"containers/blinkenlib.js";
  const wasmBinary=options.wasmBinary??fs.readFileSync(wasmPath);
  const factory=(await import(pathToFileURL(path.resolve(gluePath)).href)).default;
  return createBlinkCore({ wasmBinary, factory, options });
}
