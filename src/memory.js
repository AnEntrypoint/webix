import { alignDown, alignUp, hex32 } from "./util.js";

export class MemoryFault extends Error {
  constructor(addr, op = "access") {
    super(`Memory ${op} fault at ${hex32(addr)}`);
    this.addr = addr >>> 0;
    this.op = op;
  }
}

export const PERM = Object.freeze({ NONE: 0, R: 1, W: 2, X: 4, RW: 3, RX: 5, RWX: 7 });

function permFrom(value) {
  if (typeof value === "number") return value;
  let p = 0;
  if ((value ?? "").includes("r")) p |= PERM.R;
  if ((value ?? "").includes("w")) p |= PERM.W;
  if ((value ?? "").includes("x")) p |= PERM.X;
  return p;
}
function permText(p) { return `${p & PERM.R ? "r" : "-"}${p & PERM.W ? "w" : "-"}${p & PERM.X ? "x" : "-"}`; }

class Page {
  constructor(size, perm = PERM.RW) {
    this.data = new Uint8Array(size);
    this.perm = permFrom(perm);
    this.dirty = false;
    this.shared = false;
    this.refCount = 1;
  }
  get perms() { return permText(this.perm); }
  set perms(v) { this.perm = permFrom(v); }
}

export class PagedMemory {
  constructor(options = {}) {
    this.pageSize = options.pageSize ?? 4096;
    if ((this.pageSize & (this.pageSize - 1)) !== 0) throw new Error("pageSize must be power of two");
    this.pageShift = Math.log2(this.pageSize) | 0;
    this.pageMask = this.pageSize - 1;
    this.pages = new Map();
    this.nameMap = new Map();
    this.onWrite = options.onWrite ?? null;
    this.nextMmap = options.nextMmap ?? 0x70000000;
  }

  _pageNo(addr) { return (addr >>> this.pageShift) >>> 0; }
  _getPage(addr, need = PERM.R, op = "read") {
    const p = this.pages.get(this._pageNo(addr));
    if (!p || (p.perm & need) !== need) throw new MemoryFault(addr, op);
    return p;
  }

  isMapped(addr) { return this.pages.has(this._pageNo(addr)); }
  isRangeMapped(addr, length) {
    if (length <= 0) return true;
    const start = alignDown(addr >>> 0, this.pageSize), end = alignUp((addr + length) >>> 0, this.pageSize);
    for (let a = start; a !== end; a = (a + this.pageSize) >>> 0) if (!this.isMapped(a)) return false;
    return true;
  }

  map(addr, length, perm = PERM.RW, name = "") {
    if (length <= 0) return addr >>> 0;
    perm = permFrom(perm);
    const start = alignDown(addr >>> 0, this.pageSize);
    const end = alignUp(((addr >>> 0) + length) >>> 0, this.pageSize);
    for (let p = this._pageNo(start); p < this._pageNo(end); p++) {
      if (!this.pages.has(p)) this.pages.set(p, new Page(this.pageSize, perm));
      else this.pages.get(p).perm = perm;
      if (name) this.nameMap.set(p, name);
    }
    return start >>> 0;
  }

  mmap(length, options = {}) {
    const size = alignUp(length >>> 0, this.pageSize);
    const fixed = options.fixed ?? false;
    let addr = options.addr >>> 0;
    if (!fixed || addr === 0) {
      this.nextMmap = alignDown((this.nextMmap - size - this.pageSize) >>> 0, this.pageSize);
      addr = this.nextMmap >>> 0;
    } else {
      addr = alignDown(addr, this.pageSize);
      this.unmap(addr, size, { ignoreMissing: true });
    }
    this.map(addr, size, options.perm ?? options.perms ?? PERM.RW, options.name ?? "[mmap]");
    return addr >>> 0;
  }

