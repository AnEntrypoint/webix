import { createBlinkHostBrowser } from "./x86_64-blink-browser.js";
import { createApk } from "./alpine-apk.js";

// Gunzip a fetch Response's body via DecompressionStream, piping directly
// from the network stream instead of buffering the whole compressed payload
// into an ArrayBuffer first. Falls back to a full in-memory gunzip on
// browsers without DecompressionStream, or if res.body streaming is absent.
async function gunzipResponse(res){
  if(typeof DecompressionStream!=="undefined" && res.body){
    const stream=res.body.pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const u8=new Uint8Array(await res.arrayBuffer());
  if(typeof DecompressionStream==="undefined") return u8;
  const stream=new Response(u8).body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function installWindowDebug({ wasmUrl="/containers/blinkenlib.wasm", glueUrl="/containers/blinkenlib.js", elfUrl="/containers/hello-x86_64.elf", rootfsUrl=null, persist=false, lazyRootfs=false, argv=["hello"], onLog=()=>{} } = {}){
  onLog("loading host");
  const host=await createBlinkHostBrowser({ wasmUrl, glueUrl });
  onLog("host ready, clstruct="+host.clstruct);
  // Optionally mount an alpine minirootfs so apk + dynamic ELFs work in-page.
  // Fetch the boot ELF and (optional) rootfs concurrently rather than serially.
  const elfP=fetch(elfUrl).then(r=>r.arrayBuffer()).then(b=>new Uint8Array(b));
  // Stream-gunzip the rootfs as it downloads instead of buffering the whole
  // compressed .tar.gz into an ArrayBuffer before starting decompression.
  const rootfsP=rootfsUrl?fetch(rootfsUrl).then(gunzipResponse):null;

  // Mount the rootfs + build apk. When lazyRootfs is false (default) this runs
  // before the boot ELF, same as before. When lazyRootfs is true, the caller
  // runs this AFTER installing window.__debug.x86_64 (ready:true), so the boot
  // ELF's exit doesn't wait on the ~3.5MB rootfs download+mount; apk/busybox
  // callers await window.__debug.x86_64.apkReady instead.
  async function mountRootfs(){
    if(!rootfsP) return null;
    onLog("mounting rootfs");
    host.mountTarBytes(await rootfsP);
    // Optionally persist apk-installed packages across reloads via IDBFS.
    if(persist && host.Module.FS.filesystems?.IDBFS){
      try{ await host.persistDir("/persist"); onLog("persist mounted"); }
      catch(e){ onLog("persist unavailable: "+e.message); }
    }
    const apk=createApk(host);
    onLog("rootfs mounted, apk ready");
    return apk;
  }

  const apk = lazyRootfs ? null : await mountRootfs();

  const elf=await elfP;
  onLog("elf bytes="+elf.length);
  const r=await host.runElf(elf,{ argv });
  onLog("exit="+r.exitCode+" stdout="+JSON.stringify(r.stdout));
  const regs=host.readRegisters();
  const hex=Object.fromEntries(Object.entries(regs).map(([k,v])=>[k, typeof v==="bigint"?v.toString(16):v.toString(16)]));
  if(!window.__debug) Object.defineProperty(window,"__debug",{ value:{}, writable:true, configurable:true });
  const x86_64={
    host, ready:true, apk,
    // apkReady resolves once apk is mounted+built, so callers gated on apk
    // (e.g. the CLI's `apk` subcommand) can `await window.__debug.x86_64.apkReady`
    // instead of polling `.apk`. Already-resolved (non-lazy) or immediately
    // resolved to null (no rootfsUrl) in the non-lazy path.
    apkReady: lazyRootfs ? mountRootfs().then(a=>{ x86_64.apk=a; return a; }) : Promise.resolve(apk),
    exitCode:r.exitCode, stdout:r.stdout, stderr:r.stderr, signal:r.signal,
    registers:hex,
    runElf:(bytes,opts)=>host.runElf(bytes,opts),
    pushStdin:(bytes)=>host.pushStdin(bytes),
    snapshot:()=>host.snapshot()
  };
  window.__debug.x86_64=x86_64;
  onLog("registers post-exit: rax="+hex.rax+" rdi="+hex.rdi);
  return window.__debug.x86_64;
}
