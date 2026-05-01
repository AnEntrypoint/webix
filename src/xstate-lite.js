/**
 * A tiny XState-compatible subset used for repo-local orchestration tests when
 * the full xstate package is not installed. Machines are plain data, actors have
 * start/send/subscribe/getSnapshot, and actions are explicit functions. Hot CPU
 * execution stays outside this layer; lifecycle and errors flow through actors.
 */
export function createMachine(config, implementations = {}) { return { ...config, implementations }; }

export class ActorRef {
  constructor(machine, options = {}) {
    this.machine = machine;
    this.state = { value: machine.initial, context: typeof machine.context === "function" ? machine.context(options.input) : { ...(machine.context ?? {}) } };
    this.subscribers = new Set();
    this.status = "notStarted";
  }
  start() { this.status = "running"; this._notify(); return this; }
  stop() { this.status = "stopped"; this._notify(); }
  getSnapshot() { return { ...this.state, status: this.status }; }
  subscribe(fn) { this.subscribers.add(fn); fn(this.getSnapshot()); return { unsubscribe: () => this.subscribers.delete(fn) }; }
  _notify() { const snap = this.getSnapshot(); for (const fn of this.subscribers) fn(snap); }
  send(event) {
    const node = this.machine.states?.[this.state.value] ?? {};
    const transition = node.on?.[event.type] ?? this.machine.on?.[event.type];
    if (!transition) return this.getSnapshot();
    const tx = typeof transition === "string" ? { target: transition } : transition;
    let ctx = this.state.context;
    const actions = Array.isArray(tx.actions) ? tx.actions : tx.actions ? [tx.actions] : [];
    for (const a of actions) {
      const fn = typeof a === "function" ? a : this.machine.implementations?.actions?.[a];
      if (fn) ctx = fn({ context: ctx, event, self: this }) ?? ctx;
    }
    if (tx.target) this.state = { value: tx.target, context: ctx };
    else this.state = { value: this.state.value, context: ctx };
    this._notify();
    return this.getSnapshot();
  }
}
export function createActor(machine, options = {}) { return new ActorRef(machine, options); }
export function assign(updater) { return ({ context, event }) => ({ ...context, ...(typeof updater === "function" ? updater({ context, event }) : updater) }); }
