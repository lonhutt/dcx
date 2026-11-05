#!/usr/bin/env bun
/** Writes RULES.md from the registry: `bun scripts/rules-doc.ts`. A test fails when it's stale. */
import { join } from "node:path";
import { renderRulesDoc } from "../src/report/rules-doc";
import { all } from "../src/rules/index";

await Bun.write(join(import.meta.dir, "..", "RULES.md"), renderRulesDoc(all()));
