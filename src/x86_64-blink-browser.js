import { createBlinkCore } from "./blink-core.js";

export async function createBlinkHostBrowser(options={}){
  const wasmUrl=options.wasmUrl??"/containers/blinkenlib.wasm";
  const glueUrl=options.glueUrl??"/containers/blinkenlib.js";
  const wasmBinary=options.wasmBinary??new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const factory=(await import(glueUrl)).default;
  return createBlinkCore({ wasmBinary, factory, options });
}
