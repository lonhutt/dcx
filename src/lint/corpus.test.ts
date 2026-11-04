import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parse } from "../jsonc/jsonc";
import { lower } from "../model/lower";
import { all, get } from "../rules/index";
import { expectGolden } from "../testutil/golden";
import { corpusStats, CORPUS, lintCorpusFile, loadCorpus, loadManifest } from "./corpus";

const corpus = loadCorpus();
const manifest = loadManifest();
const MAX_UNJUSTIFIED_RATE = 0.2;

describe("every corpus file lints without a throw or an internal error", () => {
  test.each(corpus.map((f) => [f.name, f] as const))("%s", async (_, f) => {
    const found = await lintCorpusFile(f, all());
    expect(found.filter((d) => d.message.startsWith("Internal error"))).toEqual([]);
  });
});

test("there's a corpus, and all three container sources are in it", () => {
  expect(corpus.length).toBeGreaterThanOrEqual(150);
  const kinds = new Set<string>(corpus.map((f) => lower(parse("c", f.text)).scenario.kind));
  for (const k of ["image", "dockerfile", "compose"]) expect(kinds).toContain(k);
});

test("every file has a manifest row and every row a file, with provenance", () => {
  expect(manifest.map((r) => r.file).sort()).toEqual(corpus.map((f) => f.name));
  for (const r of manifest) {
    expect(r.repo).toMatch(/^[^/]+\/[^/]+$/);
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.licence).toBeTruthy();
  }
});

// the design pressure on security/hardcoded-secret: real configs never trip it
test("hardcoded-secret finds nothing in real-world configs", async () => {
  const rule = get("security/hardcoded-secret")!;
  const found = [];
  for (const f of corpus)
    found.push(...(await lintCorpusFile(f, [rule])).map((d) => `${f.name}: ${d.message}`));
  expect(found).toEqual([]);
});

describe("corpus review", async () => {
  const { stats } = await corpusStats(corpus, all());

  // a diff here is a rule change's blast radius on real configs; review it, then UPDATE=1
  test("per-rule counts match the reviewed baseline", async () => {
    await expectGolden(join(CORPUS, "counts.golden.json"), JSON.stringify(stats, null, 2) + "\n");
  });

  test.each(stats.filter((s) => s.rate > MAX_UNJUSTIFIED_RATE).map((s) => [s.ruleId, s] as const))(
    "%s fires on over a fifth of the corpus, so it carries a justification",
    (id) => {
      expect(get(id)!.justification?.trim()).toBeTruthy();
    },
  );
});

test.each(
  all()
    .filter((r) => r.defaultSeverity === "error")
    .map((r) => [r.id, r] as const),
)("%s is an error by default, so it carries a justification", (_, r) => {
  expect(r.justification?.trim()).toBeTruthy();
});
