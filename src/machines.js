import { createMachine, createActor, assign } from "xstate";

export const kernelMachine = createMachine({
  id:"xos.kernel",
  initial:"idle",
  context:{ processes:new Map(), devices:new Map(), lastError:null },
  states:{
    idle:{ on:{ BOOT:{ target:"running", actions:assign({ devices:({event,context})=>event.devices??context.devices }) } } },
    running:{ on:{
      SPAWN:{ actions:assign({ processes:({context,event})=>{const m=new Map(context.processes);m.set(event.pid,event.process);return m} }) },
      EXIT:{ actions:assign({ processes:({context,event})=>{const m=new Map(context.processes);m.delete(event.pid);return m} }) },
      FAULT:{ target:"faulted", actions:assign({ lastError:({event})=>event.error??event }) },
      SHUTDOWN:"stopped"
    } },
    faulted:{ on:{ RESET:"idle" } },
    stopped:{}
  }
});

export const processMachine = createMachine({
  id:"xos.process",
  initial:"created",
  context:({ input })=>({ pid:input?.pid??0, argv:input?.argv??[], exitCode:null, signal:null, error:null }),
  states:{
    created:{ on:{ START:"running" } },
    running:{ on:{
      BLOCK:"blocked",
      SIGNAL:{ actions:assign({ signal:({event})=>event.signal }) },
      EXIT:{ target:"exited", actions:assign({ exitCode:({event})=>event.code??0 }) },
      FAULT:{ target:"faulted", actions:assign({ error:({event})=>event.error??event }) }
    } },
    blocked:{ on:{ WAKE:"running", EXIT:"exited" } },
    exited:{},
    faulted:{}
  }
});

export const schedulerMachine = createMachine({
  id:"xos.scheduler",
  initial:"stopped",
  context:{ runnable:[], current:null, ticks:0 },
  states:{ stopped:{ on:{ START:"running" } }, running:{ on:{ STOP:"stopped" } } }
});

export function createKernelActor(){ const a=createActor(kernelMachine); a.start(); return wrap(a) }
export function createProcessActor(input){ const a=createActor(processMachine,{input}); a.start(); return wrap(a) }
export function createSchedulerActor(){ const a=createActor(schedulerMachine); a.start(); return wrap(a) }

function wrap(actor){
  return {
    send:(e)=>actor.send(e),
    getSnapshot(){ const s=actor.getSnapshot(); return { value:typeof s.value==="string"?s.value:JSON.stringify(s.value), context:s.context, status:s.status } },
    subscribe:(fn)=>actor.subscribe(fn)
  };
}
