import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LineIndex, type Position, type TerminalPosition } from "./position";

// Reference implementation LineIndex is checked against. It's slow on purpose (linear
// scan for the line, subtraction for the character, split on tabs for the column) so
// that when the two disagree, the bug is in LineIndex. Keep it dumb.
//
// Line starts are computed once per document, not per call; otherwise the large fixture
// is O(n²).
//
// Bun.stringWidth is trusted for everything but tabs (it says a tab is 0 wide); glyph
// widths are the library's problem, not ours.

class Oracle {
  readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\r" && text[i + 1] === "\n") i++;
      if (text[i] === "\n" || text[i] === "\r") this.starts.push(i + 1);
    }
  }

  /** What LineIndex should treat `offset` as; clamped and snapped out of a CRLF. */
  canonical(offset: number): number {
    const o = Math.min(Math.max(offset, 0), this.text.length);
    return this.text[o - 1] === "\r" && this.text[o] === "\n" ? o - 1 : o;
  }

  positionAt(offset: number): Position {
    const o = this.canonical(offset);
    let line = 0;
    for (let i = 0; i < this.starts.length; i++) if (this.starts[i]! <= o) line = i;
    return { line, character: o - this.starts[line]! };
  }

  terminalPositionAt(offset: number, tabWidth: number): TerminalPosition {
    const { line, character } = this.positionAt(offset);
    const start = this.starts[line]!;
    const segments = this.text.slice(start, start + character).split("\t");
    let width = 0;
    segments.forEach((segment, i) => {
      width += Bun.stringWidth(segment);
      if (i < segments.length - 1) width = (Math.floor(width / tabWidth) + 1) * tabWidth;
    });
    return { line: line + 1, column: width + 1 };
  }
}

/**
 * Diffs LineIndex against the oracle at every offset in `text`, round trip included.
 * Returns the first mismatch (or undefined) so a failure shows the input, not just
 * `expected true`.
 */
function firstMismatch(text: string, tabWidth = 8) {
  const ix = new LineIndex(text);
  const oracle = new Oracle(text);
  if (ix.lineCount !== oracle.starts.length) {
    return { text, lineCount: ix.lineCount, want: oracle.starts.length };
  }
  for (let offset = 0; offset <= text.length; offset++) {
    const position = ix.positionAt(offset);
    const wantPosition = oracle.positionAt(offset);
    if (position.line !== wantPosition.line || position.character !== wantPosition.character) {
      return { text, offset, position, want: wantPosition };
    }
    const back = ix.offsetAt(position);
    if (back !== oracle.canonical(offset)) {
      return { text, offset, position, roundTrip: back, want: oracle.canonical(offset) };
    }
    const terminal = ix.terminalPositionAt(offset, tabWidth);
    const wantTerminal = oracle.terminalPositionAt(offset, tabWidth);
    if (terminal.line !== wantTerminal.line || terminal.column !== wantTerminal.column) {
      return { text, offset, tabWidth, terminal, want: wantTerminal };
    }
  }
  return undefined;
}

const fixture = (name: string) => Bun.file(join(import.meta.dir, "testdata", name)).text();

describe("LineIndex agrees with the oracle at every offset", () => {
  test.each<[string, string]>([
    ["empty", ""],
    ["ascii", '{\n  "image": "ubuntu"\n}\n'],
    ["bmp", "é中ｱ\ńx"],
    ["astral", "😀\n👨‍👩‍👧 🇯🇵\n"],
    ["every terminator", "a\r\nb\nc\rd\r\r\n\n"],
    ["tabs", "\ta\t\tb\n中\t😀\tx"],
  ])("%s", (_, text) => {
    expect(firstMismatch(text)).toBeUndefined();
  });

  test("mixed-script fixture", async () => {
    const text = await fixture("mixed-script.jsonc");
    for (const tabWidth of [1, 2, 4, 8]) expect(firstMismatch(text, tabWidth)).toBeUndefined();
  });

  test("large real-world fixture", async () => {
    expect(firstMismatch(await fixture("large-commented.jsonc"))).toBeUndefined();
  });
});

// Bun has no coverage-guided fuzzer, so this is a seeded loop instead. The
// pieces are weighted toward what breaks position code (terminators, tabs, surrogates,
// zero and double width glyphs); uniform Unicode would be almost all plain letters.
describe("property: random documents", () => {
  const pieces = [
    "a",
    "Z",
    " ",
    "{",
    '"',
    "\n",
    "\r\n",
    "\r",
    "\t",
    "中",
    "ｱ",
    "́",
    "😀",
    "👨‍👩‍👧",
    "🇯🇵",
    "\uD83D", // lone surrogate; malformed, but a string (or a file) can still hold one
  ];

  /** mulberry32; a tiny seeded PRNG, so a failure reproduces from the seed. */
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("every offset converts, and converts back, for 500 seeded documents", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const random = rng(seed);
      const length = Math.floor(random() * 40);
      const text = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join(
        "",
      );
      const tabWidth = [1, 2, 4, 8][Math.floor(random() * 4)]!;
      const mismatch = firstMismatch(text, tabWidth);
      expect(mismatch && { seed, ...mismatch }).toBeUndefined();
    }
  });
});