  unmap(addr, length, options = {}) {
    if (length <= 0) return;
    const start = alignDown(addr >>> 0, this.pageSize), end = alignUp(((addr >>> 0) + length) >>> 0, this.pageSize);
    for (let p = this._pageNo(start); p < this._pageNo(end); p++) {
      if (!this.pages.has(p) && !options.ignoreMissing) throw new MemoryFault((p * this.pageSize) >>> 0, "unmap");
      this.pages.delete(p); this.nameMap.delete(p);
    }
  }

  protect(addr, length, perm) { return this.mprotect(addr, length, perm); }
  mprotect(addr, length, perm) {
    perm = permFrom(perm);
    const start = alignDown(addr >>> 0, this.pageSize), end = alignUp(((addr >>> 0) + length) >>> 0, this.pageSize);
    for (let p = this._pageNo(start); p < this._pageNo(end); p++) {
      const page = this.pages.get(p);
      if (!page) throw new MemoryFault((p * this.pageSize) >>> 0, "mprotect");
      page.perm = perm;
    }
  }

  findFreeRegion(length, options = {}) {
    const align = options.align ?? this.pageSize;
    const min = alignUp(options.min ?? 0x10000000, align);
    const max = alignDown(options.max ?? 0xefff0000, align);
    const pagesNeeded = Math.ceil(length / this.pageSize);
    const step = Math.max(align, this.pageSize);
    for (let addr = min >>> 0; addr < max; addr = (addr + step) >>> 0) {
      const pn = this._pageNo(addr);
      let ok = true;
      for (let i = 0; i < pagesNeeded; i++) if (this.pages.has(pn + i)) { ok = false; break; }
      if (ok) return addr >>> 0;
    }
    throw new MemoryFault(min, "mmap-no-space");
  }

  read8(addr) { addr >>>= 0; return this._getPage(addr, PERM.R, "read").data[addr & this.pageMask]; }
  read8exec(addr) { addr >>>= 0; const p = this.pages.get(this._pageNo(addr)); if (!p || ((p.perm & (PERM.X | PERM.R)) === 0)) throw new MemoryFault(addr, "exec"); return p.data[addr & this.pageMask]; }
  read16(addr) { return this.read8(addr) | (this.read8((addr + 1) >>> 0) << 8); }
  read16s(addr) { const v = this.read16(addr); return v & 0x8000 ? v - 0x10000 : v; }
  read32(addr) { return (this.read8(addr) | (this.read8((addr + 1) >>> 0) << 8) | (this.read8((addr + 2) >>> 0) << 16) | (this.read8((addr + 3) >>> 0) << 24)) >>> 0; }
  read32s(addr) { return this.read32(addr) >> 0; }

  write8(addr, value) {
    addr >>>= 0;
    let p = this._getPage(addr, PERM.W, "write");
    if (p.shared && p.refCount > 1) {
      const cp = new Page(this.pageSize, p.perm);
      cp.data.set(p.data);
      cp.dirty = p.dirty;
      p.refCount--;
      if (p.refCount <= 1) p.shared = false;
      this.pages.set(this._pageNo(addr), cp);
      p = cp;
    }
    p.data[addr & this.pageMask] = value & 0xff;
    p.dirty = true;
    if (this.onWrite) this.onWrite(addr, 1);
  }
  write16(addr, value) { this.write8(addr, value); this.write8((addr + 1) >>> 0, value >>> 8); }
  write32(addr, value) { value >>>= 0; this.write8(addr, value); this.write8((addr + 1) >>> 0, value >>> 8); this.write8((addr + 2) >>> 0, value >>> 16); this.write8((addr + 3) >>> 0, value >>> 24); }
  forceWrite8(addr, value) { addr >>>= 0; const p = this.pages.get(this._pageNo(addr)); if (!p) throw new MemoryFault(addr, "force-write"); p.data[addr & this.pageMask] = value & 0xff; p.dirty = true; if (this.onWrite) this.onWrite(addr, 1); }
  forceWrite16(addr, value) { this.forceWrite8(addr, value); this.forceWrite8((addr + 1) >>> 0, value >>> 8); }
  forceWrite32(addr, value) { value >>>= 0; this.forceWrite8(addr, value); this.forceWrite8((addr + 1) >>> 0, value >>> 8); this.forceWrite8((addr + 2) >>> 0, value >>> 16); this.forceWrite8((addr + 3) >>> 0, value >>> 24); }

