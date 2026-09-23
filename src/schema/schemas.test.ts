import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ValidateFunction } from "ajv";
import { expect, test } from "bun:test";
import { validate as validateBaseRaw } from "./generated/devContainer.base.validator";
import { validate as validateFeatureRaw } from "./generated/devContainerFeature.validator";
import { provenance } from "./schemas";

// The generated modules are plain standalone Ajv output with no .d.ts of their own;
// TypeScript's allowJs inference misses the `.errors` property Ajv assigns at runtime.
const validateBase = validateBaseRaw as unknown as ValidateFunction;
const validateFeature = validateFeatureRaw as unknown as ValidateFunction;

// One directory up from src/schema/ is src/, two is the repo root.
const repoRoot = path.join(import.meta.dir, "..", "..");
const schemasDir = path.join(repoRoot, "schemas");
const submoduleDir = path.join(repoRoot, "devcontainer-spec");

test("every generated validator compiles and validates a known-good fixture", () => {
  expect(validateBase({ image: "mcr.microsoft.com/devcontainers/base:ubuntu" })).toBe(true);
  expect(validateFeature({ id: "my-feature", version: "1.0.0" })).toBe(true);
});

test("provenance() has one entry per vendored schema, each with a url, commit and date", () => {
  const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"));
  const entries = provenance();

  expect(Object.keys(entries).sort()).toEqual(schemaFiles.sort());
  for (const entry of Object.values(entries)) {
    expect(entry.url).toMatch(/^https:\/\//);
    expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
});

// schemas/ is a symlink into the pinned devcontainer-spec submodule, so there is no
// file to diff against upstream — the thing that can actually drift is the pin. A
// fresh clone without `--recurse-submodules` leaves devcontainer-spec/ present but
// empty (no `.git`), which is when this degrades to skipped rather than failed.
test.skipIf(!existsSync(path.join(submoduleDir, ".git")))(
  "the submodule's pinned commit matches provenance.json's commit field for every schema",
  async () => {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: submoduleDir, stdout: "pipe" });
    const pinnedCommit = (await new Response(proc.stdout).text()).trim();

    for (const entry of Object.values(provenance())) {
      expect(entry.commit).toBe(pinnedCommit);
    }
  },
);

test("offline determinism — same input, identical output, no network reachable", () => {
  // The generated validators are pure synchronous functions over their input — there
  // is no fetch anywhere on this path — so running the same input twice must produce
  // byte-identical results, valid or not.
  const valid = { image: "mcr.microsoft.com/devcontainers/base:ubuntu" };
  const invalid = { image: "mcr.microsoft.com/devcontainers/base:ubuntu", notAKnownProperty: true };

  expect(validateBase(structuredClone(valid))).toBe(validateBase(structuredClone(valid)));

  const firstRun = validateBase(structuredClone(invalid));
  const firstErrors = structuredClone(validateBase.errors);
  const secondRun = validateBase(structuredClone(invalid));
  const secondErrors = validateBase.errors;

  expect(secondRun).toBe(firstRun);
  expect(secondErrors).toEqual(firstErrors);
});

test("unevaluatedProperties is genuinely enforced by the generated validator", () => {
  // Catches importing the wrong Ajv entrypoint (ajv/dist/2019 vs. the draft-07
  // default) — the wrong one accepts this fixture silently instead of rejecting it.
  const valid = validateBase({
    image: "mcr.microsoft.com/devcontainers/base:ubuntu",
    notAKnownProperty: true,
  });

  expect(valid).toBe(false);
  expect(validateBase.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ keyword: "unevaluatedProperties" })]),
  );
});
