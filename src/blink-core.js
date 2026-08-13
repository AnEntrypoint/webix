import {
  waitForSlot, bootBlinkModule,
  extractTarToFS, makeRegisterAccessor, writeStr as writeStrRaw, writeArgv as writeArgvRaw
} from "./blink-core-helpers.js";
import { createFbAccessors } from "./blink-core-fb.js";
import { createXRunner } from "./blink-core-x.js";
import { mkdirp } from "./apk-format.js";

export async function createBlinkCore({ wasmBinary, factory, options={} }){
  // byte-buffered stdout/stderr: per-char String concat was O(n^2) for large output.
  let outBytes=[], errBytes=[], lastSignal=null, lastExitCode=null;
  const td=new TextDecoder();
  const decode=(arr)=>td.decode(new Uint8Array(arr));
  let exitDeferred=null;
  let lastLoaded=null;
  // True once the synchronous main-thread _blinkenlib_run() path has been used.
  // The 2nd main-thread run wedges in-browser (setupProgram/InitBus re-init
  // aborts), so after the first run we route runElf through a re-entrant worker
  // slot. See runElf's RE-ENTRANCY note.
  let mainThreadRunUsed=false;
  const preloaded=new Map();
  const stdinQueue=options.stdinBytes?[...options.stdinBytes].reverse():[];
  // Boot the wasm module + wire signal/exit callbacks (see blink-core-helpers.js
  // bootBlinkModule): onSettle resolves exitDeferred, onSignal records a fault.
  const { Module } = await bootBlinkModule({
    wasmBinary, factory, options,
    io:{
      stdinQueue,
      pushOut:(c)=>outBytes.push(c),
      pushErr:(c)=>errBytes.push(c),
    },
    onSettle(code){
      lastExitCode=code;
      if(exitDeferred){ const d=exitDeferred; exitDeferred=null; d.resolve(code) }
    },
    onSignal(sig){ lastSignal=sig; },
  });
  const clstruct=Module._blinkenlib_get_clstruct();
  const argcPtr=Module._blinkenlib_get_argc_string();
  const argvPtr=Module._blinkenlib_get_argv_string();
  const prognamePtr=Module._blinkenlib_get_progname_string();
  const regs=makeRegisterAccessor(Module, clstruct);
  const writeStr=(ptr,str,max)=>writeStrRaw(Module,ptr,str,max);
  const writeArgv=(ptr,args,max)=>writeArgvRaw(Module,ptr,args,max);
  // Framebuffer accessors: geometry published by the guest via the synthetic
  // 0x5fb syscall, pixels mapped zero-copy through spy_address(fb_vaddr),
  // page-pointer-cached (see blink-core-fb.js).
  const { fbInfo, fbView } = createFbAccessors(Module);
  // Host -> guest input. Maps display.js's event shape to the C input device
  // (blinkenlib_push_input(type, code, x, y, value)). type: 1=key 2=motion
  // 3=button. Guest drains via syscall 0x5fc. No-op (with a guard) if the
  // running wasm predates the input device, so display.js stays graceful.
  const INPUT_TYPE={ key:1, motion:2, button:3 };
  const hasInputDevice=typeof Module._blinkenlib_push_input==="function";
  function pushInput(evt){
    if(!hasInputDevice || !evt) return false;
    const type=INPUT_TYPE[evt.type]; if(!type) return false;
    const code=(evt.code ?? evt.button ?? 0)|0;
    const x=(evt.x ?? 0)|0, y=(evt.y ?? 0)|0;
    const value=(evt.down ?? evt.value ?? 0)|0;
    Module._blinkenlib_push_input(type, code, x, y, value);
    return true;
  }
  function inputPending(){ return hasInputDevice ? Module._blinkenlib_input_pending() : 0; }
  const xRunner=createXRunner(Module, {
    writeStr, writeArgv, prognamePtr, argcPtr, argvPtr, decode,
    resetOutput(){ outBytes=[]; errBytes=[]; },
    getOutBytes(){ return outBytes; }, getErrBytes(){ return errBytes; },
  });
  return {
    Module, clstruct,
    // Capability flags reflect the portabox max-perf build. `pipe` is the
    // pipe()/pipe2() syscall (implemented), distinct from `pipelines` (shell
    // `a | b`, needs fork() -- absent under emscripten). `threads` reflects
    // whether pthread_create can actually succeed here and now (needs
    // crossOriginIsolated + SharedArrayBuffer), not just that the wasm was
    // compiled -pthread -- a hardcoded `true` would falsely license
    // startXServer/launchXClient into hanging in a non-isolated browser tab.
    capabilities:{ tarMount:true, nodefs:!!Module.FS.filesystems?.NODEFS, sockets:true, threads:typeof SharedArrayBuffer!=="undefined", sharedMemory:typeof SharedArrayBuffer!=="undefined", pipe:true, pipelines:false, fork:false, framebuffer:true, jit:false, vectorISA:"sse2" },
    fbInfo, fbView, pushInput, inputPending,
    mountTarBytes(tarBytes, onError){ extractTarToFS(Module.FS, tarBytes, onError) },
    mountNodeDir(hostDir, guestDir="/host"){
      const FS=Module.FS;
      if(!FS.filesystems?.NODEFS) throw new Error("NODEFS not compiled in");
      try{ FS.mkdir(guestDir) }catch(_){}
      FS.mount(FS.filesystems.NODEFS,{root:hostDir},guestDir);
      return guestDir;
    },
    // Mount an IDBFS-backed dir so its contents survive page reloads (browser only).
    // Call syncPersist() after writes to flush to IndexedDB; loadPersist() once at
    // boot to populate from IndexedDB. Used to persist apk-installed packages.
    async persistDir(guestDir="/persist"){
      const FS=Module.FS;
      if(!FS.filesystems?.IDBFS) throw new Error("IDBFS not compiled in");
      mkdirp(FS, guestDir);
      FS.mount(FS.filesystems.IDBFS,{},guestDir);
      await new Promise((res,rej)=>FS.syncfs(true,(e)=>e?rej(e):res()));
      this._persistDir=guestDir;
      return guestDir;
    },
    syncPersist(){
      const FS=Module.FS;
      return new Promise((res,rej)=>FS.syncfs(false,(e)=>e?rej(e):res()));
    },
    // Cache the bytes that should sit at /program (blink always execs /program)
    // so runElf can skip the per-call multi-MB FS write via the returned handle.
    // `gen` bumps on every re-preload of the same name so runElf's skip-write
    // check (keyed on handle+gen) can't serve stale bytes from a prior generation.
    preloadFile(name, bytes){
      const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
      const handle="pre:"+name;
      const gen=(preloaded.get(handle)?.gen ?? 0)+1;
      preloaded.set(handle, { data, gen });
      return handle;
    },
    isPreloaded(handle){ return preloaded.has(handle); },
    async runElf(bytes,{ argv=[], progname="/program", path }={}){
      if(exitDeferred) throw new Error("blink-core: previous run not yet settled");
      const FS=Module.FS;
      // Resolve the bytes: explicit bytes, or a preloaded handle.
      let data=bytes, gen=null;
      if(!data && path){
        const entry=preloaded.get(path);
        if(!entry) throw new Error("blink-core: unknown preload handle "+path);
        data=entry.data; gen=entry.gen;
      }
      if(!data) throw new Error("blink-core: runElf needs bytes or a preload handle");
      const writeKey=path?path+"#"+gen:null;
      // Skip the FS write if the identical handle+generation is already sitting at /program.
      if(!(writeKey && lastLoaded===writeKey)){
        const u8=data instanceof Uint8Array?data:new Uint8Array(data);
        try{ FS.unlink("/program") }catch(_){}
        const s=FS.open("/program","w+");
        FS.write(s,u8,0,u8.length,0); FS.close(s); FS.chmod("/program",0o755);
        lastLoaded=writeKey;
      }
      writeStr(prognamePtr,progname,1024);
      // NUL-separated argv (patched blinkenlib parses on NUL, buffer is 4096).
      writeArgv(argcPtr, argv.length?argv:[progname], 4096);
      writeStr(argvPtr,"",4096);
      outBytes=[]; errBytes=[]; lastSignal=null; lastExitCode=null;

      // RE-ENTRANCY: the main-thread _blinkenlib_run() path runs setupProgram +
      // InitBus on every call; in-browser the SECOND such call wedges (its
      // TearDown/InitBus re-init aborts), so every render-once app and every
      // sequential runCommand froze after the first exec (witnessed: 2nd
      // /xappdemo timed out, exitDeferred never resolved). The thread-slot path
      // (vm_spawn -> run_thread_slot -> poll thread_done_slot, pumping the proxy
      // queue) is proven re-entrant in-browser (launchXClient reuses it across
      // launches). So once a main-thread run has happened, route
      // every subsequent runElf through a dedicated worker slot. The very first
      // run keeps the fast synchronous main-thread path; node (no pthread build)
      // always uses it (libuv re-enters cleanly there).
      const threaded =
        mainThreadRunUsed &&
        typeof Module._blinkenlib_vm_spawn === "function" &&
        typeof Module._blinkenlib_run_thread_slot === "function" &&
        typeof Module._blinkenlib_thread_done_slot === "function" &&
        typeof Module._blinkenlib_thread_status_slot === "function";

      if(threaded){
        // Dedicated re-entrant slot (2) for foreground runElf, kept clear of the
        // X server (slot 0) and X client (slot 1) so a live X session and a
        // render-once GUI frame can coexist.
        const RUNELF_SLOT = 2;
        const h = Module._blinkenlib_vm_spawn(0);
        Module._blinkenlib_run_thread_slot(h, RUNELF_SLOT);
        // render-once frames settle in ms; poll tight (4ms) with a 120s safety bound.
        const { exitCode } = await waitForSlot(Module, RUNELF_SLOT, { timeoutMs:120000, pollMs:4 });
        lastExitCode=exitCode;
        return { exitCode, stdout:decode(outBytes), stderr:decode(errBytes), signal:lastSignal };
      }

      // First run (or non-pthread build): fast synchronous main-thread path.
      mainThreadRunUsed = true;
      const done=new Promise((resolve,reject)=>{ exitDeferred={resolve,reject} });
      Module._blinkenlib_run();
      const exitCode=await done;
      return { exitCode, stdout:decode(outBytes), stderr:decode(errBytes), signal:lastSignal };
    },
    // PERSISTENT X run model (live windows) + dispose() -- see blink-core-x.js.
    ...xRunner,
    pushStdin(bytes){ for(const b of [...bytes].reverse()) stdinQueue.unshift(b) },
    async runShellScript(busyboxBytes, scriptText, { argv=[], progname="/program" }={}){
      const FS=Module.FS;
      const scriptPath="/tmp/_xos_"+Math.random().toString(36).slice(2,10)+".sh";
      try{ FS.mkdir("/tmp") }catch(_){}
      FS.writeFile(scriptPath, scriptText); FS.chmod(scriptPath, 0o755);
      return this.runElf(busyboxBytes, { argv:["sh", scriptPath, ...argv], progname });
    },
    snapshot(){
      const s=regs.snapshot();
      return { ...s, exitCode:lastExitCode, stdoutTail:decode(outBytes).slice(-4096), stderrTail:decode(errBytes).slice(-4096) };
    },
    restore(snap){ regs.restore(snap) },
    readRegisters(){ return regs.readRegisters() }
  };
}
