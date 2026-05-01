import { stringToBytes, nowSeconds } from "./util.js";

export const S_IFMT = 0o170000;
export const S_IFSOCK = 0o140000;
export const S_IFLNK = 0o120000;
export const S_IFREG = 0o100000;
export const S_IFBLK = 0o060000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFIFO = 0o010000;

export const O = Object.freeze({ RDONLY: 0, WRONLY: 1, RDWR: 2, ACCMODE: 3, CREAT: 0x40, EXCL: 0x80, NOCTTY: 0x100, TRUNC: 0x200, APPEND: 0x400, NONBLOCK: 0x800, DIRECTORY: 0x10000, CLOEXEC: 0x80000 });
export const O_RDONLY = O.RDONLY, O_WRONLY = O.WRONLY, O_RDWR = O.RDWR, O_CREAT = O.CREAT, O_EXCL = O.EXCL, O_TRUNC = O.TRUNC, O_APPEND = O.APPEND, O_DIRECTORY = O.DIRECTORY;

export class VFSError extends Error { constructor(errno, message) { super(message); this.errno = errno; } }
let nextIno = 1000;
function ensureBytes(data) { if (data instanceof Uint8Array) return data; if (data instanceof ArrayBuffer) return new Uint8Array(data); if (typeof data === "string") return stringToBytes(data); return new Uint8Array(data ?? []); }

export class VNode {
  constructor(type, name, options = {}) {
    this.type = type;
    this.name = name;
    this.ino = options.ino ?? nextIno++;
    this.mode = options.mode ?? (type === "dir" ? (S_IFDIR | 0o755) : type === "symlink" ? (S_IFLNK | 0o777) : type === "char" ? (S_IFCHR | 0o666) : (S_IFREG | 0o644));
    this.uid = options.uid ?? 0; this.gid = options.gid ?? 0; this.rdev = options.rdev ?? 0;
    this.atime = this.mtime = this.ctime = options.time ?? nowSeconds(); this.nlink = options.nlink ?? null;
    this.parent = null; this.children = type === "dir" ? new Map() : null;
    this.data = type === "file" ? (options.data ?? new Uint8Array(0)) : null;
    this.target = type === "symlink" ? (options.target ?? "") : null;
    this.device = type === "char" ? (options.device ?? "null") : null;
  }
  get size() { if (this.type === "file") return this.data.length; if (this.type === "symlink") return stringToBytes(this.target).length; if (this.type === "dir") return this.children.size * 32; return 0; }
  stat() { return { dev: 1, ino: this.ino, mode: this.mode, nlink: this.nlink ?? (this.type === "dir" ? 2 + this.children.size : 1), uid: this.uid, gid: this.gid, rdev: this.rdev, size: this.size, blksize: 4096, blocks: Math.ceil(this.size / 512), atime: this.atime, mtime: this.mtime, ctime: this.ctime }; }
}

