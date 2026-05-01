import { VFS } from "./vfs.js";

export class IndexedDBVfsPersistence {
  constructor(name = "openx86-vfs", store = "snapshots") { this.name = name; this.store = store; }
  _open() {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available");
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.store);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }
  async save(key, vfs) {
    const db = await this._open(); const snapshot = vfs.snapshot({ binary: true });
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readwrite"); tx.objectStore(this.store).put(snapshot, key);
      tx.oncomplete = () => resolve(snapshot.byteLength); tx.onerror = () => reject(tx.error);
    });
  }
  async load(key) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readonly"); const req = tx.objectStore(this.store).get(key);
      req.onsuccess = () => resolve(req.result ? VFS.fromSnapshot(new Uint8Array(req.result)) : null);
      req.onerror = () => reject(req.error);
    });
  }
  async delete(key) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readwrite"); tx.objectStore(this.store).delete(key);
      tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error);
    });
  }
  async list() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readonly"); const req = tx.objectStore(this.store).getAllKeys();
      req.onsuccess = () => resolve([...req.result]); req.onerror = () => reject(req.error);
    });
  }
}

export class LocalStorageVfsPersistence {
  constructor(prefix = "openx86:vfs:") { this.prefix = prefix; }
  save(key, vfs) { if (typeof localStorage === "undefined") throw new Error("localStorage is not available"); const text = JSON.stringify(vfs.snapshot()); localStorage.setItem(this.prefix + key, text); return text.length; }
  load(key) { if (typeof localStorage === "undefined") throw new Error("localStorage is not available"); const text = localStorage.getItem(this.prefix + key); return text ? VFS.fromSnapshot(text) : null; }
  delete(key) { if (typeof localStorage === "undefined") throw new Error("localStorage is not available"); localStorage.removeItem(this.prefix + key); return true; }
  list() { if (typeof localStorage === "undefined") throw new Error("localStorage is not available"); const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(this.prefix)) out.push(k.slice(this.prefix.length)); } return out; }
}

function defaultStore() { return typeof indexedDB !== "undefined" ? new IndexedDBVfsPersistence() : new LocalStorageVfsPersistence(); }
export async function saveVfsSnapshot(a, b = "default", c = defaultStore()) {
  // Supports both saveVfsSnapshot(key, vfs) and saveVfsSnapshot(vfs, key).
  const vfsFirst = a && typeof a === "object" && a.root && typeof a.snapshot === "function";
  const key = vfsFirst ? b : a;
  const vfs = vfsFirst ? a : b;
  const store = vfsFirst ? c : (arguments.length >= 3 ? c : defaultStore());
  const bytes = await store.save(key ?? "default", vfs);
  return { name: key ?? "default", bytes };
}
export async function loadVfsSnapshot(key = "default", store = defaultStore()) { return store.load(key); }
export async function listVfsSnapshots(store = defaultStore()) { return store.list(); }
export async function deleteVfsSnapshot(key = "default", store = defaultStore()) { return store.delete(key); }
