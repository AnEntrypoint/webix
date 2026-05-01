import { VFS, VNode } from "./vfs.js";
import { stringToBytes, bytesToString } from "./util.js";

const MAGIC = "OXFS1\0\0\0";
const VERSION = 1;

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return stringToBytes(String(data ?? ""));
}

function joinPath(parent, name) {
  if (parent === "/") return `/${name}`;
  return `${parent}/${name}`;
}

export function collectVfsEntries(vfs) {
  const entries = [];
  const fileBlobs = [];
  let dataOffset = 0;
  const visit = (node, path) => {
    const base = {
      path,
      type: node.type,
      ino: node.ino,
      mode: node.mode,
      uid: node.uid,
      gid: node.gid,
      rdev: node.rdev,
      atime: node.atime,
      mtime: node.mtime,
      ctime: node.ctime,
      nlink: node.nlink ?? null,
    };
    if (node.type === "file") {
      const data = asBytes(node.data);
      entries.push({ ...base, offset: dataOffset, length: data.length });
      fileBlobs.push(data);
      dataOffset += data.length;
    } else if (node.type === "symlink") {
      entries.push({ ...base, target: node.target });
    } else if (node.type === "char") {
      entries.push({ ...base, device: node.device });
    } else {
      entries.push(base);
      const names = [...node.children.keys()].sort();
      for (const name of names) visit(node.children.get(name), joinPath(path, name));
    }
  };
  visit(vfs.root, "/");
  const data = new Uint8Array(dataOffset);
  let off = 0;
  for (const blob of fileBlobs) { data.set(blob, off); off += blob.length; }
  return { entries, data };
}

export function serializeVfsBinary(vfs) {
  const { entries, data } = collectVfsEntries(vfs);
  const meta = stringToBytes(JSON.stringify({ version: VERSION, entries }));
  const header = new Uint8Array(24);
  header.set(stringToBytes(MAGIC), 0);
  const dv = new DataView(header.buffer);
  dv.setUint32(8, VERSION, true);
  dv.setUint32(12, entries.length, true);
  dv.setUint32(16, meta.length, true);
  dv.setUint32(20, data.length, true);
  const out = new Uint8Array(header.length + meta.length + data.length);
  out.set(header, 0); out.set(meta, header.length); out.set(data, header.length + meta.length);
  return out;
}

function installNode(vfs, entry, dataBlob) {
  if (entry.path === "/") {
    vfs.root.mode = entry.mode; vfs.root.uid = entry.uid; vfs.root.gid = entry.gid;
    vfs.root.atime = entry.atime; vfs.root.mtime = entry.mtime; vfs.root.ctime = entry.ctime;
    return vfs.root;
  }
  const dirname = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";
  const basename = entry.path.substring(entry.path.lastIndexOf("/") + 1);
  const parent = vfs.mkdirp(dirname);
  let node;
  if (entry.type === "dir") node = new VNode("dir", basename, { ino: entry.ino, mode: entry.mode, time: entry.mtime, nlink: entry.nlink });
  else if (entry.type === "file") node = new VNode("file", basename, { ino: entry.ino, mode: entry.mode, data: dataBlob.subarray(entry.offset, entry.offset + entry.length).slice(), time: entry.mtime, nlink: entry.nlink });
  else if (entry.type === "symlink") node = new VNode("symlink", basename, { ino: entry.ino, mode: entry.mode, target: entry.target ?? "", time: entry.mtime, nlink: entry.nlink });
  else if (entry.type === "char") node = new VNode("char", basename, { ino: entry.ino, mode: entry.mode, rdev: entry.rdev, device: entry.device ?? "null", time: entry.mtime, nlink: entry.nlink });
  else throw new Error(`Unsupported snapshot node type ${entry.type}`);
  node.uid = entry.uid; node.gid = entry.gid; node.rdev = entry.rdev;
  node.atime = entry.atime; node.mtime = entry.mtime; node.ctime = entry.ctime;
  node.parent = parent;
  parent.children.set(basename, node);
  return node;
}

export function restoreVfsBinary(bytes, options = {}) {
  const b = asBytes(bytes);
  if (bytesToString(b.subarray(0, 8)) !== MAGIC) throw new Error("Not an OpenX86 VFS snapshot");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint32(8, true);
  if (version !== VERSION) throw new Error(`Unsupported VFS snapshot version ${version}`);
  const metaLen = dv.getUint32(16, true);
  const dataLen = dv.getUint32(20, true);
  const metaStart = 24, dataStart = metaStart + metaLen;
  const meta = JSON.parse(bytesToString(b.subarray(metaStart, dataStart)));
  const data = b.subarray(dataStart, dataStart + dataLen);
  const vfs = options.vfs ?? new VFS();
  vfs.root = new VNode("dir", "/", { ino: 1 });
  vfs.root.parent = vfs.root;
  vfs.cwd = "/";
  const entries = meta.entries.slice().sort((a, c) => a.path.length - c.path.length);
  for (const entry of entries) installNode(vfs, entry, data);
  return vfs;
}

export function serializeVfsJson(vfs) {
  const { entries, data } = collectVfsEntries(vfs);
  return JSON.stringify({ version: VERSION, entries, data: Array.from(data) });
}

export function restoreVfsJson(text, options = {}) {
  const parsed = typeof text === "string" ? JSON.parse(text) : text;
  const data = new Uint8Array(parsed.data ?? []);
  const vfs = options.vfs ?? new VFS();
  vfs.root = new VNode("dir", "/", { ino: 1 });
  vfs.root.parent = vfs.root;
  vfs.cwd = "/";
  for (const entry of parsed.entries.slice().sort((a, c) => a.path.length - c.path.length)) installNode(vfs, entry, data);
  return vfs;
}
