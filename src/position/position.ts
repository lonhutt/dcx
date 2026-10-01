/**
 * Coordinates for the whole tool.
 *
 * Everything internal is a UTF-16 code-unit {@link Offset}; it's the unit JS strings,
 * `jsonc-parser` and LSP `Position` already share. Display columns only exist at the
 * terminal edge, and only here (nothing outside `src/position` builds a line/column
 * pair by hand).
 */

/** A UTF-16 code-unit offset into a document's text. */
export type Offset = number;

/** A half-open span `[start, end)` of UTF-16 code units. */
export interface Range {
  readonly start: Offset;
  readonly end: Offset;
}

/** LSP-shaped position: 0-based line, 0-based UTF-16 code-unit character. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

/** Terminal-shaped position: 1-based line, 1-based column measured in display width. */
export interface TerminalPosition {
  readonly line: number;
  readonly column: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

const CR = 0x0d;
const LF = 0x0a;

/**
 * Line structure of one document; built once, queried many times.
 *
 * `\n`, `\r\n` and a lone `\r` all end a line. A trailing terminator leaves an empty
 * final line, so EOF is always addressable. Nothing throws; out-of-range input clamps
 * into the document (an LSP server has to stay up through stale offsets).
 */
export class LineIndex {
  /** Where each line starts. Sorted, `starts[0] === 0`, one entry per line. */
  private readonly starts: Offset[] = [0];

  /** Records every line-start offset of `text` in a single pass. */
  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === CR && text.charCodeAt(i + 1) === LF) i++;
      if (c === LF || c === CR) this.starts.push(i + 1);
    }
  }

  /** Number of lines; always at least 1, even for an empty document. */
  get lineCount(): number {
    return this.starts.length;
  }

  /** Offset at which `line` begins; `line` clamps to `[0, lineCount - 1]`. */
  lineStart(line: number): Offset {
    return this.starts[clamp(line, 0, this.starts.length - 1)]!;
  }

  /** 0-based line containing `offset`; `offset` clamps to `[0, text.length]`. */
  lineAt(offset: Offset): number {
    const o = clamp(offset, 0, this.text.length);
    // last line whose start is <= o. mid rounds up; otherwise `lo = mid` can spin forever
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= o) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Visible extent of `line`, terminator excluded; a whole-line highlight shouldn't wrap
   * into the next one. `line` clamps as in {@link lineStart}.
   */
  lineRange(line: number): Range {
    const l = clamp(line, 0, this.starts.length - 1);
    const start = this.starts[l]!;
    let end = l + 1 < this.starts.length ? this.starts[l + 1]! : this.text.length;
    if (end > start && this.text.charCodeAt(end - 1) === LF) end--;
    if (end > start && this.text.charCodeAt(end - 1) === CR) end--;
    return { start, end };
  }

  /**
   * LSP position of `offset`. An offset inside a `\r\n` pair snaps back to the `\r`.
   * One inside a surrogate pair is left alone; that's {@link assertNoSplitSurrogate}'s job.
   */
  positionAt(offset: Offset): Position {
    const o = this.canonical(offset);
    const line = this.lineAt(o);
    return { line, character: o - this.starts[line]! };
  }

  /**
   * Inverse of {@link positionAt}. `line` clamps to the document, and a `character` past
   * the visible end falls back to it (the LSP convention); never into the terminator.
   */
  offsetAt(position: Position): Offset {
    if (position.line < 0) return 0;
    const { start, end } = this.lineRange(position.line);
    return start + clamp(position.character, 0, end - start);
  }

  /**
   * Terminal position of `offset`, 1-based. Column is display width: wide CJK counts 2,
   * combining marks 0, and tabs jump to the next multiple of `tabWidth`. Clamps like
   * {@link positionAt}.
   */
  terminalPositionAt(offset: Offset, tabWidth = 8): TerminalPosition {
    const { line, character } = this.positionAt(offset);
    const start = this.starts[line]!;
    // Bun.stringWidth says a tab is 0 wide, and a tab's real width depends on where it
    // lands; so walk the runs between tabs. Measure each run whole (per code point, a ZWJ
    // emoji counts once per member).
    const runs = this.text.slice(start, start + character).split("\t");
    let width = 0;
    runs.forEach((run, i) => {
      width += Bun.stringWidth(run);
      if (i < runs.length - 1) width = (Math.floor(width / tabWidth) + 1) * tabWidth;
    });
    return { line: line + 1, column: width + 1 };
  }

  /** `offset` clamped into the document and snapped out of a `\r\n` pair. */
  private canonical(offset: Offset): Offset {
    const o = clamp(offset, 0, this.text.length);
    const insideCrlf = this.text.charCodeAt(o - 1) === CR && this.text.charCodeAt(o) === LF;
    return insideCrlf ? o - 1 : o;
  }
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Throws (with "surrogate" in the message) if either end of `range` splits a surrogate
 * pair in `text`. A dev-build guard for ranges the parser didn't produce; a lone
 * surrogate has nothing to split, so it passes.
 */
export function assertNoSplitSurrogate(text: string, range: Range): void {
  for (const o of [range.start, range.end]) {
    // charCodeAt, not codePointAt; codePointAt returns the whole pair and hides the half
    // we're checking. Out of range is NaN, which fails both checks, so edges are fine.
    if (isHighSurrogate(text.charCodeAt(o - 1)) && isLowSurrogate(text.charCodeAt(o))) {
      throw new Error(`offset ${o} splits a surrogate pair`);
    }
  }
}
