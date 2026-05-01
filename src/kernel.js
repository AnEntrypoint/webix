import { createKernelActor, createProcessActor, createSchedulerActor } from "./machines.js";

export class XOSKernel {
  constructor(options={}){
    this.options=options;
    this.kernelActor=options.kernelActor??createKernelActor();
    this.schedulerActor=options.schedulerActor??createSchedulerActor();
    this.processActors=new Map();
    this.nextPid=options.nextPid??1000;
    this.kernelActor.send({type:"BOOT",devices:options.devices??new Map()});
  }
  async runX86_64Bytes(bytes,{argv=[],env,progname="/program",rootfsTarBytes}={}){
    const { createBlinkHost } = await import("./x86_64-blink.js");
    const host=await createBlinkHost({ wasmPath:this.options.blinkWasmPath??"containers/blinkenlib.wasm", gluePath:this.options.blinkGluePath??"containers/blinkenlib.js" });
    if(rootfsTarBytes) host.mountTarBytes(rootfsTarBytes);
    const pid=this.nextPid++;
    const proc=createProcessActor({pid,argv:[progname,...argv]});
    this.processActors.set(pid,proc);
    this.kernelActor.send({type:"SPAWN",pid,process:proc});
    proc.send({type:"START"});
    try{
      const r=await host.runElf(bytes,{argv,progname});
      proc.send({type:"EXIT",code:r.exitCode});
      this.kernelActor.send({type:"EXIT",pid});
      return { pid, exitCode:r.exitCode, stdout:r.stdout, stderr:r.stderr, signal:r.signal };
    }catch(e){
      proc.send({type:"FAULT",error:e});
      this.kernelActor.send({type:"FAULT",error:e,pid});
      throw e;
    }
  }
  signal(pid,signal){ const p=this.processActors.get(pid); if(p) p.send({type:"SIGNAL",signal}); return !!p }
  reap(pid){ const p=this.processActors.get(pid); if(!p) return null; const snap=p.getSnapshot(); if(snap.value==="exited"||snap.value==="faulted"){ this.processActors.delete(pid); return snap } return null }
  snapshot(){
    return {
      kernel:this.kernelActor.getSnapshot(),
      scheduler:this.schedulerActor.getSnapshot(),
      processes:[...this.processActors.entries()].map(([pid,a])=>[pid,a.getSnapshot()])
    };
  }
}
export function createKernel(options={}){ return new XOSKernel(options) }
