import { EmulatedRuntime } from "./runtime.js";
import { serializeVfsBinary, restoreVfsBinary } from "./snapshot.js";

export class ProcessRecord {
  constructor({ pid, ppid = 0, runtime, argv = [], env = {}, state = "created" }) {
    this.pid = pid;
    this.ppid = ppid;
    this.runtime = runtime;
    this.argv = argv;
    this.env = env;
    this.state = state;
    this.exitCode = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.waiters = [];
  }
  complete(result) {
    this.state = "exited";
    this.exitCode = result?.exitCode ?? 0;
    this.result = result;
    this.endedAt = Date.now();
    while (this.waiters.length) this.waiters.shift()(this);
  }
  wait() {
    if (this.state === "exited") return Promise.resolve(this);
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export class ProcessManager {
  constructor(options = {}) {
    this.options = options;
    this.vfs = options.vfs ?? null;
    this.network = options.network ?? null;
    this.onWrite = options.onWrite ?? (() => {});
    this.nextPid = options.firstPid ?? 100;
    this.processes = new Map();
    this.completed = new Map();
    this.maxProcesses = options.maxProcesses ?? 256;
  }
  allocPid() {
    while (this.processes.has(this.nextPid) || this.completed.has(this.nextPid)) this.nextPid++;
    return this.nextPid++;
  }
  snapshotVFS(vfs = this.vfs) { if (!vfs) throw new Error("No VFS to snapshot"); return serializeVfsBinary(vfs); }
  restoreVFS(snapshot) { this.vfs = restoreVfsBinary(snapshot); return this.vfs; }
  spawnExecutable(vfs, path, options = {}) {
    if (this.processes.size >= this.maxProcesses) throw new Error("process limit reached");
    const pid = this.allocPid();
    const rt = new EmulatedRuntime({ ...this.options.runtimeOptions, ...options.runtimeOptions, vfs, pid, ppid: options.ppid ?? 1, stdin: options.stdin ?? "", network: options.network ?? this.network, onWrite: options.onWrite ?? this.onWrite });
    rt.loadExecutableFromVFS(path, { argv: options.argv ?? [path], env: options.env ?? this.options.env, execPath: path });
    const rec = new ProcessRecord({ pid, ppid: options.ppid ?? 1, runtime: rt, argv: options.argv ?? [path], env: options.env ?? {} });
    this.processes.set(pid, rec);
    return rec;
  }
  spawn(path, options = {}) {
    if (!this.vfs) throw new Error("ProcessManager.spawn requires a manager VFS or explicit spawnExecutable(vfs, ...)");
    return this.spawnExecutable(this.vfs, path, options);
  }
  async run(pid, options = {}) {
    const rec = this.processes.get(pid);
    if (!rec) throw new Error(`no such process ${pid}`);
    if (rec.state === "exited") return rec.result;
    rec.state = "running";
    try {
      const result = await rec.runtime.runAsync(options);
      rec.complete(result);
      this.processes.delete(pid);
      this.completed.set(pid, rec);
      return result;
    } catch (e) {
      rec.state = "faulted";
      rec.error = e;
      rec.endedAt = Date.now();
      while (rec.waiters.length) rec.waiters.shift()(rec);
      this.processes.delete(pid);
      this.completed.set(pid, rec);
      throw e;
    }
  }
  async spawnAndRun(path, options = {}) { const rec = this.spawn(path, options); return this.run(rec.pid, options); }
  wait(pid) {
    const rec = this.processes.get(pid) ?? this.completed.get(pid);
    if (!rec) return Promise.resolve(null);
    return rec.wait();
  }
  reap(pid) { const rec = this.completed.get(pid); if (rec) this.completed.delete(pid); return rec ?? null; }
  signal(pid, signal = 15) {
    const rec = this.processes.get(pid);
    if (!rec) return false;
    rec.complete({ exitCode: 128 + signal, killedBySignal: signal });
    this.processes.delete(pid);
    this.completed.set(pid, rec);
    return true;
  }
  list() {
    const rows = [];
    for (const p of this.processes.values()) rows.push({ pid: p.pid, ppid: p.ppid, state: p.state, argv: p.argv, exitCode: p.exitCode });
    for (const p of this.completed.values()) rows.push({ pid: p.pid, ppid: p.ppid, state: p.state, argv: p.argv, exitCode: p.exitCode });
    return rows.sort((a, b) => a.pid - b.pid);
  }
}
