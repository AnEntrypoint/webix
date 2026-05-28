const BLINK_PREEMPT=40, BLINK_FAKE_TTY=42, SIGTRAP=5;

const REGS=["rip","rsp","rbp","rsi","rdi","r8","r9","r10","r11","r12","r13","r14","r15","rax","rbx","rcx","rdx"];

function mkdirp(FS,p){
  let cur="";
  for(const seg of p.split("/").filter(Boolean)){
    cur+="/"+seg;
    try{ FS.mkdir(cur,0o755) }catch(_){}
  }
}

function extractTarToFS(FS, tarBytes, onError){
  const u8 = tarBytes instanceof Uint8Array ? tarBytes : new Uint8Array(tarBytes);
  const td=new TextDecoder();
  let p=0;
  while(p+512<=u8.length){
    const name=td.decode(u8.subarray(p,p+100)).replace(/\0.*/,"");
    if(!name){ p+=512; continue }
    const sizeStr=td.decode(u8.subarray(p+124,p+136)).replace(/[\0\s]/g,"");
    const size=parseInt(sizeStr||"0",8)||0;
    const tf=String.fromCharCode(u8[p+156]||0x30);
    const linkname=td.decode(u8.subarray(p+157,p+257)).replace(/\0.*/,"");
    const full="/"+name.replace(/^\.\//,"");
    try{
      if(tf==="5") mkdirp(FS,full);
      else if(tf==="2"){ mkdirp(FS,full.replace(/\/[^/]*$/,"")); try{FS.unlink(full)}catch(_){}; FS.symlink(linkname,full) }
      else if(tf==="0"||tf===""||tf===" "){
        mkdirp(FS,full.replace(/\/[^/]*$/,""));
        const data=u8.subarray(p+512,p+512+size);
        try{FS.unlink(full)}catch(_){}
        const s=FS.open(full,"w+");
        if(size) FS.write(s,data,0,size,0);
        FS.close(s); FS.chmod(full,0o755);
      }
    }catch(e){ (onError||((m,err)=>console.warn("tar:",m,err.message)))(full,e) }
    p+=512+Math.ceil(size/512)*512;
  }
}

function makeRegisterAccessor(Module, clstruct){
  const dv=()=>new DataView(Module.wasmExports.memory.buffer);
  const off=(i)=>dv().getUint32(clstruct+i*4,true);
  return {
    snapshot(){
      const memBuf=Module.wasmExports.memory.buffer;
      const memCopy=new Uint8Array(memBuf.byteLength);
      memCopy.set(new Uint8Array(memBuf));
      const v=dv();
      const regs={ flags:v.getUint32(off(7),true) };
      REGS.forEach((n,i)=>{ regs[n]=v.getBigUint64(off(9+i),true) });
      return { memory:memCopy, registers:regs };
    },
    restore(snap){
      const memBuf=Module.wasmExports.memory.buffer;
      if(snap.memory.byteLength>memBuf.byteLength) throw new Error("snapshot memory larger than current");
      new Uint8Array(memBuf).set(snap.memory);
      const v=dv();
      REGS.forEach((n,i)=>{ v.setBigUint64(off(9+i),snap.registers[n],true) });
      v.setUint32(off(7),snap.registers.flags,true);
    },
    readRegisters(){
      const v=dv();
      const r={ flags:v.getUint32(off(7),true) };
      REGS.forEach((n,i)=>{ r[n]=v.getBigUint64(off(9+i),true) });
      return r;
    }
  };
}

export async function createBlinkCore({ wasmBinary, factory, options={} }){
  // byte-buffered stdout/stderr: per-char String concat was O(n^2) for large output.
  let outBytes=[], errBytes=[], lastSignal=null, lastExitCode=null;
  const td=new TextDecoder();
  const decode=(arr)=>td.decode(new Uint8Array(arr));
  let exitDeferred=null;
  let lastLoaded=null;
  const preloaded=new Map();
  const stdinQueue=options.stdinBytes?[...options.stdinBytes].reverse():[];
  function settleExit(code){
    lastExitCode=code;
    if(exitDeferred){ const d=exitDeferred; exitDeferred=null; d.resolve(code) }
  }
  const factoryArgs={
    noInitialRun:true,
    preRun:(M)=>{
      M.FS.init(
        ()=>stdinQueue.length?stdinQueue.pop():null,
        (c)=>{ if(c!==null){ outBytes.push(c); options.onStdout?.(c) } },
        (c)=>{ if(c!==null){ errBytes.push(c); options.onStderr?.(c) } }
      );
    }
  };
  // Either supply raw bytes (Node/tests) or an instantiateWasm streaming hook (browser).
  if(options.instantiateWasm) factoryArgs.instantiateWasm=options.instantiateWasm;
  else factoryArgs.wasmBinary=wasmBinary;
  const Module=await factory(factoryArgs);
  const signalCb=Module.addFunction((sig,code)=>{
    if(sig!==SIGTRAP){ lastSignal={sig,code}; settleExit(128+sig); return }
    if(code===BLINK_PREEMPT) Module._blinkenlib_preempt_resume();
    else if(code===BLINK_FAKE_TTY){ if(options.onTtyPause) options.onTtyPause(); else Module._blinkenlib_faketty_resume() }
  },"vii");
  const exitCb=Module.addFunction((code)=>{ settleExit(code) },"vi");
  Module.callMain([signalCb.toString(), exitCb.toString()]);
  const clstruct=Module._blinkenlib_get_clstruct();
  const argcPtr=Module._blinkenlib_get_argc_string();
  const argvPtr=Module._blinkenlib_get_argv_string();
  const prognamePtr=Module._blinkenlib_get_progname_string();
  const regs=makeRegisterAccessor(Module, clstruct);
  function writeStr(ptr,str,max){
    const view=new DataView(Module.wasmExports.memory.buffer);
    const n=Math.min(str.length,max-1);
    for(let i=0;i<n;i++) view.setUint8(ptr+i,str.charCodeAt(i));
    view.setUint8(ptr+n,0);
  }
  return {
    Module, clstruct,
    capabilities:{ tarMount:true, nodefs:!!Module.FS.filesystems?.NODEFS, nosock:true, vectorISA:"sse2" },
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
    // Cache the bytes that should sit at /program (blink always execs /program).
    // Reusing the same handle across runElf skips the per-call multi-MB FS write
    // (busybox is ~1MB). Returns the opaque handle to pass back as runElf opts.path.
    preloadFile(name, bytes){
      const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
      const handle="pre:"+name;
      preloaded.set(handle, data);
      return handle;
    },
    isPreloaded(handle){ return preloaded.has(handle); },
    async runElf(bytes,{ argv=[], progname="/program", path }={}){
      if(exitDeferred) throw new Error("blink-core: previous run not yet settled");
      const FS=Module.FS;
      // Resolve the bytes: explicit bytes, or a preloaded handle.
      let data=bytes;
      if(!data && path){
        data=preloaded.get(path);
        if(!data) throw new Error("blink-core: unknown preload handle "+path);
      }
      if(!data) throw new Error("blink-core: runElf needs bytes or a preload handle");
      const writeKey=path||null;
      // Skip the FS write if the identical handle is already sitting at /program.
      if(!(writeKey && lastLoaded===writeKey)){
        const u8=data instanceof Uint8Array?data:new Uint8Array(data);
        try{ FS.unlink("/program") }catch(_){}
        const s=FS.open("/program","w+");
        FS.write(s,u8,0,u8.length,0); FS.close(s); FS.chmod("/program",0o755);
        lastLoaded=writeKey;
      }
      writeStr(prognamePtr,progname,200);
      writeStr(argcPtr, argv.length?argv.join(" "):progname, 200);
      writeStr(argvPtr,"",200);
      outBytes=[]; errBytes=[]; lastSignal=null; lastExitCode=null;
      const done=new Promise((resolve,reject)=>{ exitDeferred={resolve,reject} });
      Module._blinkenlib_run();
      const exitCode=await done;
      return { exitCode, stdout:decode(outBytes), stderr:decode(errBytes), signal:lastSignal };
    },
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
