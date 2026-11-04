import { expect, test } from "bun:test";
import type { Diagnostic } from "../../diagnostic/diagnostic";
import { parse } from "../../jsonc/jsonc";
import { rule } from "../util";
import { compare, parseWants, rewrite } from "./annotate";
import { runCase } from "./harness";

const text = '{\n  "a": 1, // want: error: bad a\n  "b": 2\n}';
const lines = parse("u", text).lines;
const at = (line: number, message = "bad a", character = 2): Diagnostic => {
  const start = lines.offsetAt({ line, character });
  return { ruleId: "t/t", severity: "error", range: { start, end: start + 1 }, message };
};

test("a matching finding passes", () => {
  expect(compare(parseWants(text), [at(1)], text, lines)).toEqual({ ok: true });
});

test("a finding on the wrong line fails, naming both sides with context", () => {
  const result = compare(parseWants(text), [at(2)], text, lines);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.report).toContain("missing: line 2: error: bad a");
  expect(result.report).toContain("unexpected: line 3 col 3: error: bad a [t/t]");
  expect(result.report).toContain('3 |   "b": 2');
});

test("a missing finding fails; an extra one fails", () => {
  expect(compare(parseWants(text), [], text, lines).ok).toBe(false);
  expect(compare(parseWants(text), [at(1), at(1, "bad a again")], text, lines).ok).toBe(false);
});

test("a caret line pins the column too", () => {
  // the caret sits under the `1`, column 7
  const caret = '{\n  "a": 1, // want: error: bad\n  //   ^\n}';
  const l = parse("u", caret).lines;
  const d = (character: number): Diagnostic => {
    const start = l.offsetAt({ line: 1, character });
    return { ruleId: "t/t", severity: "error", range: { start, end: start + 1 }, message: "bad" };
  };
  expect(compare(parseWants(caret), [d(7)], caret, l)).toEqual({ ok: true });
  expect(compare(parseWants(caret), [d(2)], caret, l).ok).toBe(false);
});

test("several wants on one line", () => {
  expect(
    parseWants('"a": 1 // want: error: x // want: info: y').map(
      (w) => `${w.severity} ${w.message}`,
    ),
  ).toEqual(["error x", "info y"]);
});

test("UPDATE rewrites annotations so the file then matches", () => {
  const stale = '{\n  "a": 1, // want: warning: old\n  "b": 2\n}';
  const l = parse("u", stale).lines;
  const got = [at(2, "new b")];
  const fresh = rewrite(stale, got, l);
  expect(fresh).toBe('{\n  "a": 1,\n  "b": 2 // want: error: new b\n}');
  expect(compare(parseWants(fresh), got, fresh, parse("u", fresh).lines)).toEqual({ ok: true });
});

test("a throwaway rule runs through the harness with no harness changes", async () => {
  const throwaway = rule({
    id: "style/throwaway",
    description: "test",
    explain: "a rule that exists only in this test",
    defaultSeverity: "info",
    check: ({ doc, report }) =>
      report({ range: { start: 0, end: 1 }, message: `${doc.text.length}` }),
  });
  const got = await runCase(throwaway, "{}");
  expect(got.map((d) => [d.ruleId, d.severity, d.message])).toEqual([
    ["style/throwaway", "info", "2"],
  ]);
});
