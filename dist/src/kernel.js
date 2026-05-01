import { createRuntime } from "./runtime.js";
import { createKernelActor, createProcessActor, createSchedulerActor } from "./machines.js";
import { captureRuntimeFault } from "./diagnostics.js";

export class XOSKernel {
  constructor(options = {}) {
    this.options = options;
    this.kernelActor = options.kernelActor ?? createKernelActor();
    this.schedulerActor = options.schedulerActor ?? createSchedulerActor();
    this.runtime = options.runtime ?? createRuntime(options.runtimeOptions ?? options);
    this.processActors = new Map();
    this.nextPid = options.nextPid ?? 1000;
    this.kernelActor.send({ type: "BOOT", devices: options.devices ?? new Map() });
  }
  get vfs() { return this.runtime.vfs; }
  async loadExecutable(path, argv = [path], env = this.options.env) {
    this.runtime.loadExecutableFromVFS(path, { argv, env, execPath: path, trace: this.options.trace });
    const pid = this.runtime.syscalls.pid || this.nextPid++;
    const proc = createProcessActor({ pid, argv });
    this.processActors.set(pid, proc);
    this.kernelActor.send({ type: "SPAWN", pid, process: proc });
    proc.send({ type: "START" });
    return { pid, process: proc };
  }
  async run(path, argv = [path], env = this.options.env, options = {}) {
    const { pid, process } = await this.loadExecutable(path, argv, env);
    try {
      const result = options.async === false ? this.runtime.run(options) : await this.runtime.runAsync(options);
      process.send({ type: "EXIT", code: result.exitCode });
      this.kernelActor.send({ type: "EXIT", pid });
      return result;
    } catch (error) {
      const fault = captureRuntimeFault(this.runtime, error);
      process.send({ type: "FAULT", error: fault });
      this.kernelActor.send({ type: "FAULT", error: fault });
      throw error;
    }
  }
  signal(pid, signal) {
    const proc = this.processActors.get(pid);
    if (proc) proc.send({ type: "SIGNAL", signal });
    return !!proc;
  }
  snapshot() { return { kernel: this.kernelActor.getSnapshot(), scheduler: this.schedulerActor.getSnapshot(), processes: [...this.processActors.entries()].map(([pid, actor]) => [pid, actor.getSnapshot()]) }; }
}

export function createKernel(options = {}) { return new XOSKernel(options); }
