export const REG = Object.freeze({ EAX: 0, ECX: 1, EDX: 2, EBX: 3, ESP: 4, EBP: 5, ESI: 6, EDI: 7 });
export const REG_NAMES = Object.freeze(["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"]);
export const FLAGS = Object.freeze({ CF: 1 << 0, PF: 1 << 2, AF: 1 << 4, ZF: 1 << 6, SF: 1 << 7, TF: 1 << 8, IF: 1 << 9, DF: 1 << 10, OF: 1 << 11 });
export const EFLAGS = FLAGS;
export function u32(x) { return x >>> 0; }
export function s32(x) { return x >> 0; }
export function u16(x) { return x & 0xffff; }
export function s16(x) { x &= 0xffff; return (x & 0x8000) ? x - 0x10000 : x; }
export function u8(x) { return x & 0xff; }
export function s8(x) { x &= 0xff; return (x & 0x80) ? x - 0x100 : x; }
export const sign8 = s8;
export const sign16 = s16;
export function sign32(x) { return x >> 0; }
export function alignDown(value, align) { return (value & ~(align - 1)) >>> 0; }
export function alignUp(value, align) { return (((value >>> 0) + align - 1) & ~(align - 1)) >>> 0; }
export function hex(value, width = 8) { return `0x${(value >>> 0).toString(16).padStart(width, "0")}`; }
export const hex32 = value => hex(value, 8);
export function parity8(value) { value &= 0xff; value ^= value >>> 4; value &= 0xf; return ((0x6996 >>> value) & 1) === 0; }
const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: false });
export function stringToBytes(s) { return te.encode(String(s)); }
export function bytesToString(bytes) { return td.decode(bytes); }
export function readCString(memory, addr, maxLen = 1 << 20) { const out = []; for (let i = 0; i < maxLen; i++) { const b = memory.read8((addr + i) >>> 0); if (b === 0) return bytesToString(new Uint8Array(out)); out.push(b); } throw new Error(`Unterminated C string at ${hex32(addr)}`); }
export const cString = readCString;
export function writeCString(memory, addr, text) { const bytes = stringToBytes(text); memory.writeBytes(addr, bytes); memory.write8((addr + bytes.length) >>> 0, 0); return bytes.length + 1; }
export function errno(n) { return (-Math.abs(n)) >>> 0; }
export function isErrno(ret) { return (ret >>> 0) >= 0xfffff001; }
export function lo32FromBigInt(v) { return Number(BigInt.asUintN(32, v)); }
export function hi32FromBigInt(v) { return Number(BigInt.asUintN(32, v >> 32n)); }
export function makeBigUint64(lo, hi) { return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0); }
export function makeBigInt64(lo, hi) { return BigInt.asIntN(64, makeBigUint64(lo, hi)); }
export function nowSeconds() { return Math.floor(Date.now() / 1000); }
export class Logger { constructor(enabled = false, sink = console.log) { this.enabled = enabled; this.sink = sink; } log(...args) { if (this.enabled) this.sink(...args); } }
// Extra constants retained for compatibility with internal modules.
export const S_IFMT = 0o170000, S_IFSOCK = 0o140000, S_IFLNK = 0o120000, S_IFREG = 0o100000, S_IFBLK = 0o060000, S_IFDIR = 0o040000, S_IFCHR = 0o020000, S_IFIFO = 0o010000;
export const DT_UNKNOWN = 0, DT_FIFO = 1, DT_CHR = 2, DT_DIR = 4, DT_BLK = 6, DT_REG = 8, DT_LNK = 10, DT_SOCK = 12;
export function normalizePath(path) { const parts = []; for (const part of String(path || "/").split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); } return `/${parts.join("/")}`; }
export function joinPath(base, child) { if (!child) return normalizePath(base); if (String(child).startsWith("/")) return normalizePath(child); return normalizePath(`${base || "/"}/${child}`); }
export function modeToDirentType(mode) { switch (mode & S_IFMT) { case S_IFDIR: return DT_DIR; case S_IFREG: return DT_REG; case S_IFCHR: return DT_CHR; case S_IFLNK: return DT_LNK; case S_IFIFO: return DT_FIFO; default: return DT_UNKNOWN; } }
