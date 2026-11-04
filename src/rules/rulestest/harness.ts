import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Diagnostic } from "../../diagnostic/diagnostic";
import { parse } from "../../jsonc/jsonc";
import { analyze } from "../../lint/analyze";
import { DEFAULTS, type Config } from "../../lintconfig/config";
import { parseConfig } from "../../lintconfig/load";
import { merge } from "../../lintconfig/merge";
import { updating } from "../../testutil/golden";
import { MemFS } from "../../vfs/memfs";
import { buildSources } from "../../registry/build";
import type { ExtensionSources } from "../../registry/sources";
import { stubResolver, type FeatureResolver } from "../../features/resolver";
import { stubSources } from "../../registry/stub";
import type { Rule } from "../rule";
import { compare, parseWants, rewrite } from "./annotate";

/** The fixture tree's root. */
export const FIXTURES = join(import.meta.dir, "..", "..", "..", "testdata", "rules");

/** Where a fixture's workspace sits in the in-memory filesystem. */
export const WORKSPACE = resolve("/workspace");
const CONFIG_PATH = join(WORKSPACE, ".devcontainer", "devcontainer.json");

export interface FixtureOptions {
  readonly features?: FeatureResolver;
  readonly extensions?: ExtensionSources;
}

/** Every file under `dir`, keyed by its path relative to `dir`. */
function readTree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, readTree(full, join(prefix, name)));
    else out[join(prefix, name)] = readFileSync(full, "utf8");
  }
  return out;
}

/**
 * Runs one rule over one fixture's text through `analyze`, suppressions and all, online.
 * An off-by-default rule runs at `warning`, so its fixtures have something to assert;
 * findings a directive suppresses don't count.
 */
export async function runCase(
  rule: Rule,
  text: string,
  files: Record<string, string> = {},
  config: Config = DEFAULTS,
  options: FixtureOptions = {},
): Promise<Diagnostic[]> {
  const fs = new MemFS({ [CONFIG_PATH]: text });
  for (const [path, body] of Object.entries(files)) fs.write(join(WORKSPACE, path), body);
  const severity = rule.defaultSeverity === "off" ? "warning" : rule.defaultSeverity;
  const result = await analyze(parse(CONFIG_PATH, text), CONFIG_PATH, {
    fs,
    rules: [rule],
    config: { ...config, online: true, rules: { [rule.id]: severity, ...config.rules } },
    ...options,
    extensions: options.extensions ?? (await buildSources(config, fs)),
  });
  return result.diagnostics.filter((d) => !d.suppressed);
}

/**
 * A case's stand-ins for the network: `<case>.features.json` maps feature references to
 * their metadata, `<case>.sources.json` describes extension sources and what each holds.
 */
async function stubsFor(base: string): Promise<FixtureOptions> {
  const out: { features?: FeatureResolver; extensions?: ExtensionSources } = {};
  if (existsSync(`${base}.features.json`))
    out.features = stubResolver(JSON.parse(readFileSync(`${base}.features.json`, "utf8")));
  if (existsSync(`${base}.sources.json`))
    out.extensions = stubSources(JSON.parse(readFileSync(`${base}.sources.json`, "utf8")));
  return out;
}

/**
 * Declares one test per `<case>.jsonc` under the rule's fixture directory. A case may
 * have a `<case>.files/` tree, laid out at the workspace root (the config itself sits at
 * `.devcontainer/devcontainer.json`), and a `<case>.dcx.yaml` project config.
 */
export function runFixtures(rule: Rule, options: FixtureOptions = {}): void {
  const dir = join(FIXTURES, ...rule.id.split("/"));
  describe(rule.id, () => {
    test("has fixtures", () => {
      expect(existsSync(dir), `no fixtures at ${relative(process.cwd(), dir)}`).toBe(true);
    });
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)
      .filter((f) => f.endsWith(".jsonc"))
      .sort()) {
      test(name, async () => {
        const path = join(dir, name);
        const text = readFileSync(path, "utf8");
        const base = path.replace(/\.jsonc$/, "");
        const files = existsSync(`${base}.files`) ? readTree(`${base}.files`) : {};
        const config = existsSync(`${base}.dcx.yaml`)
          ? merge(
              DEFAULTS,
              parseConfig(
                join(WORKSPACE, ".dcx.yaml"),
                readFileSync(`${base}.dcx.yaml`, "utf8"),
                "project",
              ),
            )
          : DEFAULTS;
        const stubs = await stubsFor(base);
        const got = await runCase(rule, text, files, config, { ...stubs, ...options });
        const lines = parse(path, text).lines;
        if (updating) {
          writeFileSync(path, rewrite(text, got, lines));
          return;
        }
        const result = compare(parseWants(text), got, text, lines);
        if (!result.ok) throw new Error(`${relative(process.cwd(), path)}\n${result.report}`);
      });
    }
  });
}
