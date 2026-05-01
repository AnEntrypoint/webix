/** Browser sync/async bridge primitives inspired by the constraints of synchronous
 * POSIX/Node-style APIs running on top of browser async APIs. These are clean-room
 * utilities: they do not emulate NodePod internals, but implement the same class of
 * workaround—synchronous fast path, Promise slow path, and SAB/Atomics blocking when
 * the host permits it. */
export class SyncThenable {
  constructor(value, error = null) { this.value = value; this.error = error; }
  then(onFulfilled, onRejected) {
    try {
      if (this.error) return onRejected ? SyncThenable.resolve(onRejected(this.error)) : new SyncThenable(undefined, this.error);
      return SyncThenable.resolve(onFulfilled ? onFulfilled(this.value) : this.value);
    } catch (e) { return new SyncThenable(undefined, e); }
  }
  catch(onRejected) { return this.then(undefined, onRejected); }
  finally(onFinally) { if (onFinally) onFinally(); return this; }
  static resolve(v) { return v instanceof SyncThenable ? v : new SyncThenable(v); }
  static reject(e) { return new SyncThenable(undefined, e); }
}

export class SyncPromise extends Promise {
  constructor(executor) {
    let sync = true, settled = false, value, error, fulfilled = false;
    super((resolve, reject) => executor(v => { settled = true; fulfilled = true; value = v; resolve(v); }, e => { settled = true; fulfilled = false; error = e; reject(e); }));
    this.__syncSettled = settled && sync;
    this.__syncFulfilled = fulfilled;
    this.__syncValue = value;
    this.__syncError = error;
    sync = false;
  }
  then(onFulfilled, onRejected) {
    if (this.__syncSettled) {
      try {
        if (this.__syncFulfilled) return SyncThenable.resolve(onFulfilled ? onFulfilled(this.__syncValue) : this.__syncValue);
        return onRejected ? SyncThenable.resolve(onRejected(this.__syncError)) : SyncThenable.reject(this.__syncError);
      } catch (e) { return SyncThenable.reject(e); }
    }
    return super.then(onFulfilled, onRejected);
  }
  static resolve(v) { return new SyncThenable(v); }
}

export class BlockingSlotPool {
  constructor(slotCount = 64, slotBytes = 16 * 1024) {
    this.slotCount = slotCount; this.slotBytes = slotBytes;
    this.enabled = typeof SharedArrayBuffer !== "undefined" && typeof Atomics !== "undefined";
    this.control = this.enabled ? new Int32Array(new SharedArrayBuffer(slotCount * 4)) : null;
    this.data = this.enabled ? new Uint8Array(new SharedArrayBuffer(slotCount * slotBytes)) : null;
  }
  alloc() { for (let i = 0; i < this.slotCount; i++) if (Atomics.compareExchange(this.control, i, 0, 1) === 0) return i; throw new Error("No blocking slots available"); }
  free(slot) { Atomics.store(this.control, slot, 0); }
  wait(slot, timeoutMs = 120000) { if (!this.enabled) throw new Error("SharedArrayBuffer/Atomics are unavailable"); Atomics.wait(this.control, slot, 1, timeoutMs); return Atomics.load(this.control, slot); }
  writeAndWake(slot, bytes) { if (!this.enabled) return; const start = slot * this.slotBytes; this.data.fill(0, start, start + this.slotBytes); this.data.set(bytes.subarray(0, this.slotBytes), start); Atomics.store(this.control, slot, 2); Atomics.notify(this.control, slot, 1); }
  read(slot) { const start = slot * this.slotBytes; return this.data.slice(start, start + this.slotBytes); }
}

export class FutexTable {
  constructor() { this.waiters = new Map(); }
  _key(addr) { return (addr >>> 0).toString(16); }
  wait(addr, expected, timeoutMs = null) {
    const key = this._key(addr);
    return new Promise(resolve => {
      const waiter = { resolve, timer: null };
      if (timeoutMs !== null && Number.isFinite(timeoutMs)) waiter.timer = setTimeout(() => { this._remove(key, waiter); resolve(-110); }, Math.max(0, timeoutMs));
      if (!this.waiters.has(key)) this.waiters.set(key, []);
      this.waiters.get(key).push(waiter);
    });
  }
  _remove(key, waiter) {
    const list = this.waiters.get(key); if (!list) return;
    const i = list.indexOf(waiter); if (i >= 0) list.splice(i, 1);
    if (!list.length) this.waiters.delete(key);
  }
  wake(addr, count = 1) {
    const key = this._key(addr); const list = this.waiters.get(key); if (!list?.length) return 0;
    let n = 0;
    while (n < count && list.length) { const w = list.shift(); if (w.timer) clearTimeout(w.timer); w.resolve(0); n++; }
    if (!list.length) this.waiters.delete(key);
    return n;
  }
}
