import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic, TextEdit } from "../diagnostic/diagnostic";
import { parse, type Document } from "../jsonc/jsonc";
import { rule } from "../rules/util";
import { expectGolden } from "../testutil/golden";
import { MemFS } from "../vfs/memfs";
import { analyze } from "./analyze";
import { DEFAULTS, type Config } from "../lintconfig/config";
import { parseConfig } from "../lintconfig/load";
import { merge } from "../lintconfig/merge";
import { unifiedDiff } from "./diff";
import { applyFixes, fixDocument, MAX_PASSES, OverlapError } from "./fix";

const FIXTURES = join(import.meta.dir, "..", "..", "testdata", "fix");
const PATH = "/w/.devcontainer/devcontainer.json";
const fs = new MemFS({ "/w/.devcontainer/Dockerfile": "FROM x\nARG V\n" });
const lintWith = (config?: Config) => async (doc: Document) =>
  (await analyze(doc, PATH, { fs, ...(config && { config }) })).diagnostics;
const lint = lintWith();
const fixable = (ds: readonly Diagnostic[]) => ds.filter((d) => d.fix && !d.suppressed);

const fix = (ruleId: string, ...edits: [number, number, string][]): Diagnostic => ({
  ruleId,
  severity: "warning",
  range: { start: edits[0]![0], end: edits[0]![1] },
  message: ruleId,
  fix: {
    title: ruleId,
    edits: edits.map(([start, end, newText]) => ({ range: { start, end }, newText })),
  },
});

describe("fixture pairs", () => {
  const cases = readdirSync(FIXTURES).filter(
    (f) => f.endsWith(".jsonc") && !f.endsWith(".fixed.jsonc"),
  );
  test("there are some", () => expect(cases.length).toBeGreaterThan(0));

  test.each(cases)("%s", async (name) => {
    const before = await Bun.file(join(FIXTURES, name)).text();
    // a sibling <case>.dcx.yaml turns on what the case needs, like an off-by-default rule
    const configFile = Bun.file(join(FIXTURES, name.replace(/\.jsonc$/, ".dcx.yaml")));
    const config = (await configFile.exists())
      ? merge(DEFAULTS, parseConfig(configFile.name!, await configFile.text(), "project"))
      : undefined;
    const lint = lintWith(config);
    const fixed = await fixDocument(before, PATH, lint);
    await expectGolden(join(FIXTURES, name.replace(/\.jsonc$/, ".fixed.jsonc")), fixed.text);
    expect(fixed.applied).toBeGreaterThan(0);
    expect(fixed.unconverged).toBe(0);

    const doc = parse(PATH, fixed.text);
    expect(doc.errors).toEqual([]);
    // every comment in the original survives
    for (const c of parse(PATH, before).comments)
      expect(fixed.text).toContain(before.slice(c.range.start, c.range.end));
    expect(fixable(await lint(doc))).toEqual([]);
    // and fixing again changes nothing
    expect((await fixDocument(fixed.text, PATH, lint)).text).toBe(fixed.text);
  });
});

describe("applyFixes", () => {
  test("non-overlapping fixes from different rules all apply", () => {
    const out = applyFixes("abcdef", [fix("a/x", [0, 1, "A"]), fix("a/y", [4, 5, "E"])]);
    expect(out.text).toBe("AbcdEf");
    expect(out.applied.map((d) => d.ruleId)).toEqual(["a/x", "a/y"]);
  });

  test("a fix overlapping an earlier one waits for the next pass", () => {
    const out = applyFixes("abcdef", [fix("a/x", [0, 3, "X"]), fix("a/y", [2, 4, "Y"])]);
    expect(out.text).toBe("Xdef");
    expect(out.applied.map((d) => d.ruleId)).toEqual(["a/x"]);
  });

  test("two inserts at one offset collide; order would be a guess", () => {
    expect(
      applyFixes("ab", [fix("a/x", [1, 1, "X"]), fix("a/y", [1, 1, "Y"])]).applied,
    ).toHaveLength(1);
  });

  test("a fix that overlaps itself is a bug, named, and nothing is applied", () => {
    expect(() => applyFixes("abcdef", [fix("a/x", [0, 3, "X"], [2, 4, "Y"])])).toThrow(
      OverlapError,
    );
    expect(() => applyFixes("abcdef", [fix("a/x", [0, 3, "X"], [2, 4, "Y"])])).toThrow("a/x");
  });

  test("suppressed and off findings are never fixed", () => {
    const text = "abc";
    expect(applyFixes(text, [{ ...fix("a/x", [0, 1, "X"]), suppressed: true }]).text).toBe(text);
    expect(applyFixes(text, [{ ...fix("a/x", [0, 1, "X"]), severity: "off" }]).text).toBe(text);
  });

  test("random non-overlapping edits land exactly where they say", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.array(fc.tuple(fc.nat(), fc.nat(3), fc.string({ maxLength: 4 })), { maxLength: 8 }),
        (text, raw) => {
          // turn the random tuples into disjoint, gap-separated edits
          const edits: TextEdit[] = [];
          let cursor = 0;
          for (const [gap, len, newText] of raw) {
            const start = cursor + (gap % 5) + 1;
            const end = Math.min(text.length, start + len);
            if (start > text.length) break;
            edits.push({ range: { start, end }, newText });
            cursor = end;
          }
          let want = text;
          for (const e of [...edits].reverse())
            want = want.slice(0, e.range.start) + e.newText + want.slice(e.range.end);
          const ds = edits.map((e, i) => ({
            ...fix(`t/${i}`, [e.range.start, e.range.end, e.newText]),
          }));
          expect(applyFixes(text, ds).text).toBe(want);
        },
      ),
    );
  });
});

