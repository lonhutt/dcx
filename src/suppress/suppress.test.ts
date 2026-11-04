import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "../diagnostic/diagnostic";
import { parse } from "../jsonc/jsonc";
import { apply } from "./apply";
import { parseDirectives } from "./directive";

/** A finding for `ruleId` at the start of 0-based `line` of `text`. */
function at(text: string, line: number, ruleId = "a/b"): Diagnostic {
  const start = parse("u", text).lines.lineStart(line);
  return { ruleId, severity: "error", range: { start, end: start + 1 }, message: "m" };
}

function run(text: string, findings: Diagnostic[]) {
  const doc = parse("u", text);
  const result = apply(findings, parseDirectives(doc), doc.lines);
  return {
    suppressed: result.diagnostics.map((d) => !!d.suppressed),
    unused: result.unused.map((u) => u.scope),
  };
}

describe("each scope covers exactly its lines", () => {
  // line 0 `{`, 1 the directive line, 2 the line after, 3 the line after that
  test.each<[string, string, boolean[]]>([
    [
      "next-line",
      '{\n  // dcx-disable-next-line a/b\n  "x": 1,\n  "y": 2\n}',
      [false, false, true, false],
    ],
    [
      "line",
      '{\n  "x": 1, // dcx-disable-line a/b\n  "y": 2,\n  "z": 3\n}',
      [false, true, false, false],
    ],
  ])("%s", (_, text, want) => {
    expect(
      run(
        text,
        [0, 1, 2, 3].map((l) => at(text, l)),
      ).suppressed,
    ).toEqual(want);
  });

  test("file covers the whole document from the leading block", () => {
    const text = '// dcx-disable-file a/b\n{\n  "x": 1\n}';
    expect(run(text, [at(text, 0), at(text, 2)]).suppressed).toEqual([true, true]);
  });

  test("next-line counts from where a multi-line block comment ends", () => {
    const text = '{\n  /* dcx-disable-next-line a/b\n     because */\n  "x": 1\n}';
    expect(run(text, [at(text, 2), at(text, 3)]).suppressed).toEqual([false, true]);
  });
});

test("dcx-disable-file mid-document is an ordinary comment", () => {
  const text = '{\n  "x": 1,\n\n  // dcx-disable-file a/b\n  "y": 2\n}';
  expect(parseDirectives(parse("u", text))).toEqual([]);
});

test("a directive names only the rules it lists; an empty list means all", () => {
  const listed = '{\n  // dcx-disable-next-line a/b c/d\n  "x": 1\n}';
  expect(
    run(listed, [at(listed, 2, "a/b"), at(listed, 2, "c/d"), at(listed, 2, "e/f")]).suppressed,
  ).toEqual([true, true, false]);
  const all = '{\n  // dcx-disable-next-line\n  "x": 1\n}';
  expect(run(all, [at(all, 2, "e/f")]).suppressed).toEqual([true]);
});

test("the reason survives, including one that itself contains ' -- '", () => {
  const text = '{\n  "x": 1 // dcx-disable-line a/b -- CI needs it -- really\n}';
  const doc = parse("u", text);
  const [d] = apply([at(text, 1)], parseDirectives(doc), doc.lines).diagnostics;
  expect(d!.suppressReason).toBe("CI needs it -- really");
});

test("a directive that suppressed nothing is reported unused", () => {
  const text = '{\n  // dcx-disable-next-line a/b\n  "x": 1\n}';
  expect(run(text, []).unused).toEqual(["next-line"]);
  expect(run(text, [at(text, 2, "z/z")]).unused).toEqual(["next-line"]);
});

test("two directives covering one finding are both used", () => {
  const text = '// dcx-disable-file a/b\n{\n  "x": 1 // dcx-disable-line a/b\n}';
  expect(run(text, [at(text, 2)]).unused).toEqual([]);
});

test("a misspelt keyword is a plain comment, not an error", () => {
  expect(parseDirectives(parse("u", '{\n  // dcx-disable-nextline a/b\n  "x": 1\n}'))).toEqual([]);
});
