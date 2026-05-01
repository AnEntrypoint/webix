import { stringToBytes } from "./util.js";

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data ?? []);
}
function bytesToString(bytes) {
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(0, end));
}
function parseOctal(bytes) {
  const raw = bytesToString(bytes).replace(/\0.*$/, "").trim();
  if (!raw) return 0;
  return parseInt(raw, 8) || 0;
}
function norm(path) {
  const parts = [];
  for (const p of String(path || "/").split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop(); else parts.push(p);
  }
  return `/${parts.join("/")}`;
}
function join(root, path) {
  const r = norm(root || "/"), p = norm(path || "/");
  if (r === "/") return p;
  if (p === "/") return r;
  return norm(`${r}/${p.slice(1)}`);
}
function isGzip(bytes) { return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; }
function dirname(path) { const i = path.lastIndexOf("/"); return i <= 0 ? "/" : path.slice(0, i); }
function basename(path) { const i = path.lastIndexOf("/"); return i < 0 ? path : path.slice(i + 1); }
function deviceNameFromPath(path) {
  if (path === "/dev/null") return "null";
  if (path === "/dev/zero") return "zero";
  if (path === "/dev/random") return "random";
  if (path === "/dev/urandom") return "urandom";
  if (path === "/dev/tty" || path === "/dev/console") return "tty";
  return "device";
}

export { bytesToString };

export async function gunzipBytes(data) {
  const bytes = asBytes(data);
  if (!isGzip(bytes)) return bytes;
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error("gzip rootfs support requires DecompressionStream in this entrypoint; Node >=18 and modern browsers provide it");
}

