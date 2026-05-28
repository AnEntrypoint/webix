import { createBlinkHostBrowser } from "./x86_64-blink-browser.js";
import { createApk } from "./alpine-apk.js";

async function gunzipBytes(u8){
  if(typeof DecompressionStream==="undefined") return u8;
  const ds=new DecompressionStream("gzip");
  const stream=new Response(u8).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function installWindowDebug({ wasmUrl="/containers/blinkenlib.wasm", glueUrl="/containers/blinkenlib.js", elfUrl="/containers/hello-x86_64.elf", rootfsUrl=null, persist=false, argv=["hello"], onLog=()=>{} } = {}){
  onLog("loading host");
  const host=await createBlinkHostBrowser({ wasmUrl, glueUrl });
  onLog("host ready, clstruct="+host.clstruct);
  // Optionally mount an alpine minirootfs so apk + dynamic ELFs work in-page.
  // Fetch the boot ELF and (optional) rootfs concurrently rather than serially.
  const elfP=fetch(elfUrl).then(r=>r.arrayBuffer()).then(b=>new Uint8Array(b));
  const rootfsP=rootfsUrl?fetch(rootfsUrl).then(r=>r.arrayBuffer()).then(b=>new Uint8Array(b)):null;
  let apk=null;
  if(rootfsP){
    onLog("mounting rootfs");
    host.mountTarBytes(await gunzipBytes(await rootfsP));
    // Optionally persist apk-installed packages across reloads via IDBFS.
    if(persist && host.Module.FS.filesystems?.IDBFS){
      try{ await host.persistDir("/persist"); onLog("persist mounted"); }
      catch(e){ onLog("persist unavailable: "+e.message); }
    }
    apk=createApk(host);
    onLog("rootfs mounted, apk ready");
  }
  const elf=await elfP;
  onLog("elf bytes="+elf.length);
  const r=await host.runElf(elf,{ argv });
  onLog("exit="+r.exitCode+" stdout="+JSON.stringify(r.stdout));
  const regs=host.readRegisters();
  const hex=Object.fromEntries(Object.entries(regs).map(([k,v])=>[k, typeof v==="bigint"?v.toString(16):v.toString(16)]));
  if(!window.__debug) Object.defineProperty(window,"__debug",{ value:{}, writable:true, configurable:true });
  window.__debug.x86_64={
    host, ready:true, apk,
    exitCode:r.exitCode, stdout:r.stdout, stderr:r.stderr, signal:r.signal,
    registers:hex,
    runElf:(bytes,opts)=>host.runElf(bytes,opts),
    pushStdin:(bytes)=>host.pushStdin(bytes),
    snapshot:()=>host.snapshot()
  };
  onLog("registers post-exit: rax="+hex.rax+" rdi="+hex.rdi);
  return window.__debug.x86_64;
}
