import { readFileSync } from "node:fs";
import { runELF } from "../src/index.js";
const file = process.argv[2];
if (!file) { console.error("usage: npm run run -- path/to/program.elf [args...]"); process.exit(2); }
const argv = process.argv.slice(2);
const bytes = readFileSync(file);
const result = await runELF(bytes, { argv, execPath: argv[0], maxSteps: 20_000_000, onWrite: (fd, text) => process[fd === 2 ? "stderr" : "stdout"].write(text) });
if (!result.output) process.stdout.write("");
process.exit(result.exitCode ?? 0);
