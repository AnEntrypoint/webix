import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runELF } from "../src/index.js";
const path = new URL("../samples/hello.elf", import.meta.url);
if (!existsSync(path)) spawnSync(process.execPath, [new URL("./make-samples.mjs", import.meta.url).pathname], { stdio: "inherit" });
const bytes = readFileSync(path);
const result = await runELF(bytes, { argv: ["hello"], maxSteps: 100000 });
process.stdout.write(result.output);
if (result.stderr) process.stderr.write(result.stderr);
console.log(`exit=${result.exitCode} steps=${result.steps}`);

process.exit(result.exitCode ?? 0);
