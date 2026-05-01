/**
 * Small XState-compatible orchestration layer used by the emulator without
 * pulling a heavy dependency into browser bundles. Actors expose the familiar
 * send/getSnapshot/subscribe lifecycle and keep CPU hot loops outside the state
 * machine while process/kernel/device lifecycle remains observable.
 */
export class StateSnapshot {
  constructor(value, context = {}, event = null) { this.value = value; this.context = context; this.event = event; }
  matches(value) { return this.value === value; }
}

export class ActorMachine {
  constructor(definition, context = {}) {
    this.definition = definition;
    this.state = definition.initial;
    this.context = { ...(definition.context ?? {}), ...context };
    this.listeners = new Set();
  }
  getSnapshot() { return new StateSnapshot(this.state, this.context); }
  subscribe(listener) { this.listeners.add(listener); listener(this.getSnapshot()); return { unsubscribe: () => this.listeners.delete(listener) }; }
  _emit(event) { const snap = new StateSnapshot(this.state, this.context, event); for (const l of this.listeners) l(snap); }
  send(event) {
    const e = typeof event === "string" ? { type: event } : event;
    const node = this.definition.states?.[this.state];
    const transition = node?.on?.[e.type] ?? this.definition.on?.[e.type];
    if (!transition) return this.getSnapshot();
    const t = typeof transition === "string" ? { target: transition } : transition;
    if (t.guard && !t.guard(this.context, e)) return this.getSnapshot();
    if (t.actions) for (const action of Array.isArray(t.actions) ? t.actions : [t.actions]) action(this.context, e, this);
    if (t.target) this.state = t.target;
    this._emit(e);
    return this.getSnapshot();
  }
}

export function createMachine(definition) { return definition; }
export function createActor(machine, options = {}) { return new ActorMachine(machine, options.context); }

export const kernelMachine = createMachine({
  id: "kernel",
  initial: "idle",
  context: { processes: new Map(), faults: [], bootArgs: {} },
  states: {
    idle: { on: { BOOT: { target: "booting", actions: (ctx, e) => { ctx.bootArgs = e; } } } },
    booting: { on: { READY: "running", FAULT: { target: "faulted", actions: (ctx, e) => ctx.faults.push(e) } } },
    running: { on: { SPAWN: { actions: (ctx, e) => ctx.processes.set(e.pid, e) }, EXIT: { actions: (ctx, e) => ctx.processes.delete(e.pid) }, FAULT: { target: "faulted", actions: (ctx, e) => ctx.faults.push(e) }, SHUTDOWN: "stopped" } },
    faulted: { on: { RESET: "idle" } },
    stopped: { on: { RESET: "idle" } },
  },
});

export const processMachine = createMachine({
  id: "process",
  initial: "new",
  context: { pid: 0, path: "", exitCode: null, signal: null, fault: null },
  states: {
    new: { on: { LOAD: { target: "loaded", actions: (ctx, e) => Object.assign(ctx, e) } } },
    loaded: { on: { RUN: "running", EXEC: { actions: (ctx, e) => Object.assign(ctx, { path: e.path }) } } },
    running: { on: { BLOCK: "blocked", SIGNAL: { actions: (ctx, e) => { ctx.signal = e.signal; } }, EXIT: { target: "exited", actions: (ctx, e) => { ctx.exitCode = e.code ?? 0; } }, FAULT: { target: "faulted", actions: (ctx, e) => { ctx.fault = e; } } } },
    blocked: { on: { WAKE: "running", EXIT: { target: "exited", actions: (ctx, e) => { ctx.exitCode = e.code ?? 0; } } } },
    exited: {},
    faulted: {},
  },
});

export const schedulerMachine = createMachine({
  id: "scheduler",
  initial: "stopped",
  context: { queue: [], current: null, ticks: 0 },
  states: {
    stopped: { on: { START: "running" } },
    running: { on: { ENQUEUE: { actions: (ctx, e) => ctx.queue.push(e.pid) }, TICK: { actions: ctx => { ctx.ticks++; ctx.current = ctx.queue.shift() ?? null; if (ctx.current !== null) ctx.queue.push(ctx.current); } }, STOP: "stopped" } },
  },
});

export const deviceMachine = createMachine({
  id: "device",
  initial: "detached",
  context: { name: "", events: [] },
  states: {
    detached: { on: { ATTACH: { target: "ready", actions: (ctx, e) => { ctx.name = e.name ?? ctx.name; } } } },
    ready: { on: { IO: { target: "busy", actions: (ctx, e) => ctx.events.push(e) }, DETACH: "detached" } },
    busy: { on: { COMPLETE: "ready", FAULT: "faulted" } },
    faulted: { on: { RESET: "ready" } },
  },
});

export function createKernelActor(context = {}) { return createActor(kernelMachine, { context }); }
export function createProcessActor(context = {}) { return createActor(processMachine, { context }); }
export function createSchedulerActor(context = {}) { return createActor(schedulerMachine, { context }); }
export function createDeviceActor(context = {}) { return createActor(deviceMachine, { context }); }
