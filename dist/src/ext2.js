import { BufferBlockDevice } from "./devices.js";
import { bytesToString } from "./util.js";

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function asBytes(data) { return data instanceof Uint8Array ? data : new Uint8Array(data); }
function norm(path) {
  const parts = [];
  for (const p of String(path || "/").split("/")) { if (!p || p === ".") continue; if (p === "..") parts.pop(); else parts.push(p); }
  return `/${parts.join("/")}`;
}
function join(root, child) { const r = norm(root); const c = norm(child); return r === "/" ? c : norm(`${r}/${c.slice(1)}`); }

export class Ext2Error extends Error {}

/** Minimal clean-room read-only ext2 reader for regular files, directories, and symlinks. */
export class Ext2ImageFS {
  constructor(device, options = {}) {
    this.device = device?.read ? device : new BufferBlockDevice(asBytes(device));
    this.cache = new Map();
    this.ready = this._init(options);
  }

  async _read(offset, length) { return this.device.read(offset, length); }

  async _init() {
    const sb = await this._read(1024, 1024);
    if (u16(sb, 56) !== 0xef53) throw new Ext2Error("Not an ext2 filesystem image");
    this.super = {
      inodes: u32(sb, 0), blocks: u32(sb, 4), firstDataBlock: u32(sb, 20),
      logBlockSize: u32(sb, 24), blocksPerGroup: u32(sb, 32), inodesPerGroup: u32(sb, 40),
      magic: u16(sb, 56), firstInode: u32(sb, 84) || 11, inodeSize: u16(sb, 88) || 128,
    };
    this.blockSize = 1024 << this.super.logBlockSize;
    this.groupCount = Math.ceil(this.super.blocks / this.super.blocksPerGroup);
    const gdOffset = this.blockSize === 1024 ? 2048 : this.blockSize;
    this.groups = [];
    const gd = await this._read(gdOffset, this.groupCount * 32);
    for (let i = 0; i < this.groupCount; i++) {
      const o = i * 32;
      this.groups.push({ blockBitmap: u32(gd, o), inodeBitmap: u32(gd, o + 4), inodeTable: u32(gd, o + 8) });
    }
  }

  async readBlock(blockNo) {
    if (blockNo === 0) return new Uint8Array(this.blockSize);
    return this._read(blockNo * this.blockSize, this.blockSize);
  }

  async inode(ino) {
    await this.ready;
    if (this.cache.has(ino)) return this.cache.get(ino);
    const group = Math.floor((ino - 1) / this.super.inodesPerGroup);
    const index = (ino - 1) % this.super.inodesPerGroup;
    const table = this.groups[group]?.inodeTable;
    if (!table) throw new Ext2Error(`inode ${ino} has no group table`);
    const raw = await this._read(table * this.blockSize + index * this.super.inodeSize, this.super.inodeSize);
    const i = {
      ino, mode: u16(raw, 0), uid: u16(raw, 2), size: u32(raw, 4), atime: u32(raw, 8), ctime: u32(raw, 12), mtime: u32(raw, 16),
      gid: u16(raw, 24), links: u16(raw, 26), blocks512: u32(raw, 28), flags: u32(raw, 32), block: [], raw,
    };
    for (let n = 0; n < 15; n++) i.block.push(u32(raw, 40 + n * 4));
    // ext2 revision 1 stores high file size for regular files at dir_acl.
    const highSize = u32(raw, 108);
    if ((i.mode & 0xf000) === 0x8000 && highSize) i.size = Number((BigInt(highSize) << 32n) | BigInt(i.size));
    this.cache.set(ino, i);
    return i;
  }

  isDir(inode) { return (inode.mode & 0xf000) === 0x4000; }
  isFile(inode) { return (inode.mode & 0xf000) === 0x8000; }
  isSymlink(inode) { return (inode.mode & 0xf000) === 0xa000; }

