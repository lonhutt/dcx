import { describe, expect, test } from "bun:test";
import { assertNoSplitSurrogate, LineIndex, type Range } from "./position";

describe("line structure", () => {
  test.each<[string, string, number]>([
    ["empty is one line", "", 1],
    ["no trailing newline", "a\nb", 2],
    ["trailing newline adds an empty final line", "a\n", 2],
    ["two trailing newlines", "a\n\n", 3],
    ["crlf", "a\r\nb", 2],
    ["lone cr is a terminator", "a\rb", 2],
    ["mixed terminators", "a\r\nb\nc\rd", 4],
    ["only a newline", "\n", 2],
    ["cr then crlf is two terminators", "\r\r\n", 3],
  ])("%s", (_, text, lines) => {
    const ix = new LineIndex(text);
    expect(ix.lineCount).toBe(lines);
    // EOF has to be addressable; any node's end offset can land there
    expect(ix.lineAt(text.length)).toBe(lines - 1);
  });

  test("lineStart of each line in a mixed-terminator document", () => {
    const ix = new LineIndex("a\r\nb\nc\rd");
    expect([0, 1, 2, 3].map((l) => ix.lineStart(l))).toEqual([0, 3, 5, 7]);
  });
});

describe("lineRange is the visible extent, excluding the terminator", () => {
  test.each<[string, string, number, string]>([
    ["lf: first line", "a\nb", 0, "a"],
    ["lf: last line has no terminator", "a\nb", 1, "b"],
    ["crlf sheds both units", "a\r\nb", 0, "a"],
    ["crlf: second line", "a\r\nb", 1, "b"],
    ["lone cr is a terminator", "a\rb", 0, "a"],
    ["empty document is one empty line", "", 0, ""],
    ["trailing lf leaves an empty final line", "a\n", 1, ""],
    ["empty line between terminators", "a\n\nb", 1, ""],
    ["only a terminator", "\n", 0, ""],
    ["cjk", "中文\n", 0, "中文"],
    ["astral", "😀\n", 0, "😀"],
  ])("%s", (_, text, line, want) => {
    const r = new LineIndex(text).lineRange(line);
    expect(r.start).toBeLessThanOrEqual(r.end);
    expect(text.slice(r.start, r.end)).toBe(want);
  });
});

describe("positionAt", () => {
  test("offsets are UTF-16 code units, so an emoji advances character by 2", () => {
    const ix = new LineIndex("😀x");
    expect(ix.positionAt(2)).toEqual({ line: 0, character: 2 });
    expect(ix.positionAt(3)).toEqual({ line: 0, character: 3 });
  });

  test("the offset of a terminator is the end of its own line", () => {
    const ix = new LineIndex("a\nb");
    expect(ix.positionAt(1)).toEqual({ line: 0, character: 1 });
    expect(ix.positionAt(2)).toEqual({ line: 1, character: 0 });
  });

  test("an offset inside a surrogate pair is reported as-is, not snapped", () => {
    expect(new LineIndex("😀").positionAt(1)).toEqual({ line: 0, character: 1 });
  });
});

// A character past the end of a line falls back to the visible length. Clamping to the
// end of the document instead lets it walk into the next line, and an LSP incremental
// didChange would splice there.
describe("offsetAt clamps character to the line's visible end", () => {
  test.each<[string, string, number, number, number]>([
    ["past end of line stops at visible end", "a\nbbbb\n", 0, 3, 1],
    ["far past end", "a\nbbbb\n", 0, 99, 1],
    ["exactly at visible end", "a\nbbbb\n", 0, 1, 1],
    ["the terminator itself is not addressable", "a\nbbbb\n", 0, 2, 1],
    ["middle line clamps to its own end", "a\nbbbb\n", 1, 99, 6],
    ["last line without a terminator", "a\nb", 1, 99, 3],
    ["empty final line", "a\n", 1, 5, 2],
    ["crlf sheds both units", "a\r\nb", 0, 5, 1],
    ["astral: one code point is two units", "😀x\n", 0, 2, 2],
    ["astral: clamp past end", "😀x\n", 0, 99, 3],
    ["negative character is the line start", "a\nbb", 1, -3, 2],
  ])("%s", (_, text, line, character, want) => {
    expect(new LineIndex(text).offsetAt({ line, character })).toBe(want);
  });
});

// An offset between "\r" and "\n" isn't a real position; it snaps back to the "\r", and
// the result round-trips to that snapped offset.
describe("an offset inside a CRLF pair snaps to the CR", () => {
  test.each<[string, string, number, number, number, number]>([
    ["between cr and lf", "a\r\nb", 2, 0, 1, 1],
    ["crlf at the start of the document", "\r\nb", 1, 0, 0, 0],
    ["crlf on a later line", "a\r\nbb\r\n", 6, 1, 2, 5],
    ["astral before the crlf", "😀\r\n", 3, 0, 2, 2],
    ["crlf after a lone cr", "\r\r\n", 2, 1, 0, 1],
  ])("%s", (_, text, offset, line, character, back) => {
    const ix = new LineIndex(text);
    expect(ix.positionAt(offset)).toEqual({ line, character });
    expect(ix.offsetAt({ line, character })).toBe(back);
    expect(ix.terminalPositionAt(offset).line).toBe(line + 1);
  });
});

