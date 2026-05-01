import { UnsupportedOpcodeError, CPUError } from "./cpu.js";
import { MemoryFault } from "./memory.js";

export function formatRegisters(regs = {}) {
  return Object.entries(regs).map(([k, v]) => `${k}=${typeof v === "number" ? "0x" + (v >>> 0).toString(16).padStart(8, "0") : v}`).join(" ");
}

export function captureRuntimeFault(runtime, error) {
  const cpu = runtime.cpu;
  const regs = cpu?.dumpRegs?.() ?? {};
  const near = [];
  if (cpu?.mem && regs.eip !== undefined) {
    for (let i = -8; i < 24; i++) {
      try { near.push(cpu.mem.read8((regs.eip + i) >>> 0)); } catch { near.push(null); }
    }
  }
  const fault = {
    type: error?.constructor?.name ?? "Error",
    message: error?.message ?? String(error),
    registers: regs,
    eipBytes: near,
    stdout: runtime.syscalls?.output ?? "",
    stderr: runtime.syscalls?.stderr ?? "",
    memoryMaps: runtime.memory?.formatMaps?.() ?? "",
  };
  if (error instanceof UnsupportedOpcodeError) fault.unsupportedOpcode = error.op;
  if (error instanceof MemoryFault) fault.memoryFault = { addr: error.addr, op: error.op };
  return fault;
}

export function faultReport(runtime, error) {
  const f = captureRuntimeFault(runtime, error);
  const bytes = f.eipBytes.map(b => b === null ? "??" : b.toString(16).padStart(2, "0")).join(" ");
  return [`${f.type}: ${f.message}`, formatRegisters(f.registers), `eip bytes[-8:+24]: ${bytes}`, `stdout bytes: ${f.stdout.length}`, `stderr bytes: ${f.stderr.length}`, "maps:", f.memoryMaps].join("\n");
}

export async function runWithDiagnostics(runtime, options = {}) {
  try { return await runtime.runAsync(options); }
  catch (e) { e.diagnostic = captureRuntimeFault(runtime, e); throw e; }
}
