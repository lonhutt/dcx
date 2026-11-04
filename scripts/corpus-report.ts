#!/usr/bin/env bun
/** Per-rule hit rates over the corpus, riskiest first, with sample findings: `bun scripts/corpus-report.ts`. */
import { corpusStats, loadCorpus } from "../src/lint/corpus";
import { all } from "../src/rules/index";

const corpus = loadCorpus();
const { stats, samples } = await corpusStats(corpus, all());
for (const s of [...stats].sort((a, b) => b.rate - a.rate)) {
  const r = all().find((x) => x.id === s.ruleId);
  console.log(
    `${(s.rate * 100).toFixed(1).padStart(5)}%  ${String(s.findings).padStart(4)}  ${r?.defaultSeverity.padEnd(7)}  ${s.ruleId}`,
  );
  for (const sample of samples.get(s.ruleId) ?? []) console.log(`         ${sample}`);
}
console.log(`\n${corpus.length} files`);
