import { VFS, VNode, OpenFile, VFSError, O, S_IFDIR, S_IFREG, S_IFLNK, S_IFCHR } from "./vfs.js";

function bytesCopy(bytes) { return bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes ?? []); }
function dirname(path) { const i = path.lastIndexOf("/"); return i <= 0 ? "/" : path.slice(0, i); }
function basename(path) { const i = path.lastIndexOf("/"); return i < 0 ? path : path.slice(i + 1); }
function cloneNodeInto(vfs, path, source) {
  const dir = dirname(path), name = basename(path);
  vfs.mkdirp(dir);
  if (source.type === "dir") return vfs.mkdirp(path, source.mode & 0o7777);
  if (source.type === "file") return vfs.writeFile(path, bytesCopy(source.data), source.mode & 0o7777);
  if (source.type === "symlink") return vfs.symlink(source.target, path);
  if (source.type === "char") return vfs.mknod(path, source.device, source.mode & 0o7777, source.rdev);
  throw new VFSError(22, `cannot copy ${source.type}`);
}
function cloneMetadata(dst, src) {
  dst.mode = src.mode; dst.uid = src.uid; dst.gid = src.gid; dst.rdev = src.rdev;
  dst.atime = src.atime; dst.mtime = src.mtime; dst.ctime = src.ctime;
  return dst;
}
function mergeDirNode(path, upperNode, baseNode) {
  const dir = new VNode("dir", basename(path) || "/", { mode: (upperNode ?? baseNode)?.mode ?? (S_IFDIR | 0o755) });
  dir.parent = dir;
  const names = new Set();
  if (baseNode?.type === "dir") for (const name of baseNode.children.keys()) names.add(name);
  if (upperNode?.type === "dir") for (const name of upperNode.children.keys()) names.add(name);
  for (const name of names) {
    const child = upperNode?.children?.get(name) ?? baseNode?.children?.get(name);
    if (child) dir.children.set(name, child);
  }
  return dir;
}

/**
 * Writable overlay filesystem with Linux-like copy-up and whiteout semantics.
 * Base is treated as read-only. Mutations occur in upper; deleting a base entry
 * records a whiteout so it remains hidden across lookups and snapshots.
 */
