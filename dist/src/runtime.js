import { CPU } from "./cpu.js";
import { PagedMemory, PERM } from "./memory.js";
import { VFS } from "./vfs.js";
import { LinuxSyscalls, ProcessExit, AsyncSyscallPending, ExecveTrap } from "./syscalls.js";
import { loadELF32Process, loadFlatBinary, setupInitialStack } from "./elf.js";
import { i386 } from "./arch.js";
import { SignalState } from "./signals.js";
import { buildAlpineRuntimeEnv } from "./rootfs.js";

function defaultEnv() { return { PATH: "/sbin:/bin:/usr/sbin:/usr/bin", HOME: "/root", USER: "root", SHELL: "/bin/sh", TERM: "xterm", LD_LIBRARY_PATH: "/lib:/usr/lib" }; }
function runtimeEnv(vfs, env, execPath) { return buildAlpineRuntimeEnv(vfs, env ?? defaultEnv(), execPath ?? ""); }

export class EmulatedRuntime {
  constructor(options = {}) {
    this.options = options;
    this.architecture = options.architecture ?? i386;
    this.signals = options.signals ?? new SignalState();
    this.vfs = options.vfs ?? new VFS();
    this.memory = options.memory ?? new PagedMemory({ onWrite: (addr, len) => this.jit?.invalidate?.(addr, len) });
    this.syscalls = new LinuxSyscalls(this.memory, { ...options, vfs: this.vfs });
    this.syscalls.onExecve = (path, argv, env, cpu) => this.execve(path, argv, env, cpu);
    this.syscalls.onFork = (cpu, kind) => this.forkProcess(cpu, kind);
    this.syscalls.onWait4 = (pid, statusAddr, options, rusageAddr) => this.wait4(pid, statusAddr, options, rusageAddr);
    this.children = new Map();
    this.nextPid = options.nextPid ?? 1000;
    this.cpu = null;
    this.jit = options.jit ?? null;
    this.proc = null;
  }
  mountFile(path, data) { this.vfs.writeFile(path, data); return this; }
  mountFiles(files, root = "/") { this.vfs.mountFiles(files, root); return this; }
  _newMemory() { return new PagedMemory({ onWrite: (addr, len) => this.jit?.invalidate?.(addr, len) }); }
  _wireSyscalls(syscalls) {
    syscalls.onExecve = (path, argv, env, cpu) => this.execve(path, argv, env, cpu);
    syscalls.onFork = (cpu, kind) => this.forkProcess(cpu, kind);
    syscalls.onWait4 = (pid, statusAddr, options, rusageAddr) => this.wait4(pid, statusAddr, options, rusageAddr);
  }
  _cloneCpu(cpu, memory, syscalls) {
    const childCpu = this.architecture.createCPU(memory, syscalls, { eip: cpu.eip, trace: cpu.trace, logger: cpu.logger });
    childCpu.regs.set(cpu.regs);
    childCpu.sregs = { ...cpu.sregs };
    childCpu.segBase = { ...cpu.segBase };
    childCpu.eflags = cpu.eflags;
    childCpu.xmm = cpu.xmm.map(x => x.slice());
    childCpu.fpu = { stack: [...cpu.fpu.stack], control: cpu.fpu.control, status: cpu.fpu.status };
    childCpu.mxcsr = cpu.mxcsr;
    childCpu.steps = 0;
    childCpu.lastPrefix = cpu.lastPrefix ? { ...cpu.lastPrefix } : null;
    return childCpu;
  }
  forkProcess(cpu = this.cpu, kind = "fork") {
    const pid = this.nextPid++;
    const childMemory = this.memory.clone({ copyOnWrite: true, onWrite: (addr, len) => this.jit?.invalidate?.(addr, len) });
    const child = new EmulatedRuntime({ ...this.options, vfs: this.vfs, memory: childMemory, pid, ppid: this.syscalls.pid, stdin: "", network: this.syscalls.network, futex: this.syscalls.futex, signals: this.signals, onWrite: this.syscalls.onWrite });
    child.nextPid = this.nextPid;
    child.memory = childMemory;
    child.syscalls.memory = childMemory;
    child.syscalls.fd = new Map(this.syscalls.fd);
    child.syscalls.nextFd = this.syscalls.nextFd;
    child.syscalls.cwd = this.syscalls.cwd;
    child.vfs.cwd = this.vfs.cwd;
    child.proc = this.proc;
    child.cpu = this._cloneCpu(cpu, childMemory, child.syscalls);
    child.cpu.regs[0] = 0; // EAX in child after fork/vfork/clone
    this.children.set(pid, { runtime: child, status: null, kind, started: false });
    this.nextPid = child.nextPid;
    return pid;
  }
  async wait4(pid, statusAddr = 0, options = 0, rusageAddr = 0) {
    let selectedPid = pid | 0;
    if (selectedPid <= 0) selectedPid = this.children.keys().next().value ?? 0;
    if (!selectedPid || !this.children.has(selectedPid)) return 0xffffffff - 9; // -ECHILD
    const child = this.children.get(selectedPid);
    if (!child.status) {
      try { child.status = await child.runtime.runAsync({ maxSteps: this.options.childMaxSteps ?? 100_000_000, yieldEvery: 2048 }); }
      catch (e) {
        if (e instanceof ProcessExit) child.status = { exitCode: e.code };
        else throw e;
      }
    }
    if (statusAddr) this.memory.write32(statusAddr, (child.status.exitCode & 0xff) << 8);
    this.children.delete(selectedPid);
    return selectedPid >>> 0;
  }
  _resetCpuForProcess(cpu, proc, options = {}) {
    cpu.mem = this.memory;
    cpu.regs.fill(0);
    cpu.sregs = { es: 0x2b, cs: 0x23, ss: 0x2b, ds: 0x2b, fs: 0, gs: 0 };
    cpu.segBase = { es: 0, cs: 0, ss: 0, ds: 0, fs: 0, gs: 0 };
    cpu.eip = proc.entry >>> 0;
    cpu.eflags = 0x202;
    this.architecture.setupInitialStack(cpu, { stackTop: proc.stackTop, argv: options.argv ?? [options.execPath ?? "a.out"], env: runtimeEnv(this.vfs, options.env ?? this.options.env ?? defaultEnv(), options.execPath ?? "a.out"), execPath: options.execPath ?? "a.out", phdrAddr: proc.main.phdrAddr, phent: proc.main.phent, phnum: proc.main.phnum, entry: proc.main.entry, base: proc.interp ? proc.interp.base : 0, uid: this.syscalls.uid, gid: this.syscalls.gid });
  }
  loadExecutableFromVFS(path, options = {}) {
    const bytes = this.vfs.readFile(path);
    return this.loadELF(bytes, { ...options, execPath: options.execPath ?? path, argv: options.argv ?? [path] });
  }

