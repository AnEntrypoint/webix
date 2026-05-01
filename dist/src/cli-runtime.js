import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRuntime, VFS, mountTarGz, seedAlpineRuntimeFiles, serializeVfsBinary, restoreVfsBinary, installTarPackage } from "./index.js";
import { NodeTcpNetwork } from "./network-node.js";

export function parseArgv(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else opts._.push(a);
  }
  return opts;
}

export async function loadRootfs(pathOrNull, options = {}) {
  let vfs;
  if (options.snapshot && existsSync(options.snapshot)) vfs = restoreVfsBinary(readFileSync(options.snapshot));
  else vfs = new VFS();
  if (pathOrNull) await mountTarGz(vfs, readFileSync(pathOrNull), { root: "/", ignoreErrors: options.ignoreErrors ?? false });
  seedAlpineRuntimeFiles(vfs);
  return vfs;
}

export function saveSnapshot(vfs, path) { writeFileSync(path, serializeVfsBinary(vfs)); }

export async function runProgram({ rootfs, snapshot, save, path, args = [], env = {}, trace = false, maxSteps = 50_000_000, stdin = "", network = null }) {
  const vfs = await loadRootfs(rootfs, { snapshot });
  const rt = createRuntime({ vfs, trace, stdin, env, network: network ?? new NodeTcpNetwork(), maxSteps });
  rt.loadExecutableFromVFS(path, { execPath: path, argv: [path, ...args], trace, env });
  const result = await rt.runAsync({ maxSteps });
  if (save) saveSnapshot(vfs, save);
  return { result, vfs };
}

export async function installPackageCommand({ rootfs, snapshot, save, packagePath }) {
  const vfs = await loadRootfs(rootfs, { snapshot });
  const result = await installTarPackage(vfs, readFileSync(packagePath), { root: "/" });
  if (save) saveSnapshot(vfs, save);
  return { result, vfs };
}
