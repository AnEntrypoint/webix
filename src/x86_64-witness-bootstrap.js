import { createBlinkHostBrowser } from "./x86_64-blink-browser.js";

export async function installWindowDebug({ wasmUrl="/containers/blinkenlib.wasm", glueUrl="/containers/blinkenlib.js", elfUrl="/containers/hello-x86_64.elf", argv=["hello"], onLog=()=>{} } = {}){
  onLog("loading host");
  const host=await createBlinkHostBrowser({ wasmUrl, glueUrl });
  onLog("host ready, clstruct="+host.clstruct);
  const elf=new Uint8Array(await (await fetch(elfUrl)).arrayBuffer());
  onLog("elf bytes="+elf.length);
  const r=await host.runElf(elf,{ argv });
  onLog("exit="+r.exitCode+" stdout="+JSON.stringify(r.stdout));
  const regs=host.readRegisters();
  const hex=Object.fromEntries(Object.entries(regs).map(([k,v])=>[k, typeof v==="bigint"?v.toString(16):v.toString(16)]));
  window.__debug=window.__debug??{};
  window.__debug.x86_64={
    host, ready:true,
    exitCode:r.exitCode, stdout:r.stdout, stderr:r.stderr, signal:r.signal,
    registers:hex,
    runElf:(bytes,opts)=>host.runElf(bytes,opts),
    pushStdin:(bytes)=>host.pushStdin(bytes),
    snapshot:()=>host.snapshot()
  };
  onLog("registers post-exit: rax="+hex.rax+" rdi="+hex.rdi);
  return window.__debug.x86_64;
}
