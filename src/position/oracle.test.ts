import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LineIndex, type Position, type TerminalPosition } from "./position";

// This file is the reference implementation LineIndex is tested against.
//
// Everything here is deliberately the slowest, most obviously correct code that could
// work: a linear scan for the line, a subtraction for the character, and a split on
// tabs for the column. Nothing in it should ever be made clever. Its only job is to be
// so simple that when it disagrees with LineIndex, the bug is in LineIndex.
//
// The one concession is that line starts are computed once per document rather than
// per call — without it the large fixture is O(n²) in splitting alone.
//
// Bun.stringWidth is trusted for everything except tabs (it reports a tab as 0
// columns). The oracle only has to get the tab-stop walk obviously right; per-glyph
// width rules are the library's job, not ours.

class Oracle {
  readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\r" && text[i + 1] === "\n") i++;
      if (text[i] === "\n" || text[i] === "\r") this.starts.push(i + 1);
    }
  }

  /** The offset LineIndex must treat `offset` as: clamped, and snapped out of a CRLF. */
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
 * Diffs LineIndex against the oracle at every code-unit offset in `text`, and checks the
 * round trip. Returns the first disagreement, or undefined — so a failure prints the
 * input that caused it rather than a bare `expected true`.
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

// No coverage-guided fuzzer exists for Bun (Design §11), so this is a seeded loop over
// generated documents. The generator is weighted toward the inputs that break position
// code — terminators, tabs, surrogate pairs, zero- and double-width glyphs — rather than
// uniform over Unicode, where almost everything would be an unremarkable BMP letter.
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
    "\uD83D", // a lone surrogate: malformed, but a string can hold it and so can a file
  ];

  /** mulberry32: a tiny seeded PRNG, so a failure reproduces from its seed alone. */
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
