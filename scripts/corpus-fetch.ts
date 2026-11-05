#!/usr/bin/env bun
/**
 * Refreshes testdata/corpus from public GitHub repos with permissive licences. Run by
 * hand (`bun scripts/corpus-fetch.ts`), never in CI; needs an authenticated `gh`.
 *
 * Replaces the corpus wholesale. Review the diff of counts.golden.json afterwards.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { parse } from "../src/jsonc/jsonc";
import { lower } from "../src/model/lower";

const OUT = join(import.meta.dir, "..", "testdata", "corpus");
const TARGET = 200;
// scenario quotas, so a refresh can't quietly turn into 200 image configs
const QUOTA = { image: 90, dockerfile: 70, compose: 40 } as const;
const LICENCES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "MPL-2.0",
]);
const QUERIES = [
  "filename:devcontainer.json path:.devcontainer",
  "filename:devcontainer.json path:.devcontainer dockerComposeFile",
  "filename:devcontainer.json path:.devcontainer dockerfile",
  "filename:devcontainer.json path:.devcontainer features",
  "filename:.devcontainer.json",
];

interface Hit {
  repository: { full_name: string };
  path: string;
  url: string;
}
interface Row {
  file: string;
  repo: string;
  path: string;
  commit: string;
  licence: string;
  scenario: string;
  retrieved: string;
}

const api = async <T>(path: string): Promise<T> =>
  JSON.parse(await $`gh api ${path}`.quiet().text());

async function search(): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const q of QUERIES) {
    for (let page = 1; page <= 10; page++) {
      const res = await api<{ items: Hit[] }>(
        `search/code?q=${encodeURIComponent(q)}&per_page=100&page=${page}`,
      ).catch((err) => (console.error(`search "${q}" page ${page}: ${err}`), { items: [] }));
      hits.push(...res.items);
      if (res.items.length < 100) break;
      await Bun.sleep(7000); // code search allows 10 requests a minute
    }
  }
  return hits;
}

const licences = new Map<string, string | undefined>();
async function licenceOf(repo: string): Promise<string | undefined> {
  if (!licences.has(repo)) {
    const r = await api<{ license: { spdx_id: string } | null; fork: boolean; archived: boolean }>(
      `repos/${repo}`,
    ).catch(() => undefined);
    licences.set(repo, r && !r.fork ? r.license?.spdx_id : undefined);
  }
  return licences.get(repo);
}

/** Top-level keys plus the image or Dockerfile name: two configs with the same shape add nothing. */
function shape(text: string): string {
  const doc = parse("c", text);
  const m = lower(doc);
  return [...m.properties.keys()].sort().join(",") + "|" + String(m.get("image")?.value ?? "");
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

async function main() {
  const hits = await search();
  console.error(`${hits.length} hits`);
  const seenRepo = new Set<string>();
  const seenHash = new Set<string>();
  const seenShape = new Set<string>();
  const counts = { image: 0, dockerfile: 0, compose: 0 };
  const rows: Row[] = [];
  const files: [string, string][] = [];

  for (const hit of hits) {
    if (rows.length >= TARGET) break;
    const repo = hit.repository.full_name;
    // one file per repo keeps any one project's habits from dominating
    if (seenRepo.has(repo)) continue;
    const licence = await licenceOf(repo);
    if (!licence || !LICENCES.has(licence)) continue;
    const commit = new URL(hit.url).searchParams.get("ref") ?? "";
    const text =
      await $`gh api ${`repos/${repo}/contents/${hit.path}?ref=${commit}`} -H ${"Accept: application/vnd.github.raw"}`
        .quiet()
        .text()
        .catch(() => undefined);
    if (!text || text.length > 64_000) continue;
    const hash = createHash("sha256").update(text).digest("hex");
    if (seenHash.has(hash)) continue;
    const doc = parse("c", text);
    if (doc.root?.type !== "object") continue;
    const kind = lower(doc).scenario.kind;
    const scenario =
      kind === "image" || kind === "dockerfile" || kind === "compose" ? kind : undefined;
    if (!scenario || counts[scenario] >= QUOTA[scenario]) continue;
    const s = shape(text);
    if (seenShape.has(s)) continue;
    seenRepo.add(repo);
    seenHash.add(hash);
    seenShape.add(s);
    counts[scenario]++;
    const file = `${String(rows.length + 1).padStart(3, "0")}-${slug(repo)}.jsonc`;
    files.push([file, text]);
    rows.push({
      file,
      repo,
      path: hit.path,
      commit,
      licence,
      scenario,
      retrieved: new Date().toISOString().slice(0, 10),
    });
    console.error(`${rows.length} ${scenario} ${repo}`);
  }

  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith(".jsonc")) rmSync(join(OUT, f));
  for (const [file, text] of files) await Bun.write(join(OUT, file), text);
  await Bun.write(join(OUT, "manifest.json"), JSON.stringify(rows, null, 2) + "\n");
  console.error(`wrote ${rows.length}: ${JSON.stringify(counts)}`);
}

await main();
