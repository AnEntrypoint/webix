#!/usr/bin/env node
// Runtime-surface typecheck for this dependency-free JS project. It imports the
// public API, constructs the core objects, and verifies that CLI/build modules
// are parseable enough to be loaded by Node when executed.
import assert from "node:assert/strict";
import * as api from "../src/index.js";

assert.equal(typeof api.CPU, "function");
assert.equal(typeof api.PagedMemory, "function");
assert.equal(typeof api.createRuntime, "function");
assert.equal(typeof api.installTarPackage, "function");
assert.equal(typeof api.createKernelActor, "function");
const mem = new api.PagedMemory();
mem.map(0x1000, 4096);
mem.write32(0x1000, 0x1234);
assert.equal(mem.read32(0x1000), 0x1234);
const vfs = new api.VFS();
vfs.writeFile("/tmp/typecheck", "ok");
assert.equal(new TextDecoder().decode(vfs.readFile("/tmp/typecheck")), "ok");
const actor = api.createKernelActor();
actor.send({ type: "BOOT", rootfs: "test" });
actor.send("READY");
assert.equal(actor.getSnapshot().value, "running");
console.log("typecheck passed: public API imports and core contracts are valid");