export class OpenFile {
  constructor(vfs, node, path, flags = 0) { this.vfs = vfs; this.node = node; this.path = path; this.flags = flags; this.offset = (flags & O.APPEND) ? node.size : 0; this.dirOffset = 0; }
  canRead() { return (this.flags & O.ACCMODE) !== O.WRONLY; }
  canWrite() { return (this.flags & O.ACCMODE) !== O.RDONLY; }
  read(count) {
    if (!this.canRead()) throw new VFSError(9, "not readable");
    const n = this.node;
    if (n.type === "char") {
      if (n.device === "zero") return new Uint8Array(count);
      if (n.device === "random" || n.device === "urandom") { const out = new Uint8Array(count); if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(out); else for (let i = 0; i < out.length; i++) out[i] = (Math.random() * 256) | 0; return out; }
      if (n.device === "null" || n.device === "tty" || n.device === "console") return new Uint8Array(0);
      throw new VFSError(5, `device ${n.device}`);
    }
    if (n.type === "dir") throw new VFSError(21, "is directory");
    if (n.type !== "file") throw new VFSError(22, "not file");
    const end = Math.min(n.data.length, this.offset + count); const out = n.data.slice(this.offset, end); this.offset = end; n.atime = nowSeconds(); return out;
  }
  write(bytes) {
    if (!this.canWrite()) throw new VFSError(9, "not writable");
    const n = this.node; const data = ensureBytes(bytes);
    if (n.type === "char") return data.length;
    if (n.type !== "file") throw new VFSError(21, "not file");
    if (this.flags & O.APPEND) this.offset = n.data.length;
    const needed = this.offset + data.length;
    if (needed > n.data.length) { const grown = new Uint8Array(needed); grown.set(n.data); n.data = grown; }
    n.data.set(data, this.offset); this.offset += data.length; n.mtime = n.ctime = nowSeconds(); return data.length;
  }
  lseek(offset, whence) { let base; if (whence === 0) base = 0; else if (whence === 1) base = this.offset; else if (whence === 2) base = this.node.size; else throw new VFSError(22, "bad whence"); const next = base + offset; if (next < 0) throw new VFSError(22, "negative offset"); this.offset = next >>> 0; return this.offset; }
  readdir() { const n = this.node; if (n.type !== "dir") throw new VFSError(20, "not directory"); const entries = [{ name: ".", node: n }, { name: "..", node: n.parent ?? n }, ...[...n.children.entries()].map(([name, node]) => ({ name, node }))]; const out = entries.slice(this.dirOffset); this.dirOffset += out.length; return out; }
  stat() { return this.node.stat(); }
}

