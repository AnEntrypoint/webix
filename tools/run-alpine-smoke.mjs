#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRuntime, mountAlpineMiniRootfs } from "../src/index.js";
import { NodeTcpNetwork } from "../src/network-node.js";

const rootfsPath = process.argv[2];
if (!rootfsPath) {
  console.error("Usage: node tools/run-alpine-smoke.mjs alpine-minirootfs-<version>-x86.tar.gz [binary arg ...]");
  console.error("Example: node tools/run-alpine-smoke.mjs alpine-minirootfs-3.23.4-x86.tar.gz /bin/cat /etc/alpine-release");
  process.exit(2);
}
const argv = process.argv.slice(3);
const execPath = argv[0] || "/bin/cat";
const execArgv = argv.length ? argv : ["/bin/cat", "/etc/alpine-release"];
const rootfs = readFileSync(rootfsPath);
const rt = createRuntime({
  network: new NodeTcpNetwork(),
  onWrite: (fd, text) => (fd === 2 ? process.stderr : process.stdout).write(text),
  maxSteps: 250_000_000,
});
await mountAlpineMiniRootfs(rt.vfs, { bytes: rootfs, progress: msg => console.error(`[rootfs] ${msg}`) });
rt.loadExecutableFromVFS(execPath, { argv: execArgv, execPath });
const result = await rt.runAsync({ maxSteps: Number(process.env.OPENX86_MAX_STEPS || 250_000_000), yieldEvery: 4096 });
console.error(`\n[exit=${result.exitCode} steps=${result.steps}]`);
process.exit(result.exitCode);