export function parseTarEntries(tarBytes) {
  const bytes = asBytes(tarBytes);
  const entries = [];
  let pendingLongName = null;
  let pendingLongLink = null;
  for (let off = 0; off + 512 <= bytes.length;) {
    const header = bytes.subarray(off, off + 512);
    let empty = true;
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { empty = false; break; }
    if (empty) break;
    let name = bytesToString(header.subarray(0, 100));
    const mode = parseOctal(header.subarray(100, 108)) || 0o644;
    const uid = parseOctal(header.subarray(108, 116));
    const gid = parseOctal(header.subarray(116, 124));
    const size = parseOctal(header.subarray(124, 136));
    const mtime = parseOctal(header.subarray(136, 148));
    const checksum = parseOctal(header.subarray(148, 156));
    const typeflag = String.fromCharCode(header[156] || 0);
    let linkname = bytesToString(header.subarray(157, 257));
    const magic = bytesToString(header.subarray(257, 263));
    const uname = bytesToString(header.subarray(265, 297));
    const gname = bytesToString(header.subarray(297, 329));
    const devmajor = parseOctal(header.subarray(329, 337));
    const devminor = parseOctal(header.subarray(337, 345));
    const prefix = bytesToString(header.subarray(345, 500));
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    const data = bytes.subarray(dataStart, Math.min(dataEnd, bytes.length));

    if (typeflag === "L") { pendingLongName = bytesToString(data); off = dataStart + Math.ceil(size / 512) * 512; continue; }
    if (typeflag === "K") { pendingLongLink = bytesToString(data); off = dataStart + Math.ceil(size / 512) * 512; continue; }
    if (pendingLongName) { name = pendingLongName; pendingLongName = null; }
    else if (prefix) name = `${prefix}/${name}`;
    if (pendingLongLink) { linkname = pendingLongLink; pendingLongLink = null; }

    let computed = 0;
    for (let i = 0; i < 512; i++) computed += (i >= 148 && i < 156) ? 0x20 : header[i];
    const path = norm(name);
    entries.push({ path, mode, uid, gid, size, mtime, checksum, checksumValid: !checksum || checksum === computed, typeflag, linkname, magic, uname, gname, devmajor, devminor, data });
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function mountTar(vfs, tarBytes, options = {}) {
  const root = options.root ?? "/";
  const entries = parseTarEntries(tarBytes);
  const deferredHardlinks = [];
  let count = 0;
  const stripMeta = options.stripPackageMetadata ?? false;
  for (const e of entries) {
    if (stripMeta && (e.path === "/.PKGINFO" || e.path === "/.SIGN" || e.path.startsWith("/.INSTALL"))) continue;
    const target = join(root, e.path);
    const mode = e.mode & 0o7777;
    const type = e.typeflag || "0";
    try {
      if (type === "5") vfs.mkdirp(target, mode || 0o755);
      else if (type === "2") { vfs.mkdirp(dirname(target)); vfs.symlink(e.linkname, target); }
      else if (type === "1") deferredHardlinks.push([e.linkname, target, mode]);
      else if (type === "3" || type === "4") { vfs.mkdirp(dirname(target)); vfs.mknod(target, deviceNameFromPath(target), mode || 0o666, ((e.devmajor & 0xfff) << 8) | (e.devminor & 0xff)); }
      else if (type === "6") { vfs.mkdirp(dirname(target)); vfs.mknod(target, "fifo", mode || 0o666, 0); }
      else if (type === "0" || type === "\0" || type === "") { vfs.mkdirp(dirname(target)); vfs.writeFile(target, e.data.slice(), mode || 0o644); }
      else { options.onUnsupported?.(e, target); continue; }
      const node = vfs._resolve(target, { noFollowFinal: true }).node;
      node.uid = e.uid >>> 0; node.gid = e.gid >>> 0;
      if (e.mtime) node.atime = node.mtime = node.ctime = e.mtime >>> 0;
      count++;
      options.onEntry?.({ ...e, mountedPath: target, index: count, total: entries.length });
    } catch (err) {
      if (!options.ignoreErrors) throw err;
      options.onError?.(err, e);
    }
  }
  for (const [src, dst, mode] of deferredHardlinks) {
    try {
      const srcPath = join(root, src);
      if (typeof vfs.link === "function") vfs.link(srcPath, dst);
      else vfs.writeFile(dst, vfs.readFile(srcPath), mode || 0o644);
      count++;
    } catch (err) { if (!options.ignoreErrors) throw err; options.onError?.(err, { path: dst, linkname: src, typeflag: "1" }); }
  }
  return { count, entries };
}
export async function mountTarGz(vfs, data, options = {}) { return mountTar(vfs, await gunzipBytes(data), options); }

export function createTar(files) {
  const chunks = [];
  const enc = new TextEncoder();
  const asU8 = v => typeof v === "string" ? stringToBytes(v) : asBytes(v);
  const writeString = (buf, off, len, s) => buf.set(enc.encode(s).subarray(0, len), off);
  const writeOctal = (buf, off, len, n) => writeString(buf, off, len, n.toString(8).padStart(len - 1, "0").slice(-(len - 1)) + "\0");
  for (const [path, spec] of Object.entries(files)) {
    const isSpec = spec && typeof spec === "object" && !(spec instanceof Uint8Array) && !(spec instanceof ArrayBuffer) && !ArrayBuffer.isView(spec);
    const content = isSpec ? (spec.data ?? "") : spec;
    const mode = isSpec ? (spec.mode ?? 0o644) : 0o644;
    const type = isSpec && spec.type ? spec.type : "0";
    const data = type === "5" ? new Uint8Array(0) : asU8(content);
    const h = new Uint8Array(512), p = path.replace(/^\/+/, "");
    writeString(h, 0, 100, p); writeOctal(h, 100, 8, mode); writeOctal(h, 108, 8, isSpec ? (spec.uid ?? 0) : 0); writeOctal(h, 116, 8, isSpec ? (spec.gid ?? 0) : 0); writeOctal(h, 124, 12, data.length); writeOctal(h, 136, 12, isSpec ? (spec.mtime ?? Math.floor(Date.now() / 1000)) : Math.floor(Date.now() / 1000));
    for (let i = 148; i < 156; i++) h[i] = 0x20;
    h[156] = type.charCodeAt(0); if (isSpec && spec.linkname) writeString(h, 157, 100, spec.linkname);
    writeString(h, 257, 6, "ustar"); writeString(h, 263, 2, "00");
    let sum = 0; for (const b of h) sum += b;
    writeString(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
    chunks.push(h, data); const pad = (512 - (data.length % 512)) % 512; if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