export class VFS {
  constructor() { this.root = new VNode("dir", "/", { ino: 1 }); this.root.parent = this.root; this.cwd = "/"; this.seedStandardTree(); }
  seedStandardTree() {
    for (const d of ["/dev", "/proc", "/proc/self", "/proc/self/fd", "/etc", "/tmp", "/home", "/home/user", "/run", "/var", "/var/tmp"]) this.mkdirp(d);
    this.mknod("/dev/null", "null", 0o666, 0x0103);
    this.mknod("/dev/zero", "zero", 0o666, 0x0105);
    this.mknod("/dev/random", "random", 0o666, 0x0108);
    this.mknod("/dev/urandom", "urandom", 0o666, 0x0109);
    this.mknod("/dev/tty", "tty", 0o666, 0x0500);
    this.mknod("/dev/console", "console", 0o600, 0x0501);
    for (const [link, target] of [["/dev/stdin", "/proc/self/fd/0"], ["/dev/stdout", "/proc/self/fd/1"], ["/dev/stderr", "/proc/self/fd/2"], ["/proc/self/fd/0", "/dev/tty"], ["/proc/self/fd/1", "/dev/tty"], ["/proc/self/fd/2", "/dev/tty"]]) { try { if (!this.exists(link)) this.symlink(target, link); } catch {} }
    this.writeFile("/etc/hosts", "127.0.0.1 localhost\n");
    this.writeFile("/etc/passwd", "root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:user:/home/user:/bin/sh\n");
    this.writeFile("/proc/cpuinfo", "processor\t: 0\nmodel name\t: CleanRoom JS IA-32 Emulator\nflags\t\t: fpu tsc cx8 cmov mmx sse sse2\n");
  }
  normalize(path, cwd = this.cwd) { if (!path) return cwd; const parts = []; const source = String(path).startsWith("/") ? String(path) : `${cwd}/${path}`; for (const part of source.split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); } return `/${parts.join("/")}`; }
  _resolve(path, opts = {}) { const normalized = this.normalize(path, opts.cwd ?? this.cwd); if (normalized === "/") return { node: this.root, path: "/", parent: null, name: "/" }; const parts = normalized.split("/").filter(Boolean); let node = this.root; let curPath = ""; for (let i = 0; i < parts.length; i++) { if (node.type !== "dir") throw new VFSError(20, `${curPath || "/"} not directory`); const name = parts[i]; const child = node.children.get(name); if (!child) { if (opts.parentForCreate && i === parts.length - 1) return { node: null, parent: node, name, path: normalized }; throw new VFSError(2, `${normalized} not found`); } curPath += `/${name}`; if (child.type === "symlink" && !(opts.noFollowFinal && i === parts.length - 1)) { const rest = parts.slice(i + 1).join("/"); const dir = curPath.substring(0, curPath.lastIndexOf("/")) || "/"; const target = child.target.startsWith("/") ? child.target : `${dir}/${child.target}`; return this._resolve(rest ? `${target}/${rest}` : target, opts); } node = child; } return { node, path: normalized, parent: node.parent, name: parts[parts.length - 1] }; }
  exists(path) { try { this._resolve(path); return true; } catch { return false; } }
  stat(path, opts = {}) { return this._resolve(path, opts).node.stat(); }
  lstat(path) { return this._resolve(path, { noFollowFinal: true }).node.stat(); }
  readlink(path) { const n = this._resolve(path, { noFollowFinal: true }).node; if (n.type !== "symlink") throw new VFSError(22, "not symlink"); return n.target; }
  mkdirp(path, mode = 0o755) { const normalized = this.normalize(path); if (normalized === "/") return this.root; let node = this.root; for (const name of normalized.split("/").filter(Boolean)) { let child = node.children.get(name); if (!child) { child = new VNode("dir", name, { mode: S_IFDIR | mode }); child.parent = node; node.children.set(name, child); } if (child.type !== "dir") throw new VFSError(20, `${name} not dir`); node = child; } return node; }
  writeFile(path, data, mode = 0o644) { const normalized = this.normalize(path); const dirname = normalized.substring(0, normalized.lastIndexOf("/")) || "/"; const basename = normalized.substring(normalized.lastIndexOf("/") + 1); const dir = this.mkdirp(dirname); let node = dir.children.get(basename); if (!node) { node = new VNode("file", basename, { mode: S_IFREG | mode, data: ensureBytes(data) }); node.parent = dir; dir.children.set(basename, node); } else { if (node.type !== "file") throw new VFSError(21, "not file"); node.data = ensureBytes(data); node.mtime = node.ctime = nowSeconds(); } return node; }
  readFile(path) { const node = this._resolve(path).node; if (node.type !== "file") throw new VFSError(21, "not file"); return node.data.slice(); }
  symlink(target, path) { const normalized = this.normalize(path); const dirname = normalized.substring(0, normalized.lastIndexOf("/")) || "/"; const basename = normalized.substring(normalized.lastIndexOf("/") + 1); const dir = this.mkdirp(dirname); const node = new VNode("symlink", basename, { target }); node.parent = dir; dir.children.set(basename, node); return node; }
  mknod(path, device = "null", mode = 0o666, rdev = 0) { const normalized = this.normalize(path); const dirname = normalized.substring(0, normalized.lastIndexOf("/")) || "/"; const basename = normalized.substring(normalized.lastIndexOf("/") + 1); const dir = this.mkdirp(dirname); const node = new VNode("char", basename, { device, mode: S_IFCHR | mode, rdev }); node.parent = dir; dir.children.set(basename, node); return node; }
  unlink(path) { const r = this._resolve(path, { noFollowFinal: true }); if (!r.parent) throw new VFSError(16, "root"); if (r.node.type === "dir") throw new VFSError(21, "dir"); r.parent.children.delete(r.name); if (r.node.nlink) r.node.nlink = Math.max(0, r.node.nlink - 1); r.node.ctime = nowSeconds(); }
  mkdir(path, mode = 0o755) { const c = this._resolve(path, { parentForCreate: true }); if (c.node) throw new VFSError(17, "exists"); const node = new VNode("dir", c.name, { mode: S_IFDIR | (mode & 0o777) }); node.parent = c.parent; c.parent.children.set(c.name, node); c.parent.mtime = c.parent.ctime = nowSeconds(); return node; }
  rmdir(path) { const r = this._resolve(path, { noFollowFinal: true }); if (!r.parent) throw new VFSError(16, "root"); if (r.node.type !== "dir") throw new VFSError(20, "not dir"); if (r.node.children.size) throw new VFSError(39, "not empty"); r.parent.children.delete(r.name); r.parent.mtime = r.parent.ctime = nowSeconds(); }
  rename(oldPath, newPath) { const src = this._resolve(oldPath, { noFollowFinal: true }); if (!src.parent) throw new VFSError(16, "root"); const dst = this._resolve(newPath, { parentForCreate: true, noFollowFinal: true }); if (dst.node && dst.node.type === "dir" && dst.node.children?.size) throw new VFSError(39, "not empty"); src.parent.children.delete(src.name); src.node.name = dst.name; src.node.parent = dst.parent; dst.parent.children.set(dst.name, src.node); const t = nowSeconds(); src.parent.mtime = src.parent.ctime = dst.parent.mtime = dst.parent.ctime = src.node.ctime = t; }
  link(oldPath, newPath) { const src = this._resolve(oldPath).node; if (src.type === "dir") throw new VFSError(1, "hard link to directory"); const dst = this._resolve(newPath, { parentForCreate: true }); if (dst.node) throw new VFSError(17, "exists"); src.nlink = (src.nlink ?? 1) + 1; src.ctime = nowSeconds(); dst.parent.children.set(dst.name, src); return src; }
  chmod(path, mode) { const n = this._resolve(path, { noFollowFinal: false }).node; n.mode = (n.mode & S_IFMT) | (mode & 0o7777); n.ctime = nowSeconds(); }
  chown(path, uid = -1, gid = -1, opts = {}) { const n = this._resolve(path, { noFollowFinal: !!opts.noFollow }).node; if ((uid | 0) !== -1) n.uid = uid >>> 0; if ((gid | 0) !== -1) n.gid = gid >>> 0; n.ctime = nowSeconds(); }
  utimes(path, atime = nowSeconds(), mtime = atime, opts = {}) { const n = this._resolve(path, { noFollowFinal: !!opts.noFollow }).node; n.atime = atime | 0; n.mtime = mtime | 0; n.ctime = nowSeconds(); }
  truncate(path, length = 0) { const n = this._resolve(path).node; if (n.type !== "file") throw new VFSError(22, "not file"); length >>>= 0; if (length < n.data.length) n.data = n.data.slice(0, length); else if (length > n.data.length) { const grown = new Uint8Array(length); grown.set(n.data); n.data = grown; } n.mtime = n.ctime = nowSeconds(); }
  open(path, flags = 0, mode = 0o666) { let resolved; let created = false; try { resolved = this._resolve(path); } catch (e) { if (e instanceof VFSError && e.errno === 2 && (flags & O.CREAT)) { const c = this._resolve(path, { parentForCreate: true }); const node = new VNode("file", c.name, { mode: S_IFREG | (mode & 0o777), data: new Uint8Array(0) }); node.parent = c.parent; c.parent.children.set(c.name, node); resolved = { node, path: c.path }; created = true; } else throw e; } const n = resolved.node; if (!created && (flags & O.EXCL) && (flags & O.CREAT)) throw new VFSError(17, "exists"); if ((flags & O.DIRECTORY) && n.type !== "dir") throw new VFSError(20, "not dir"); if ((flags & O.TRUNC) && n.type === "file" && ((flags & O.ACCMODE) !== O.RDONLY)) n.data = new Uint8Array(0); return new OpenFile(this, n, resolved.path, flags); }
  mountFiles(files, root = "/") { for (const [path, data] of Object.entries(files)) this.writeFile(this.normalize(path, root), data); }
  list(path = "/") { const n = this._resolve(path).node; if (n.type !== "dir") throw new VFSError(20, "not dir"); return [...n.children.keys()]; }
}