  async _blockNumbers(inode) {
    const blocks = [];
    const ptrsPerBlock = this.blockSize / 4;
    for (let i = 0; i < 12; i++) if (inode.block[i]) blocks.push(inode.block[i]);
    if (inode.block[12]) {
      const indirect = await this.readBlock(inode.block[12]);
      for (let o = 0; o < indirect.length; o += 4) { const b = u32(indirect, o); if (b) blocks.push(b); }
    }
    if (inode.block[13]) {
      const dbl = await this.readBlock(inode.block[13]);
      for (let o = 0; o < dbl.length; o += 4) {
        const indBlock = u32(dbl, o); if (!indBlock) continue;
        const indirect = await this.readBlock(indBlock);
        for (let j = 0; j < ptrsPerBlock * 4; j += 4) { const b = u32(indirect, j); if (b) blocks.push(b); }
      }
    }
    return blocks;
  }

  async readInodeData(inode) {
    if (this.isSymlink(inode) && inode.size <= 60) return inode.raw.subarray(40, 40 + inode.size);
    const out = new Uint8Array(inode.size);
    let pos = 0;
    for (const blockNo of await this._blockNumbers(inode)) {
      if (pos >= out.length) break;
      const block = await this.readBlock(blockNo);
      const n = Math.min(block.length, out.length - pos);
      out.set(block.subarray(0, n), pos);
      pos += n;
    }
    return out;
  }

  async readdirInode(inode) {
    if (!this.isDir(inode)) throw new Ext2Error("Not a directory");
    const data = await this.readInodeData(inode);
    const entries = [];
    let off = 0;
    while (off + 8 <= data.length) {
      const ino = u32(data, off), recLen = u16(data, off + 4), nameLen = data[off + 6], fileType = data[off + 7];
      if (recLen < 8) break;
      if (ino !== 0 && nameLen > 0) entries.push({ ino, name: bytesToString(data.subarray(off + 8, off + 8 + nameLen)), fileType });
      off += recLen;
    }
    return entries;
  }

  async resolve(path, follow = true, depth = 0) {
    await this.ready;
    if (depth > 16) throw new Ext2Error("Too many symlinks");
    const parts = norm(path).split("/").filter(Boolean);
    let inode = await this.inode(2);
    let cur = "/";
    for (let idx = 0; idx < parts.length; idx++) {
      const name = parts[idx];
      const entry = (await this.readdirInode(inode)).find(e => e.name === name);
      if (!entry) throw new Ext2Error(`${cur}${name} not found`);
      inode = await this.inode(entry.ino);
      cur = norm(`${cur}/${name}`);
      const shouldFollow = this.isSymlink(inode) && (follow || idx < parts.length - 1);
      if (shouldFollow) {
        const target = bytesToString(await this.readInodeData(inode));
        const rest = parts.slice(idx + 1).join("/");
        const base = cur.substring(0, cur.lastIndexOf("/")) || "/";
        const next = target.startsWith("/") ? target : `${base}/${target}`;
        return this.resolve(rest ? `${next}/${rest}` : next, follow, depth + 1);
      }
    }
    return inode;
  }

  async readFile(path) {
    const inode = await this.resolve(path, true);
    if (!this.isFile(inode) && !this.isSymlink(inode)) throw new Ext2Error(`${path} is not a regular file`);
    return this.readInodeData(inode);
  }

  async list(path = "/") {
    const inode = await this.resolve(path, true);
    return (await this.readdirInode(inode)).map(e => e.name).filter(n => n !== "." && n !== "..");
  }

  async mountTo(vfs, root = "/", options = {}) {
    const maxFiles = options.maxFiles ?? 10000;
    let count = 0;
    const copyDir = async (inode, outPath) => {
      if (++count > maxFiles) throw new Ext2Error(`mount limit exceeded (${maxFiles})`);
      vfs.mkdirp(outPath);
      for (const e of await this.readdirInode(inode)) {
        if (e.name === "." || e.name === "..") continue;
        const child = await this.inode(e.ino);
        const childPath = join(outPath, e.name);
        if (this.isDir(child)) await copyDir(child, childPath);
        else if (this.isSymlink(child)) vfs.symlink(bytesToString(await this.readInodeData(child)), childPath);
        else if (this.isFile(child)) vfs.writeFile(childPath, await this.readInodeData(child), child.mode & 0o777);
      }
    };
    await this.ready;
    await copyDir(await this.inode(2), root);
    return vfs;
  }
}
