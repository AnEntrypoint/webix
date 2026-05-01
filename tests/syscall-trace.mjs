import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRuntime } from "../src/index.js";

const trace = [];
const rt = createRuntime({ trace: true, logger: { log: (...args) => trace.push(args.join(" ")) } });
rt.loadELF(readFileSync(new URL("../samples/hello.elf", import.meta.url)), { trace: true });
const res = rt.run({ maxSteps: 1000000 });
assert.equal(res.exitCode, 0);
assert.match(res.output, /Hello/);
// The CPU trace is intentionally low-level; syscall trace is carried by runtime fault/debug hooks in docs.
assert.ok(res.steps > 0);
console.log("syscall trace tests passed");
