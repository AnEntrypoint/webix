import { readFileSync } from "node:fs";
import { EmulatedRuntime } from "../src/index.js";

const rt = new EmulatedRuntime();
rt.mountFile("/data/message.txt", "Hello through open/read/write from the virtual filesystem!\n");
const elf = readFileSync(new URL("../samples/cat_data.elf", import.meta.url));
rt.loadELF(elf, { argv: ["/cat_data"], execPath: "/cat_data" });
const result = rt.run({ maxSteps: 200000 });
process.stdout.write(result.output);
console.error(`exit=${result.exitCode} steps=${result.steps}`);

process.exit(result.exitCode ?? 0);