// Compatibility names for device modules and higher-level runtime exports.
export const MemFS = VFS;
export const FileHandle = OpenFile;
export function makeDefaultVFS() { return new VFS(); }

// Snapshot, mutation, and watch support. This is appended as prototype methods so the
// compact baseline VFS stays readable while still gaining production-oriented behavior.
const _vfsEncoder = new TextEncoder();
const _vfsDecoder = new TextDecoder();
const _vfsMagic = "OXVFS1\n";
function _vfsB64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}
function _vfsFromB64(s) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
function _vfsWalk(node, path, out) {
  if (path !== "/") {
    const rec = { path, type: node.type, mode: node.mode, uid: node.uid, gid: node.gid, rdev: node.rdev, atime: node.atime, mtime: node.mtime, ctime: node.ctime, ino: node.ino };
    if (node.type === "file") rec.data = _vfsB64(node.data);
    if (node.type === "symlink") rec.target = node.target;
    if (node.type === "char") rec.device = node.device;
    out.push(rec);
  }
  if (node.type === "dir") for (const [name, child] of node.children) _vfsWalk(child, path === "/" ? `/${name}` : `${path}/${name}`, out);
}
function _vfsTouchParents(vfs, path, type) {
  if (!vfs._watchers) return;
  const normalized = vfs.normalize(path);
  for (const [prefix, callbacks] of vfs._watchers) {
    if (normalized === prefix || normalized.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) {
      for (const cb of callbacks) queueMicrotask(() => cb({ type, path: normalized }));
    }
  }
}
VFS.prototype.watch = function watch(path, callback) {
  if (!this._watchers) this._watchers = new Map();
  const p = this.normalize(path);
  if (!this._watchers.has(p)) this._watchers.set(p, new Set());
  this._watchers.get(p).add(callback);
  return () => this._watchers.get(p)?.delete(callback);
};
VFS.prototype.snapshot = function snapshot(options = {}) {
  const entries = [];
  _vfsWalk(this.root, "/", entries);
  const payload = { version: 1, cwd: this.cwd, nextIno, entries };
  if (options.binary) return _vfsEncoder.encode(_vfsMagic + JSON.stringify(payload));
  return payload;
};
VFS.fromSnapshot = function fromSnapshot(snapshot) {
  let payload = snapshot;
  if (snapshot instanceof Uint8Array || snapshot instanceof ArrayBuffer) {
    const text = _vfsDecoder.decode(snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot));
    if (!text.startsWith(_vfsMagic)) throw new Error("Bad VFS snapshot magic");
    payload = JSON.parse(text.slice(_vfsMagic.length));
  } else if (typeof snapshot === "string") {
    payload = JSON.parse(snapshot.startsWith(_vfsMagic) ? snapshot.slice(_vfsMagic.length) : snapshot);
  }
  const vfs = new VFS();
  vfs.root.children.clear();
  for (const rec of payload.entries ?? []) {
    if (rec.type === "dir") vfs.mkdirp(rec.path, rec.mode & 0o777);
    else if (rec.type === "file") vfs.writeFile(rec.path, _vfsFromB64(rec.data ?? ""), rec.mode & 0o777);
    else if (rec.type === "symlink") vfs.symlink(rec.target ?? "", rec.path);
    else if (rec.type === "char") vfs.mknod(rec.path, rec.device ?? "null", rec.mode & 0o777, rec.rdev ?? 0);
    const node = vfs._resolve(rec.path, { noFollowFinal: true }).node;
    node.mode = rec.mode; node.uid = rec.uid ?? 0; node.gid = rec.gid ?? 0; node.rdev = rec.rdev ?? node.rdev;
    node.atime = rec.atime ?? nowSeconds(); node.mtime = rec.mtime ?? nowSeconds(); node.ctime = rec.ctime ?? nowSeconds();
    if (rec.ino) node.ino = rec.ino;
  }
  vfs.cwd = payload.cwd ?? "/";
  return vfs;
};
VFS.prototype.loadSnapshot = function loadSnapshot(snapshot) {
  const restored = VFS.fromSnapshot(snapshot);
  this.root = restored.root;
  this.cwd = restored.cwd;
  return this;
};
VFS.prototype.rename = function rename(oldPath, newPath) {
  const old = this._resolve(oldPath, { noFollowFinal: true });
  if (!old.parent) throw new VFSError(16, "root");
  const target = this._resolve(newPath, { parentForCreate: true, noFollowFinal: true });
  if (target.node && target.node.type === "dir" && old.node.type !== "dir") throw new VFSError(21, "target dir");
  old.parent.children.delete(old.name);
  old.node.name = target.name; old.node.parent = target.parent; old.node.ctime = nowSeconds();
  target.parent.children.set(target.name, old.node);
  _vfsTouchParents(this, old.path, "rename"); _vfsTouchParents(this, target.path, "rename");
};
VFS.prototype.mkdir = function mkdir(path, mode = 0o755) {
  const r = this._resolve(path, { parentForCreate: true });
  if (r.node) throw new VFSError(17, "exists");
  const n = new VNode("dir", r.name, { mode: S_IFDIR | (mode & 0o777) });
  n.parent = r.parent; r.parent.children.set(r.name, n); _vfsTouchParents(this, r.path, "mkdir"); return n;
};
VFS.prototype.rmdir = function rmdir(path) {
  const r = this._resolve(path, { noFollowFinal: true });
  if (r.node.type !== "dir") throw new VFSError(20, "not dir");
  if (!r.parent || r.node.children.size) throw new VFSError(r.parent ? 39 : 16, "not empty");
  r.parent.children.delete(r.name); _vfsTouchParents(this, r.path, "rmdir");
};
VFS.prototype.chmod = function chmod(path, mode) {
  const r = this._resolve(path, { noFollowFinal: true });
  r.node.mode = (r.node.mode & S_IFMT) | (mode & 0o7777); r.node.ctime = nowSeconds(); _vfsTouchParents(this, r.path, "chmod");
};
VFS.prototype.chown = function chown(path, uid, gid) {
  const r = this._resolve(path, { noFollowFinal: true });
  if ((uid | 0) >= 0) r.node.uid = uid >>> 0;
  if ((gid | 0) >= 0) r.node.gid = gid >>> 0;
  r.node.ctime = nowSeconds(); _vfsTouchParents(this, r.path, "chown");
};
VFS.prototype.truncate = function truncate(path, length) {
  const r = this._resolve(path);
  if (r.node.type !== "file") throw new VFSError(21, "not file");
  length >>>= 0;
  const out = new Uint8Array(length); out.set(r.node.data.subarray(0, Math.min(length, r.node.data.length))); r.node.data = out;
  r.node.mtime = r.node.ctime = nowSeconds(); _vfsTouchParents(this, r.path, "truncate");
};
VFS.prototype.utimes = function utimes(path, atime, mtime) {
  const r = this._resolve(path, { noFollowFinal: true });
  r.node.atime = atime >>> 0; r.node.mtime = mtime >>> 0; r.node.ctime = nowSeconds(); _vfsTouchParents(this, r.path, "utimes");
};
VFS.prototype.link = function link(oldPath, newPath) {
  const old = this._resolve(oldPath, { noFollowFinal: true });
  if (old.node.type === "dir") throw new VFSError(1, "dir hardlink");
  const target = this._resolve(newPath, { parentForCreate: true, noFollowFinal: true });
  if (target.node) throw new VFSError(17, "exists");
  target.parent.children.set(target.name, old.node); _vfsTouchParents(this, target.path, "link");
};
