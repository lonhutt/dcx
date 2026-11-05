import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { all, RULES } from "./index";
import { validateRegistry } from "./registry";
import type { Rule } from "./rule";
import { rule } from "./util";

const fake = (id: string, extra: Partial<Rule> = {}) =>
  ({
    ...rule({
      id,
      description: "d",
      explain: "a longer explanation",
      defaultSeverity: "warning",
      check() {},
    }),
    ...extra,
  }) as Rule;

test("the real registry validates; this one test guards every rule", () => {
  expect(() => validateRegistry(RULES)).not.toThrow();
});

describe("validation", () => {
  test("a duplicate ID fails loudly", () => {
    expect(() => validateRegistry([fake("a/b"), fake("a/b")])).toThrow("registered twice");
  });
  test.each(["NoSlash", "a/B", "a/b_c", "a/-b", "a/b-"])("malformed ID %s fails", (id) => {
    expect(() => validateRegistry([fake(id)])).toThrow("category/kebab-name");
  });
  test("a category that doesn't match the ID prefix fails", () => {
    expect(() => validateRegistry([fake("syntax/x", { category: "schema" })])).toThrow("category");
  });
  test("explain text no longer than the description fails", () => {
    expect(() => validateRegistry([fake("a/b", { explain: "d" })])).toThrow("explain");
  });
});

test("all() is sorted by ID and deterministic", () => {
  const ids = all().map((r) => r.id);
  expect(ids).toEqual([...ids].sort());
  expect(all().map((r) => r.id)).toEqual(ids);
});

// a rule written but never added to the manifest would otherwise just silently not run
test("every category directory's exported rules appear in the manifest", () => {
  const dir = import.meta.dir;
  const manifest = readFileSync(join(dir, "index.ts"), "utf8");
  for (const name of readdirSync(dir)) {
    if (!statSync(join(dir, name)).isDirectory() || name === "rulestest") continue;
    const index = readFileSync(join(dir, name, "index.ts"), "utf8");
    const exported = /export const (\w+Rules): Rule\[\]/.exec(index)?.[1];
    expect(exported, `${name}/index.ts exports no Rule[]`).toBeDefined();
    expect(manifest, `${exported} isn't spread into the manifest`).toContain(`...${exported}`);
  }
  const declared = new Set(RULES.map((r) => r.category));
  for (const name of readdirSync(dir)) {
    if (statSync(join(dir, name)).isDirectory() && name !== "rulestest")
      expect(declared.has(name as never), name).toBe(true);
  }
});

test.each(RULES.map((r) => [r.id, r] as const))(
  "%s has explain text longer than its description",
  (_, r) => {
    expect(r.explain.trim().length).toBeGreaterThan(r.description.length);
  },
);

test("the registry matches the design's catalog, category by category", () => {
  const counts: Record<string, number> = {};
  for (const r of all()) counts[r.category] = (counts[r.category] ?? 0) + 1;
  expect(counts).toEqual({
    syntax: 3,
    schema: 4,
    scenario: 7,
    semantic: 8,
    fs: 5,
    deprecation: 5,
    feature: 8,
    port: 5,
    mount: 4,
    lifecycle: 4,
    security: 6,
    vscode: 7,
    repro: 3,
    style: 2,
    meta: 1,
  });
});

test("network rules are exactly the catalog's seven", () => {
  expect(
    all()
      .filter((r) => r.requiresNetwork)
      .map((r) => r.id)
      .sort(),
  ).toEqual([
    "feature/deprecated",
    "feature/invalid-option-value",
    "feature/missing-dependency",
    "feature/unknown-option",
    "vscode/extension-deprecated",
    "vscode/extension-not-found",
    "vscode/extension-not-portable",
  ]);
});
