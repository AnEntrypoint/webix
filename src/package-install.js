import { gunzipBytes, mountTar, parseTarEntries } from "./tar.js";
import { seedAlpineRuntimeFiles } from "./rootfs.js";

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data ?? []);
}
function appendText(vfs, path, text) {
  let old = "";
  try { old = new TextDecoder().decode(vfs.readFile(path)); } catch { vfs.mkdirp(path.substring(0, path.lastIndexOf("/")) || "/"); }
  vfs.writeFile(path, old + text, 0o644);
}

export async function inspectTarPackage(data, options = {}) {
  const tar = await gunzipBytes(asBytes(data));
  const entries = parseTarEntries(tar);
  return {
    entries: entries.length,
    files: entries.filter(e => !e.typeflag || e.typeflag === "0" || e.typeflag === "\0").length,
    dirs: entries.filter(e => e.typeflag === "5").length,
    symlinks: entries.filter(e => e.typeflag === "2").length,
    paths: options.paths ? entries.map(e => e.path) : undefined,
  };
}

export async function installTarPackage(vfs, data, options = {}) {
  const tar = await gunzipBytes(asBytes(data));
  const installed = [];
  const result = mountTar(vfs, tar, {
    root: options.root ?? "/",
    ignoreErrors: options.ignoreErrors ?? false,
    onEntry: e => installed.push(e.mountedPath),
  });
  seedAlpineRuntimeFiles(vfs, options.seed ?? {});
  const name = options.name ?? options.packageName ?? "tar-package";
  appendText(vfs, "/var/lib/xos/packages.log", `${new Date(0).toISOString()} ${name} ${installed.length} entries\n`);
  return { installed, count: result.count, entries: result.entries.length, name };
}

export async function installPackages(vfs, packages, options = {}) {
  const results = [];
  for (const pkg of packages) results.push(await installTarPackage(vfs, pkg.bytes ?? pkg, { ...options, root: pkg.root ?? options.root, name: pkg.name ?? options.name }));
  return results;
}
