import { stringToBytes } from "./util.js";

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return stringToBytes(data);
  return new Uint8Array(data ?? 0);
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
  const r = norm(root || "/");
  const p = norm(path || "/");
  if (r === "/") return p;
  if (p === "/") return r;
  return norm(`${r}/${p.slice(1)}`);
}
function cloneBytes(b) { const out = new Uint8Array(b.length); out.set(b); return out; }

/** In-memory asynchronous file device. Paths are POSIX-like and normalized. */
export class DataDevice {
  constructor(files = {}) {
    this.files = new Map();
    for (const [path, data] of Object.entries(files)) this.writeFile(path, data);
  }
  async readFile(path) {
    const key = norm(path);
    const data = this.files.get(key);
    if (!data) throw new Error(`DataDevice: ${key} not found`);
    return cloneBytes(data);
  }
  async writeFile(path, data) { this.files.set(norm(path), cloneBytes(asBytes(data))); }
  async deleteFile(path) { this.files.delete(norm(path)); }
  async exists(path) { return this.files.has(norm(path)); }
  async list(prefix = "/") {
    const p = norm(prefix);
    return [...this.files.keys()].filter(k => k === p || k.startsWith(p === "/" ? "/" : `${p}/`)).sort();
  }
  async mountTo(vfs, root = "/") {
    for (const [path, data] of this.files) vfs.writeFile(join(root, path), data);
    return vfs;
  }
  snapshot() { return Object.fromEntries([...this.files].map(([k, v]) => [k, cloneBytes(v)])); }
}

/** Read-only HTTP file device. Useful for serving /app style assets from a web server. */
export class WebDevice {
  constructor(baseUrl, options = {}) {
    this.baseUrl = String(baseUrl || "");
    this.cache = options.cache ?? true;
    this.cacheMap = new Map();
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!this.fetch) throw new Error("WebDevice requires fetch");
  }
  urlFor(path) {
    const p = norm(path).slice(1).split("/").map(encodeURIComponent).join("/");
    return `${this.baseUrl.replace(/\/$/, "")}/${p}`;
  }
  async readFile(path) {
    const key = norm(path);
    if (this.cacheMap.has(key)) return cloneBytes(this.cacheMap.get(key));
    const res = await this.fetch(this.urlFor(key));
    if (!res.ok) throw new Error(`WebDevice: ${key} HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (this.cache) this.cacheMap.set(key, cloneBytes(bytes));
    return bytes;
  }
  async writeFile() { throw new Error("WebDevice is read-only"); }
}

/** Browser IndexedDB-backed async file device. Falls back to memory when indexedDB is absent if fallback=true. */
export class IDBDevice {
  constructor(name = "cleanroom-x86-vfs", options = {}) {
    this.name = name;
    this.storeName = options.storeName ?? "files";
    this.fallback = options.fallback ?? true;
    this.memory = new DataDevice();
    this._dbPromise = null;
  }
  async _db() {
    if (!globalThis.indexedDB) {
      if (this.fallback) return null;
      throw new Error("IndexedDB is not available");
    }
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.storeName);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    return this._dbPromise;
  }
  async _tx(mode, fn) {
    const db = await this._db();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const store = tx.objectStore(this.storeName);
      let value;
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve(value);
      try { value = fn(store); } catch (e) { reject(e); }
    });
  }
  async readFile(path) {
    const key = norm(path);
    const db = await this._db();
    if (!db) return this.memory.readFile(key);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => req.result ? resolve(cloneBytes(req.result)) : reject(new Error(`IDBDevice: ${key} not found`));
    });
  }
  async writeFile(path, data) {
    const key = norm(path), bytes = cloneBytes(asBytes(data));
    const db = await this._db();
    if (!db) return this.memory.writeFile(key, bytes);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
      tx.objectStore(this.storeName).put(bytes, key);
    });
  }
  async deleteFile(path) {
    const key = norm(path);
    const db = await this._db();
    if (!db) return this.memory.deleteFile(key);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
      tx.objectStore(this.storeName).delete(key);
    });
  }
  async list(prefix = "/") {
    const p = norm(prefix);
    const db = await this._db();
    if (!db) return this.memory.list(p);
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).openKeyCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out.sort());
        const key = String(cur.key);
        if (key === p || key.startsWith(p === "/" ? "/" : `${p}/`)) out.push(key);
        cur.continue();
      };
    });
  }
  async mountTo(vfs, root = "/") {
    for (const path of await this.list("/")) vfs.writeFile(join(root, path), await this.readFile(path));
    return vfs;
  }
}

/** Overlay file device: reads upper first, then lower; writes/deletes affect upper only. */
export class OverlayDevice {
  constructor(lower, upper = new DataDevice()) {
    this.lower = lower;
    this.upper = upper;
    this.whiteouts = new Set();
  }
  async readFile(path) {
    const key = norm(path);
    if (this.whiteouts.has(key)) throw new Error(`OverlayDevice: ${key} deleted`);
    try { return await this.upper.readFile(key); } catch { return this.lower.readFile(key); }
  }
  async writeFile(path, data) {
    const key = norm(path);
    this.whiteouts.delete(key);
    return this.upper.writeFile(key, data);
  }
  async deleteFile(path) {
    const key = norm(path);
    this.whiteouts.add(key);
    if (this.upper.deleteFile) await this.upper.deleteFile(key);
  }
  async list(prefix = "/") {
    const lowerList = this.lower.list ? await this.lower.list(prefix) : [];
    const upperList = this.upper.list ? await this.upper.list(prefix) : [];
    return [...new Set([...lowerList, ...upperList])].filter(p => !this.whiteouts.has(norm(p))).sort();
  }
  async mountTo(vfs, root = "/") {
    for (const path of await this.list("/")) vfs.writeFile(join(root, path), await this.readFile(path));
    return vfs;
  }
}

/** Byte-addressable block device backed by a Uint8Array. */
export class BufferBlockDevice {
  constructor(bytes, options = {}) {
    this.bytes = asBytes(bytes);
    this.blockSize = options.blockSize ?? 4096;
  }
  get size() { return this.bytes.length; }
  async read(offset, length) {
    offset = Number(offset); length = Number(length);
    if (offset < 0 || length < 0 || offset + length > this.bytes.length) throw new Error(`BufferBlockDevice read outside image: ${offset}+${length}`);
    return this.bytes.slice(offset, offset + length);
  }
}

/** HTTP range-backed byte device with a small page cache. */
export class HttpBytesDevice {
  constructor(url, options = {}) {
    this.url = String(url);
    this.pageSize = options.pageSize ?? 64 * 1024;
    this.cache = new Map();
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!this.fetch) throw new Error("HttpBytesDevice requires fetch");
  }
  async _page(pageNo) {
    if (this.cache.has(pageNo)) return this.cache.get(pageNo);
    const start = pageNo * this.pageSize;
    const end = start + this.pageSize - 1;
    const res = await this.fetch(this.url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!(res.status === 206 || res.ok)) throw new Error(`HttpBytesDevice HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.cache.set(pageNo, bytes);
    return bytes;
  }
  async read(offset, length) {
    offset = Number(offset); length = Number(length);
    const out = new Uint8Array(length);
    let copied = 0;
    while (copied < length) {
      const at = offset + copied;
      const pageNo = Math.floor(at / this.pageSize);
      const pageOff = at % this.pageSize;
      const page = await this._page(pageNo);
      const n = Math.min(length - copied, page.length - pageOff);
      if (n <= 0) break;
      out.set(page.subarray(pageOff, pageOff + n), copied);
      copied += n;
    }
    return copied === out.length ? out : out.slice(0, copied);
  }
}
