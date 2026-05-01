#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { createRuntime, mountAlpineMiniRootfs, seedAlpineRuntimeFiles, ByteQueue, installTarPackage, loadRootfsTar, benchmark } from "../src/index.js";
import { NodeTcpNetwork } from "../src/network-node.js";

function usage(exit = 0) {
  console.log(`xos - clean-room browser/Node Linux userspace emulator

Commands:
  xos boot --rootfs rootfs.tar[.gz]
  xos run --rootfs rootfs.tar[.gz] /bin/busybox echo hello
  xos shell --rootfs rootfs.tar[.gz]
  xos trace --rootfs rootfs.tar[.gz] /bin/busybox ls /
  xos package install --rootfs rootfs.tar[.gz] package.tar[.gz] [--snapshot out.vfs]
  xos benchmark [iterations]

Options:
  --rootfs <file>       tar/tar.gz rootfs to mount
  --max-steps <n>       instruction step limit
  --trace              syscall/instruction trace mode
  --snapshot <file>     write VFS snapshot after package install
`);
  process.exit(exit);
}
function takeFlag(args, name, def = null) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function hasFlag(args, name) { const i = args.indexOf(name); if (i === -1) return false; args.splice(i, 1); return true; }
async function makeRuntime(args, options = {}) {
  const rootfs = takeFlag(args, "--rootfs");
  const trace = options.trace ?? hasFlag(args, "--trace");
  const maxSteps = Number(takeFlag(args, "--max-steps", options.maxSteps ?? 50_000_000));
  const input = new ByteQueue(options.stdin ?? "");
  if (options.pipeStdin) {
    process.stdin.on("data", b => input.push(new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice()));
    process.stdin.on("end", () => input.close());
    if (process.stdin.isTTY) process.stdin.resume();
  }
  const rt = createRuntime({ stdin: input, trace, maxSteps, network: new NodeTcpNetwork(), onWrite: (_fd, text) => process.stdout.write(text) });
  if (rootfs) await loadRootfsTar(rt.vfs, await readFile(rootfs), { ignoreErrors: false });
  seedAlpineRuntimeFiles(rt.vfs);
  return { rt, rootfs, trace, maxSteps, input };
}
async function runProgram(args, options = {}) {
  const { rt, maxSteps } = await makeRuntime(args, options);
  const program = args.shift();
  if (!program) usage(2);
  const argv = [program, ...args];
  rt.loadExecutableFromVFS(program, { argv, execPath: program, trace: options.trace });
  const res = await rt.runAsync({ maxSteps, yieldEvery: 4096 });
  if (res.stderr) process.stderr.write(res.stderr);
  return res.exitCode;
}

const args = process.argv.slice(2);
const command = args.shift();
try {
  if (!command || command === "help" || command === "--help") usage(0);
  if (command === "benchmark") {
    const r = await benchmark({ iterations: Number(args[0] ?? 250000) });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.exitCode ?? 0);
  }
  if (command === "run") process.exit(await runProgram(args));
  if (command === "trace") process.exit(await runProgram(args, { trace: true }));
  if (command === "boot" || command === "shell") {
    const { rt, maxSteps } = await makeRuntime(args, { pipeStdin: true });
    const shell = args[0] ?? "/bin/sh";
    const argv = [shell, "-i"];
    rt.loadExecutableFromVFS(shell, { argv, execPath: shell });
    const res = await rt.runAsync({ maxSteps, yieldEvery: 1024 });
    process.exit(res.exitCode ?? 0);
  }
  if (command === "package") {
    const sub = args.shift();
    if (sub !== "install") usage(2);
    const snapshot = takeFlag(args, "--snapshot");
    const { rt } = await makeRuntime(args);
    const pkg = args.shift();
    if (!pkg) usage(2);
    const result = await installTarPackage(rt.vfs, await readFile(pkg), { name: pkg });
    console.log(JSON.stringify(result, null, 2));
    if (snapshot) await writeFile(snapshot, rt.vfs.snapshot({ binary: true }));
    process.exit(0);
  }
  usage(2);
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
}
