import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "../diagnostic/diagnostic";
import { parse } from "../jsonc/jsonc";
import type { Rule } from "../rules/rule";
import { MemFS } from "../vfs/memfs";
import { analyze } from "./analyze";

export const CORPUS = join(import.meta.dir, "..", "..", "testdata", "corpus");
const PATH = "/corpus/.devcontainer/devcontainer.json";

export interface CorpusFile {
  readonly name: string;
  readonly text: string;
}

export interface ManifestRow {
  readonly file: string;
  readonly repo: string;
  readonly path: string;
  readonly commit: string;
  readonly licence: string;
  readonly scenario: string;
  readonly retrieved: string;
}

let cached: CorpusFile[] | undefined;

/** Every corpus file, sorted by name; read once per process. */
export function loadCorpus(): CorpusFile[] {
  return (cached ??= readdirSync(CORPUS)
    .filter((f) => f.endsWith(".jsonc"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(CORPUS, name), "utf8") })));
}

export function loadManifest(): ManifestRow[] {
  return JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));
}

/**
 * Lints one corpus file with every rule but `fs/*`: the corpus is the configs alone, not
 * the Dockerfiles and Compose files beside them, so every reference would look missing.
 */
export async function lintCorpusFile(f: CorpusFile, rules: readonly Rule[]): Promise<Diagnostic[]> {
  const doc = parse(PATH, f.text);
  const { diagnostics } = await analyze(doc, PATH, {
    fs: new MemFS({ [PATH]: f.text }),
    rules: rules.filter((r) => r.category !== "fs"),
  });
  return diagnostics.filter((d) => !d.suppressed);
}

export interface RuleStat {
  readonly ruleId: string;
  readonly findings: number;
  readonly files: number;
  /** Share of corpus files with at least one finding, 0–1. */
  readonly rate: number;
}

export async function corpusStats(
  corpus: readonly CorpusFile[],
  rules: readonly Rule[],
): Promise<{ stats: RuleStat[]; samples: Map<string, string[]> }> {
  const findings = new Map<string, number>();
  const files = new Map<string, Set<string>>();
  const samples = new Map<string, string[]>();
  for (const f of corpus) {
    for (const d of await lintCorpusFile(f, rules)) {
      findings.set(d.ruleId, (findings.get(d.ruleId) ?? 0) + 1);
      (files.get(d.ruleId) ?? files.set(d.ruleId, new Set()).get(d.ruleId)!).add(f.name);
      const s = samples.get(d.ruleId) ?? samples.set(d.ruleId, []).get(d.ruleId)!;
      if (s.length < 3) s.push(`${f.name}: ${d.message}`);
    }
  }
  const stats = [...findings.keys()].sort().map((ruleId) => ({
    ruleId,
    findings: findings.get(ruleId)!,
    files: files.get(ruleId)!.size,
    rate: Math.round((files.get(ruleId)!.size / corpus.length) * 1000) / 1000,
  }));
  return { stats, samples };
}
