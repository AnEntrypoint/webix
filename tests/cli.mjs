import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTar, benchmark } from "../src/index.js";
import { runProgram } from "../src/cli-runtime.js";

const dir = mkdtempSync(path.join(tmpdir(), "xos-cli-"));
const hello = readFileSync(new URL("../samples/hello.elf", import.meta.url));
const rootfs = createTar({ "bin/hello": hello });
const rootPath = path.join(dir, "rootfs.tar");
writeFileSync(rootPath, rootfs);

const { result } = await runProgram({ rootfs: rootPath, path: "/bin/hello", args: [], maxSteps: 100000 });
assert.equal(result.exitCode, 0);
assert.match(result.output, /Hello from clean-room/);

const b = await benchmark({ iterations: 1000 });
assert.ok(b.stepsPerSecond > 0);
console.log("cli tests passed");
