import { createActor, createMachine, assign } from "./xstate-lite.js";

export const kernelMachine = createMachine({
  id: "xos.kernel",
  initial: "idle",
  context: () => ({ processes: new Map(), devices: new Map(), lastError: null }),
  states: {
    idle: { on: { BOOT: { target: "running", actions: "boot" } } },
    running: { on: { SPAWN: { actions: "spawn" }, EXIT: { actions: "exitProcess" }, FAULT: { target: "faulted", actions: "recordError" }, SHUTDOWN: "stopped" } },
    faulted: { on: { RESET: { target: "idle", actions: "reset" } } },
    stopped: {}
  }
}, {
  actions: {
    boot: assign(({ context, event }) => ({ devices: event.devices ?? context.devices })),
    spawn: assign(({ context, event }) => { const processes = new Map(context.processes); processes.set(event.pid, event.process); return { processes }; }),
    exitProcess: assign(({ context, event }) => { const processes = new Map(context.processes); processes.delete(event.pid); return { processes }; }),
    recordError: assign(({ event }) => ({ lastError: event.error ?? event })),
    reset: () => ({ processes: new Map(), devices: new Map(), lastError: null })
  }
});

export const processMachine = createMachine({
  id: "xos.process",
  initial: "created",
  context: ({ pid = 0, argv = [] } = {}) => ({ pid, argv, exitCode: null, signal: null, error: null }),
  states: {
    created: { on: { START: "running" } },
    running: { on: { BLOCK: "blocked", SIGNAL: { actions: "signal" }, EXIT: { target: "exited", actions: "exit" }, FAULT: { target: "faulted", actions: "fault" } } },
    blocked: { on: { WAKE: "running", SIGNAL: { target: "running", actions: "signal" }, EXIT: { target: "exited", actions: "exit" } } },
    exited: {},
    faulted: {}
  }
}, {
  actions: {
    signal: assign(({ event }) => ({ signal: event.signal })),
    exit: assign(({ event }) => ({ exitCode: event.code ?? 0 })),
    fault: assign(({ event }) => ({ error: event.error ?? event }))
  }
});

export const schedulerMachine = createMachine({
  id: "xos.scheduler",
  initial: "stopped",
  context: () => ({ runnable: [], current: null, ticks: 0 }),
  states: {
    stopped: { on: { START: "running" } },
    running: { on: { ENQUEUE: { actions: "enqueue" }, TICK: { actions: "tick" }, STOP: "stopped" } }
  }
}, {
  actions: {
    enqueue: assign(({ context, event }) => ({ runnable: [...context.runnable, event.pid] })),
    tick: assign(({ context }) => {
      const runnable = [...context.runnable];
      const current = runnable.length ? runnable.shift() : null;
      if (current !== null) runnable.push(current);
      return { runnable, current, ticks: context.ticks + 1 };
    })
  }
});

export function createKernelActor(options = {}) { return createActor(kernelMachine, options).start(); }
export function createProcessActor(options = {}) { return createActor(processMachine, { input: options }).start(); }
export function createSchedulerActor(options = {}) { return createActor(schedulerMachine, options).start(); }