export class OverlayVFS {
  constructor(base = new VFS(), upper = new VFS(), options = {}) {
    this.base = base;
    this.upper = upper;
    this.cwd = options.cwd ?? upper.cwd ?? base.cwd ?? "/";
    this.whiteouts = new Set(options.whiteouts ?? []);
    this.upper.cwd = this.base.cwd = this.cwd;
  }
  normalize(path, cwd = this.cwd) { return this.upper.normalize(path, cwd); }
  _white(path) { return this.whiteouts.has(this.normalize(path)); }
  _resolveUpper(path, opts = {}) { return this.upper._resolve(path, opts); }
  _resolveBase(path, opts = {}) { return this.base._resolve(path, opts); }
  _existsUpper(path, opts = {}) { try { return this._resolveUpper(path, opts); } catch { return null; } }
  _existsBase(path, opts = {}) { try { return this._resolveBase(path, opts); } catch { return null; } }
  _copyUp(path, opts = {}) {
    const p = this.normalize(path);
    const existing = this._existsUpper(p, { noFollowFinal: opts.noFollowFinal });
    if (existing?.node) return existing;
    if (this._white(p)) this.whiteouts.delete(p);
    const src = this._resolveBase(p, { noFollowFinal: opts.noFollowFinal });
    const node = cloneMetadata(cloneNodeInto(this.upper, p, src.node), src.node);
    return { node, path: p, parent: node.parent, name: basename(p) };
  }
  exists(path) { return !!this._lookup(path, { noFollowFinal: false, allowMissing: true })?.node; }
  _lookup(path, opts = {}) {
    const p = this.normalize(path, opts.cwd ?? this.cwd);
    if (this._white(p)) {
      if (opts.parentForCreate) return this.upper._resolve(p, opts);
      if (opts.allowMissing) return null;
      throw new VFSError(2, `${p} whiteouted`);
    }
    const up = this._existsUpper(p, opts);
    if (up?.node || opts.parentForCreate) return up;
    const bs = this._existsBase(p, opts);
    if (bs?.node) return bs;
    if (opts.allowMissing) return null;
    throw new VFSError(2, `${p} not found`);
  }
  _resolve(path, opts = {}) { return this._lookup(path, opts); }
  stat(path, opts = {}) { return this._lookup(path, opts).node.stat(); }
  lstat(path) { return this._lookup(path, { noFollowFinal: true }).node.stat(); }
  readlink(path) { const n = this._lookup(path, { noFollowFinal: true }).node; if (n.type !== "symlink") throw new VFSError(22, "not symlink"); return n.target; }
  readFile(path) { const n = this._lookup(path).node; if (n.type !== "file") throw new VFSError(21, "not file"); return n.data.slice(); }
  writeFile(path, data, mode = 0o644) { this.whiteouts.delete(this.normalize(path)); return this.upper.writeFile(path, data, mode); }
  mkdirp(path, mode = 0o755) { this.whiteouts.delete(this.normalize(path)); return this.upper.mkdirp(path, mode); }
  mkdir(path, mode = 0o755) { this.whiteouts.delete(this.normalize(path)); return this.upper.mkdir(path, mode); }
  symlink(target, path) { this.whiteouts.delete(this.normalize(path)); return this.upper.symlink(target, path); }
  mknod(path, device = "null", mode = 0o666, rdev = 0) { this.whiteouts.delete(this.normalize(path)); return this.upper.mknod(path, device, mode, rdev); }
  chmod(path, mode) { const r = this._copyUp(path, { noFollowFinal: true }); r.node.mode = (r.node.mode & 0o170000) | (mode & 0o7777); return 0; }
  chown(path, uid = -1, gid = -1) { const r = this._copyUp(path, { noFollowFinal: true }); if ((uid | 0) >= 0) r.node.uid = uid >>> 0; if ((gid | 0) >= 0) r.node.gid = gid >>> 0; return 0; }
  utimes(path, atime, mtime) { const r = this._copyUp(path, { noFollowFinal: true }); r.node.atime = atime >>> 0; r.node.mtime = mtime >>> 0; return 0; }
  truncate(path, length = 0) { this._copyUp(path); return this.upper.truncate(path, length); }
  unlink(path) { const p = this.normalize(path); try { this.upper.unlink(p); } catch (e) { if (!(e instanceof VFSError) || e.errno !== 2) throw e; } if (this._existsBase(p, { noFollowFinal: true })) this.whiteouts.add(p); }
  rmdir(path) { const p = this.normalize(path); try { this.upper.rmdir(p); } catch (e) { if (!(e instanceof VFSError) || e.errno !== 2) throw e; } if (this._existsBase(p, { noFollowFinal: true })) this.whiteouts.add(p); }
  rename(oldPath, newPath) { const src = this._copyUp(oldPath, { noFollowFinal: true }); this.whiteouts.delete(this.normalize(newPath)); this.upper.rename(src.path, newPath); if (this._existsBase(oldPath, { noFollowFinal: true })) this.whiteouts.add(this.normalize(oldPath)); }
  link(oldPath, newPath) { this._copyUp(oldPath, { noFollowFinal: true }); this.upper.link(oldPath, newPath); }
  list(path = "/") { const p = this.normalize(path); const names = new Set(); const b = this._existsBase(p); const u = this._existsUpper(p); if (b?.node?.type === "dir") for (const n of b.node.children.keys()) if (!this._white(`${p}/${n}`)) names.add(n); if (u?.node?.type === "dir") for (const n of u.node.children.keys()) names.add(n); return [...names]; }
  open(path, flags = 0, mode = 0o666) {
    const p = this.normalize(path);
    const wantWrite = (flags & O.ACCMODE) !== O.RDONLY || (flags & (O.CREAT | O.TRUNC | O.APPEND));
    if (wantWrite) {
      if (!this._existsUpper(p) && this._existsBase(p)) this._copyUp(p);
      this.whiteouts.delete(p);
      return this.upper.open(p, flags, mode);
    }
    const u = this._existsUpper(p);
    const b = this._white(p) ? null : this._existsBase(p);
    const node = u?.node?.type === "dir" || b?.node?.type === "dir" ? mergeDirNode(p, u?.node, b?.node) : (u?.node ?? b?.node);
    if (!node) throw new VFSError(2, `${p} not found`);
    if ((flags & O.DIRECTORY) && node.type !== "dir") throw new VFSError(20, "not dir");
    return new OpenFile(this, node, p, flags);
  }
  mountFiles(files, root = "/") { return this.upper.mountFiles(files, root); }
  snapshot(options = {}) { return { version: 1, cwd: this.cwd, base: this.base.snapshot(options), upper: this.upper.snapshot(options), whiteouts: [...this.whiteouts] }; }
  static fromSnapshot(snapshot) { return new OverlayVFS(VFS.fromSnapshot(snapshot.base), VFS.fromSnapshot(snapshot.upper), { cwd: snapshot.cwd, whiteouts: snapshot.whiteouts }); }
}

export function createOverlayVFS(base = new VFS(), upper = new VFS(), options = {}) { return new OverlayVFS(base, upper, options); }
