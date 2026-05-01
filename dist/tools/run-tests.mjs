#!/usr/bin/env node
const tests = [
  "tests/basic.mjs",
  "tests/cpu-extensions.mjs",
  "tests/parity.mjs",
  "tests/cli.mjs",
  "tests/syscall-trace.mjs",
  "tests/alpine-compat.mjs",
  "tests/overlay-package.mjs",
  "tests/conformance.mjs",
  "tests/browser-import-graph.mjs",
];
for (const t of tests) await import(`../${t}?run=${Date.now()}-${Math.random()}`);
console.log("test suite passed");
process.exit(0);