describe("fixDocument", () => {
  test("a pair of rules that undo each other hits the cap and says so", async () => {
    const flip = rule({
      id: "style/flip",
      description: "flip",
      explain: "flips a and b forever",
      defaultSeverity: "warning",
      fixable: true,
      check({ doc, report }) {
        const i = doc.text.search(/"[ab]"/);
        if (i < 0) return;
        const next = doc.text[i + 1] === "a" ? '"b"' : '"a"';
        report({
          range: { start: i, end: i + 3 },
          message: "flip",
          fix: { title: "flip", edits: [{ range: { start: i, end: i + 3 }, newText: next }] },
        });
      },
    });
    const flipLint = async (doc: Document) =>
      (await analyze(doc, PATH, { fs, rules: [flip] })).diagnostics;
    const out = await fixDocument('{"k": "a"}', PATH, flipLint);
    expect(out.applied).toBe(MAX_PASSES);
    expect(out.unconverged).toBe(1);
  });

  test("an aborted signal stops between passes", async () => {
    const ac = new AbortController();
    ac.abort();
    const before = await Bun.file(join(FIXTURES, "root-extensions.jsonc")).text();
    expect((await fixDocument(before, PATH, lint, ac.signal)).applied).toBe(0);
  });
});

describe("unifiedDiff", () => {
  test("equal text is no diff", () => expect(unifiedDiff("f", "a\n", "a\n")).toBe(""));

  test("one hunk, with context and 1-based ranges", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n";
    const after = "1\n2\n3\n4x\n5\n6\n7\n8\n";
    expect(unifiedDiff("f", before, after)).toBe(
      "--- a/f\n+++ b/f\n@@ -1,7 +1,7 @@\n 1\n 2\n 3\n-4\n+4x\n 5\n 6\n 7\n",
    );
  });

  test("distant changes get separate hunks; close ones share", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${i}\n`);
    const far = [...lines];
    far[2] = "x\n";
    far[25] = "y\n";
    expect(unifiedDiff("f", lines.join(""), far.join("")).match(/^@@/gm)).toHaveLength(2);
    const near = [...lines];
    near[2] = "x\n";
    near[8] = "y\n";
    expect(unifiedDiff("f", lines.join(""), near.join("")).match(/^@@/gm)).toHaveLength(1);
  });

  test("a missing final newline is marked", () => {
    expect(unifiedDiff("f", "a\nb", "a\nc")).toContain("\\ No newline at end of file");
  });

  // patch(1) isn't on every CI runner; windows-latest has none
  test.skipIf(!Bun.which("patch"))(
    "applying the diff with patch(1) reproduces the fixed file",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "dcx-diff-"));
      try {
        const before = await Bun.file(join(FIXTURES, "root-settings-and-extensions.jsonc")).text();
        const after = (await fixDocument(before, PATH, lint)).text;
        await Bun.write(join(dir, "f"), before);
        await Bun.$`patch -s -p1 -d ${dir} < ${Buffer.from(unifiedDiff("f", before, after))}`.quiet();
        expect(await Bun.file(join(dir, "f")).text()).toBe(after);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
