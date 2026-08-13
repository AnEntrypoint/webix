// blink-core-x.js — persistent X-server run model (startXServer/launchXClient)
// for a blink-core Module instance. Split out of blink-core.js to keep it
// under the repo's <200-line-per-file cap.

import { writeProg, makePumpProxy, waitForSlot } from "./blink-core-helpers.js";

// PERSISTENT X run model (live windows). Keeps the Xvfb server VM alive on
// slot 0 indefinitely and lets the host blit fbView() on its own rAF loop
// while clients come and go on slot 1. A single always-on proxy pump
// (setInterval) services the worker pthreads' proxied syscalls so the server
// keeps dispatching and the framebuffer keeps updating between launches.
// startXServer() spawns the server + pump and returns immediately;
// launchXClient() spawns a client and resolves when THAT client exits (the
// server keeps serving); stopX() clears the pump (VMs are reaped on the next
// sandbox teardown). The patched Xvfb publishes its framebuffer via 0x5fb,
// so fbInfo()/fbView() reflect the live X screen.
//
// `io` bundles the runElf-shared argv/output plumbing this needs: writeStr,
// writeArgv, prognamePtr, argcPtr, argvPtr, decode, and get/set for the
// shared outBytes/errBytes arrays (both this and runElf reset them per-run).
export function createXRunner(Module, io){
  let xpump=null, xserverH=null;
  return {
    async startXServer(serverBytes, { argv=[], progname="/xserver" }={}){
      if(xpump) throw new Error("blink-core: X server already running");
      if(typeof Module._blinkenlib_run_thread_slot!=="function")
        throw new Error("blink-core: blinkenlib_run_thread_slot missing (rebuild blink)");
      // Real guard (not just a documented-but-unchecked capability flag): the
      // thread-slot path needs pthread_create, which needs SharedArrayBuffer,
      // which needs crossOriginIsolated (COOP/COEP) in a browser tab. Failing
      // fast here with a named cause beats a silent hang inside vm_spawn.
      if(typeof SharedArrayBuffer==="undefined")
        throw new Error("blink-core: startXServer needs SharedArrayBuffer (serve with COOP/COEP for crossOriginIsolated, or use coi-serviceworker.js)");
      const FS=Module.FS;
      writeProg(FS,progname,serverBytes);
      io.resetOutput();
      io.writeStr(io.prognamePtr,progname,1024);
      io.writeArgv(io.argcPtr,(argv.length?["Xvfb",...argv]:["Xvfb"]),4096);
      io.writeStr(io.argvPtr,"",4096);
      xserverH=Module._blinkenlib_vm_spawn(0);
      Module._blinkenlib_run_thread_slot(xserverH,0);
      // Always-on proxy pump: the worker pthreads' blocking syscalls are proxied
      // to the main thread; without continuous servicing the server stalls and
      // the framebuffer never advances. 5ms keeps the X dispatch loop fed while
      // leaving the main thread room for rAF blits/input.
      xpump=setInterval(makePumpProxy(Module),5);
      return xserverH;
    },
    // Launch a client against the running X server. Resolves with the client's
    // exit code when it exits; the server keeps serving. Serialized on slot 1
    // (one client at a time on this slot; sequential launches reuse it).
    async launchXClient(clientBytes, { argv=[], progname="/xclient", timeoutMs=60000 }={}){
      if(!xpump) throw new Error("blink-core: X server not running (call startXServer)");
      const FS=Module.FS;
      writeProg(FS,progname,clientBytes);
      io.writeStr(io.prognamePtr,progname,1024);
      io.writeArgv(io.argcPtr,[progname.split("/").pop(),...argv],4096);
      io.writeStr(io.argvPtr,"",4096);
      const clientH=Module._blinkenlib_vm_spawn(0);
      Module._blinkenlib_run_thread_slot(clientH,1);
      // Poll on top of the always-on server interval pump: relying on
      // setInterval alone left the slot-1 client wedged (its proxied syscalls
      // weren't serviced promptly enough, so thread_done never flipped) --
      // waitForSlot's own synchronous pump on every tick fixes that.
      const { timedOut, exitCode } = await waitForSlot(Module, 1, { timeoutMs, pollMs:20 });
      return { timedOut, exitCode, stdout:io.decode(io.getOutBytes()), stderr:io.decode(io.getErrBytes()) };
    },
    stopX(){ if(xpump){ clearInterval(xpump); xpump=null; } xserverH=null; },
    xRunning(){ return !!xpump; },
    // Tears down what a JS-side host can reach: stops the pump above (the real
    // leak this guards against -- a caller that starts an X server and never
    // calls dispose()/stopX() leaks the interval and its underlying VM/worker
    // forever) and reaps the pthread pool via Module.PThread.terminateAllThreads
    // (exported since build-blink.yml added "PThread" to
    // EXPORTED_RUNTIME_METHODS). Optional chaining stays as a defensive no-op
    // against an older, locally-built wasm that predates that export.
    dispose(){
      if(xpump){ clearInterval(xpump); xpump=null; } xserverH=null;
      Module.PThread?.terminateAllThreads?.();
    },
  };
}
