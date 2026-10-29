#!/usr/bin/env bun
import { run } from "./src/cli/cli";

// .then, not top-level await: `--bytecode` compiles to CommonJS, which has none.
// exitCode, not process.exit(): exiting outright can cut off output still being flushed.
run(Bun.argv.slice(2)).then((code) => (process.exitCode = code));