  loadBytes(addr, bytes, perm = PERM.RW, name = "") {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.map(addr >>> 0, b.length, PERM.RW | PERM.X, name);
    for (let i = 0; i < b.length; i++) {
      const a = (addr + i) >>> 0;
      const p = this.pages.get(this._pageNo(a));
      p.data[a & this.pageMask] = b[i];
    }
    this.mprotect(addr, b.length, perm);
  }

  zero(addr, length) { for (let i = 0; i < length; i++) this.write8((addr + i) >>> 0, 0); }
  readBytes(addr, length) { const out = new Uint8Array(length >>> 0); for (let i = 0; i < out.length; i++) out[i] = this.read8((addr + i) >>> 0); return out; }
  writeBytes(addr, bytes) { const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); for (let i = 0; i < b.length; i++) this.write8((addr + i) >>> 0, b[i]); }
  readCString(addr, max = 1 << 20) { const bytes = []; for (let i = 0; i < max; i++) { const b = this.read8((addr + i) >>> 0); if (b === 0) return new TextDecoder().decode(new Uint8Array(bytes)); bytes.push(b); } throw new MemoryFault(addr, "cstring"); }
  copyIn(addr, length) { return this.readBytes(addr >>> 0, length >>> 0); }
  copyOut(addr, bytes) { this.writeBytes(addr >>> 0, bytes); return bytes.length; }
  copyInCString(addr, max = 1 << 20) { return this.readCString(addr >>> 0, max); }
  copyInIovec(addr, count, maxBytes = 1 << 24) { const out = []; let total = 0; for (let i = 0; i < count; i++) { const base = this.read32(addr + i * 8); const len = this.read32(addr + i * 8 + 4); total += len; if (total > maxBytes) throw new MemoryFault(addr, "iovec-too-large"); out.push({ base, len, data: this.readBytes(base, len) }); } return out; }

  getMaps() {
    const keys = [...this.pages.keys()].sort((a, b) => a - b);
    const runs = [];
    for (const p of keys) {
      const page = this.pages.get(p); const name = this.nameMap.get(p) ?? "";
      const last = runs[runs.length - 1];
      if (last && last.endPage === p && last.perm === page.perm && last.name === name) last.endPage++;
      else runs.push({ startPage: p, endPage: p + 1, perm: page.perm, name });
    }
    return runs.map(r => ({ start: (r.startPage * this.pageSize) >>> 0, end: (r.endPage * this.pageSize) >>> 0, perm: r.perm, name: r.name }));
  }
  formatMaps() {
    return this.getMaps().map(m => `${hex32(m.start).slice(2)}-${hex32(m.end).slice(2)} ${permText(m.perm)}p 00000000 00:00 0 ${m.name}`.trimEnd()).join("\n") + "\n";
  }

  clone(options = {}) {
    const out = new PagedMemory({ pageSize: this.pageSize, nextMmap: this.nextMmap, onWrite: options.onWrite ?? this.onWrite });
    const cow = options.copyOnWrite ?? false;
    for (const [no, page] of this.pages) {
      if (cow) {
        page.shared = true;
        page.refCount = (page.refCount ?? 1) + 1;
        out.pages.set(no, page);
      } else {
        const cp = new Page(this.pageSize, page.perm);
        cp.data.set(page.data);
        cp.dirty = page.dirty;
        out.pages.set(no, cp);
      }
    }
    for (const [no, name] of this.nameMap) out.nameMap.set(no, name);
    return out;
  }
}