  loadELF(bytes, options = {}) {
    const proc = this.architecture.loadProcess(bytes, { ...this.options, ...options, memory: this.memory, vfs: this.vfs });
    this.syscalls.memory = this.memory;
    this.syscalls.brk = proc.brk;
    this.cpu = this.architecture.createCPU(this.memory, this.syscalls, { eip: proc.entry, trace: options.trace ?? this.options.trace });
    this.architecture.setupInitialStack(this.cpu, { stackTop: proc.stackTop, argv: options.argv ?? this.options.argv ?? [options.execPath ?? "a.out"], env: runtimeEnv(this.vfs, options.env ?? this.options.env ?? defaultEnv(), options.execPath ?? "a.out"), execPath: options.execPath ?? "a.out", phdrAddr: proc.main.phdrAddr, phent: proc.main.phent, phnum: proc.main.phnum, entry: proc.main.entry, base: proc.interp ? proc.interp.base : 0, uid: this.syscalls.uid, gid: this.syscalls.gid });
    this.proc = proc;
    return proc;
  }
  loadFlat(bytes, loadAddress = 0x08048000, options = {}) {
    const flat = loadFlatBinary(bytes, loadAddress, { memory: this.memory, name: options.name ?? "[flat]" });
    const stackTop = options.stackTop ?? 0xbffff000;
    const stackSize = options.stackSize ?? 1024 * 1024;
    this.memory.map((stackTop - stackSize) >>> 0, stackSize, PERM.RW, "[stack]");
    this.syscalls.brk = flat.brk;
    this.cpu = this.architecture.createCPU(this.memory, this.syscalls, { eip: flat.entry, trace: options.trace ?? this.options.trace });
    this.architecture.setupInitialStack(this.cpu, { stackTop, argv: options.argv ?? ["flat"], entry: flat.entry });
    this.proc = flat;
    return flat;
  }
  execve(path, argv = [path], env = [], cpu = this.cpu) {
    const bytes = this.vfs.readFile(path);
    this.memory = this._newMemory();
    this.syscalls.memory = this.memory;
    const proc = this.architecture.loadProcess(bytes, { ...this.options, memory: this.memory, vfs: this.vfs, execPath: path });
    this.syscalls.brk = proc.brk;
    this.proc = proc;
    const envValue = runtimeEnv(this.vfs, env.length ? env : (this.options.env ?? defaultEnv()), path);
    this._resetCpuForProcess(cpu, proc, { execPath: path, argv: argv.length ? argv : [path], env: envValue });
    this.cpu = cpu;
    return 0;
  }
  _result(exitCode = 0) { return { exitCode, output: this.syscalls.output, stderr: this.syscalls.stderr, steps: this.cpu?.steps ?? 0, regs: this.cpu?.dumpRegs?.() ?? {} }; }
  run(options = {}) {
    if (!this.cpu) throw new Error("No program loaded");
    const maxSteps = options.maxSteps ?? this.options.maxSteps ?? 10_000_000;
    try {
      if (this.jit?.run) this.jit.run(this.cpu, maxSteps); else this.cpu.run(maxSteps);
      return this._result(0);
    } catch (e) {
      if (e instanceof ProcessExit) return this._result(e.code);
      e.registers = this.cpu.dumpRegs(); e.output = this.syscalls.output; e.stderr = this.syscalls.stderr; throw e;
    }
  }
  async runAsync(options = {}) {
    if (!this.cpu) throw new Error("No program loaded");
    const maxSteps = options.maxSteps ?? this.options.maxSteps ?? 50_000_000;
    const yieldEvery = options.yieldEvery ?? 4096;
    try {
      while (this.cpu.steps < maxSteps) {
        try { this.cpu.step(); }
        catch (e) {
          if (e instanceof AsyncSyscallPending) { await e.promise; }
          else if (e instanceof ExecveTrap) { this.execve(e.path, e.argv, e.env, this.cpu); }
          else throw e;
        }
        if (yieldEvery && (this.cpu.steps % yieldEvery) === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      throw new Error(`Step limit reached (${maxSteps})`);
    } catch (e) {
      if (e instanceof ProcessExit) return this._result(e.code);
      e.registers = this.cpu.dumpRegs(); e.output = this.syscalls.output; e.stderr = this.syscalls.stderr; throw e;
    }
  }
}
export async function runELF(buffer, options = {}) { const rt = new EmulatedRuntime(options); rt.loadELF(buffer, options); return rt.run(options); }
export async function runELFAsync(buffer, options = {}) { const rt = new EmulatedRuntime(options); rt.loadELF(buffer, options); return rt.runAsync(options); }
export async function runFlat(buffer, loadAddress = 0x08048000, options = {}) { const rt = new EmulatedRuntime(options); rt.loadFlat(buffer, loadAddress, options); return rt.run(options); }
export function createRuntime(options = {}) { return new EmulatedRuntime(options); }
