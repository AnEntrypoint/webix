import { gunzipBytes, parseTarEntries, mountTar } from "./tar.js";
import { stringToBytes } from "./util.js";

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data ?? []);
}
function isGzip(bytes) { return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; }
function norm(path) {
  const parts = [];
  for (const p of String(path || "/").split("/")) { if (!p || p === ".") continue; if (p === "..") parts.pop(); else parts.push(p); }
  return `/${parts.join("/")}`;
}
function dirname(path) { const i = path.lastIndexOf("/"); return i <= 0 ? "/" : path.slice(0, i); }
function bytesToText(bytes) { return new TextDecoder().decode(bytes); }

export class PackageInstallError extends Error {
  constructor(message, details = {}) { super(message); this.details = details; }
}

/**
 * Unpack a tar/tar.gz package into the writable VFS layer. This is deliberately
 * not a fake package manager: it applies real archive entries, preserves modes,
 * symlinks and directories, and lets the emulator's VFS/syscalls enforce errors.
 */
export async function installTarPackage(vfs, archiveBytes, options = {}) {
  const root = options.root ?? "/";
  const bytes = asBytes(archiveBytes);
  const tarBytes = isGzip(bytes) ? await gunzipBytes(bytes) : bytes;
  const entries = parseTarEntries(tarBytes);
  const installed = [];
  const skipped = [];
  for (const e of entries) {
    const path = norm(`${root}/${e.path}`);
    const type = e.typeflag || "0";
    if (path === "/.PKGINFO" || path.endsWith("/.PKGINFO")) { skipped.push(path); continue; }
    try {
      if (type === "5") vfs.mkdirp(path, e.mode & 0o7777 || 0o755);
      else if (type === "2") { vfs.mkdirp(dirname(path)); vfs.symlink(e.linkname, path); }
      else if (type === "1") { const src = norm(`${root}/${e.linkname}`); vfs.writeFile(path, vfs.readFile(src), e.mode & 0o7777 || 0o644); }
      else if (type === "3") { vfs.mkdirp(dirname(path)); vfs.mknod(path, "null", e.mode & 0o7777 || 0o666, 0); }
      else if (type === "0" || type === "\0" || type === "") { vfs.mkdirp(dirname(path)); vfs.writeFile(path, e.data.slice(), e.mode & 0o7777 || 0o644); }
      else skipped.push(path);
      installed.push(path);
    } catch (err) {
      if (!options.ignoreErrors) throw new PackageInstallError(`failed to install ${path}: ${err.message}`, { entry: e, cause: err });
      skipped.push(path);
    }
  }
  const dbPath = options.databasePath ?? "/var/lib/xos/packages.log";
  try {
    vfs.mkdirp(dirname(dbPath));
    const old = vfs.exists(dbPath) ? bytesToText(vfs.readFile(dbPath)) : "";
    const name = options.name ?? inferPackageName(entries) ?? "tar-package";
    vfs.writeFile(dbPath, stringToBytes(`${old}${name} ${installed.length} files\n`));
  } catch { /* metadata database is best-effort; archive install already happened */ }
  return { entries: entries.length, installed, skipped };
}

function inferPackageName(entries) {
  const info = entries.find(e => e.path === "/.PKGINFO" || e.path === ".PKGINFO");
  if (!info) return null;
  const text = bytesToText(info.data);
  const pkg = /^pkgname\s*=\s*(.+)$/m.exec(text)?.[1]?.trim();
  const ver = /^pkgver\s*=\s*(.+)$/m.exec(text)?.[1]?.trim();
  return pkg ? `${pkg}${ver ? `-${ver}` : ""}` : null;
}

export async function loadRootfsTar(vfs, archiveBytes, options = {}) {
  const bytes = asBytes(archiveBytes);
  const tarBytes = isGzip(bytes) ? await gunzipBytes(bytes) : bytes;
  return mountTar(vfs, tarBytes, { root: options.root ?? "/", ignoreErrors: options.ignoreErrors ?? false, onEntry: options.onEntry });
}

export function parseApkPkgInfo(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([^=]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

export async function inspectTarPackage(data, options = {}) {
  const bytes = asBytes(data);
  const tarBytes = isGzip(bytes) ? await gunzipBytes(bytes) : bytes;
  const entries = parseTarEntries(tarBytes);
  const info = entries.find(e => e.path === "/.PKGINFO" || e.path === ".PKGINFO" || e.path.endsWith("/.PKGINFO"));
  return {
    entries: entries.length,
    files: entries.filter(e => !e.typeflag || e.typeflag === "0" || e.typeflag === "\0").length,
    dirs: entries.filter(e => e.typeflag === "5").length,
    symlinks: entries.filter(e => e.typeflag === "2").length,
    pkgInfo: info ? parseApkPkgInfo(bytesToText(info.data)) : null,
    paths: options.paths ? entries.map(e => e.path) : undefined,
  };
}

export function installPackageIndex(vfs, repositories = []) {
  vfs.mkdirp("/var/lib/xos");
  vfs.writeFile("/var/lib/xos/repositories.json", JSON.stringify(repositories, null, 2));
}
