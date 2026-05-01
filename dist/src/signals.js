export const SIGNALS = Object.freeze({
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19,
});
export const DEFAULT_SIGNAL_ACTION = Object.freeze({ TERM: "terminate", IGNORE: "ignore", CORE: "core", STOP: "stop", CONT: "continue" });
const defaultActions = new Map([
  [SIGNALS.SIGCHLD, DEFAULT_SIGNAL_ACTION.IGNORE],
  [SIGNALS.SIGCONT, DEFAULT_SIGNAL_ACTION.CONT],
  [SIGNALS.SIGSTOP, DEFAULT_SIGNAL_ACTION.STOP],
  [SIGNALS.SIGKILL, DEFAULT_SIGNAL_ACTION.TERM],
]);
export class SignalState {
  constructor() { this.handlers = new Map(); this.mask = new Set(); this.pending = []; }
  setHandler(signal, handler) { this.handlers.set(signal >>> 0, handler); }
  block(signal) { this.mask.add(signal >>> 0); }
  unblock(signal) { this.mask.delete(signal >>> 0); }
  enqueue(signal, info = {}) { this.pending.push({ signal: signal >>> 0, info, at: Date.now() }); }
  nextDeliverable() {
    const idx = this.pending.findIndex(p => !this.mask.has(p.signal));
    if (idx < 0) return null;
    return this.pending.splice(idx, 1)[0];
  }
  defaultAction(signal) { return defaultActions.get(signal >>> 0) ?? DEFAULT_SIGNAL_ACTION.TERM; }
}