// nothing throws; a stale offset can outlive the edit that shortened the document, and
// an LSP client can send any line it wants
describe("out-of-range input clamps instead of throwing", () => {
  const ix = new LineIndex("a\nbb\n"); // 3 lines: "a", "bb", ""

  test.each<[string, () => unknown, unknown]>([
    ["lineStart negative", () => ix.lineStart(-5), 0],
    ["lineStart past end", () => ix.lineStart(99), 5],
    ["lineRange negative", () => ix.lineRange(-5), { start: 0, end: 1 }],
    ["lineRange past end", () => ix.lineRange(99), { start: 5, end: 5 }],
    ["lineAt negative offset", () => ix.lineAt(-5), 0],
    ["lineAt offset past EOF", () => ix.lineAt(99), 2],
    ["positionAt negative offset", () => ix.positionAt(-5), { line: 0, character: 0 }],
    ["positionAt offset past EOF", () => ix.positionAt(99), { line: 2, character: 0 }],
    ["offsetAt negative line", () => ix.offsetAt({ line: -5, character: 0 }), 0],
    ["offsetAt line past end", () => ix.offsetAt({ line: 99, character: 0 }), 5],
    ["terminalPositionAt negative", () => ix.terminalPositionAt(-5), { line: 1, column: 1 }],
    ["terminalPositionAt past EOF", () => ix.terminalPositionAt(99), { line: 3, column: 1 }],
  ])("%s", (_, call, want) => {
    expect(call).not.toThrow();
    expect(call()).toEqual(want);
  });
});

// "😀" is 2 code units, 1 code point and 2 columns. Units matching columns is a
// coincidence; the ZWJ family below is 8 units, 5 code points and still 2 columns.
describe("terminalPositionAt measures display width", () => {
  test.each<[string, string, number, number]>([
    ["ascii", "abc", 2, 3],
    ["cjk is two columns each", "中文x", 2, 5],
    ["half-width katakana is one column", "ｱｲx", 2, 3],
    ["a combining mark is zero columns", "éx", 2, 2],
    ["astral emoji", "😀x", 2, 3],
    ["zwj family is one 2-column glyph, not a sum of code points", "👨‍👩‍👧x", 8, 3],
    ["regional-indicator flag", "🇯🇵x", 4, 3],
    ["leading tab advances to the first stop", "\tx", 1, 9],
    ["tab after text advances to the next stop", "ab\tx", 3, 9],
    ["tab after a wide char", "中\tx", 2, 9],
    ["tab at an exact stop advances a full stop", "12345678\tx", 9, 17],
    ["two tabs", "\t\t", 2, 17],
  ])("%s", (_, text, offset, column) => {
    expect(new LineIndex(text).terminalPositionAt(offset)).toEqual({ line: 1, column });
  });

  test("tabWidth controls the stop", () => {
    const ix = new LineIndex("ab\tx");
    expect(ix.terminalPositionAt(3, 4)).toEqual({ line: 1, column: 5 });
    expect(ix.terminalPositionAt(3, 2)).toEqual({ line: 1, column: 5 });
    expect(ix.terminalPositionAt(3, 1)).toEqual({ line: 1, column: 4 });
  });

  test("width restarts on each line, and the line is 1-based", () => {
    expect(new LineIndex("中中\n中x").terminalPositionAt(4)).toEqual({ line: 2, column: 3 });
  });
});

describe("assertNoSplitSurrogate", () => {
  const text = "a😀b"; // units: a, \uD83D, \uDE00, b

  test.each<[string, Range]>([
    ["whole text", { start: 0, end: 4 }],
    ["exactly the emoji", { start: 1, end: 3 }],
    ["empty range at a boundary", { start: 3, end: 3 }],
    ["document edges", { start: 0, end: 0 }],
  ])("accepts %s", (_, range) => {
    expect(() => assertNoSplitSurrogate(text, range)).not.toThrow();
  });

  test.each<[string, Range]>([
    ["start inside the pair", { start: 2, end: 4 }],
    ["end inside the pair", { start: 0, end: 2 }],
    ["empty range inside the pair", { start: 2, end: 2 }],
  ])("rejects %s", (_, range) => {
    // match the message; otherwise any throw passes (a stub's included)
    expect(() => assertNoSplitSurrogate(text, range)).toThrow(/surrogate/i);
  });

  test("a lone surrogate has no pair to split", () => {
    expect(() => assertNoSplitSurrogate("\uD83Dx", { start: 1, end: 2 })).not.toThrow();
    expect(() => assertNoSplitSurrogate("x\uDE00", { start: 1, end: 2 })).not.toThrow();
  });
});
