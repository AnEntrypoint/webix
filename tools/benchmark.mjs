#!/usr/bin/env node
import { benchmark } from "../src/bench.js";
const iterations = Number(process.argv[2] ?? 250000);
const result = await benchmark({ iterations });
console.log(JSON.stringify(result, null, 2));
