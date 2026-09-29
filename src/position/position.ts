/**
 * The single coordinate system for the whole tool (Design §5.2, §4.2 invariant 3).
 *
 * Everything internal is a UTF-16 code-unit {@link Offset} — the unit JS strings,
 * `jsonc-parser` and LSP `Position` all share. Conversion to a display column happens
 * only at the terminal edge, and only here: no caller outside `src/position` builds a
 * line/column pair by hand.
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

/**
 * Line structure of one document, built once and queried many times.
 *
 * `\n`, `\r\n` and a lone `\r` all terminate a line. A document ending in a terminator
 * has a final empty line, and EOF is always addressable. No method throws: every
 * out-of-range input clamps into the document (invariant 1).
 *
 * TODO(DCL-03): not implemented.
 */
export class LineIndex {
  /** Records every line-start offset of `text` in a single pass. */
  constructor(text: string) {
    throw new Error("not implemented");
  }

  /** Number of lines; always at least 1, even for an empty document. */
  get lineCount(): number {
    throw new Error("not implemented");
  }

  /** Offset at which `line` begins; `line` clamps to `[0, lineCount - 1]`. */
  lineStart(line: number): Offset {
    throw new Error("not implemented");
  }

  /** 0-based line containing `offset`; `offset` clamps to `[0, text.length]`. */
  lineAt(offset: Offset): number {
    throw new Error("not implemented");
  }

  /**
   * Visible extent of `line`, excluding its terminator, so a highlight over a whole line
   * never wraps into the next. `line` clamps as in {@link lineStart}.
   */
  lineRange(line: number): Range {
    throw new Error("not implemented");
  }

  /**
   * LSP position of `offset`. An offset inside a `\r\n` pair is not a position; it snaps
   * back to the `\r`. An offset inside a surrogate pair is returned as-is — rejecting
   * those is {@link assertNoSplitSurrogate}'s job, not this one's.
   */
  positionAt(offset: Offset): Position {
    throw new Error("not implemented");
  }

  /**
   * Inverse of {@link positionAt}. `line` clamps to the document; a `character` past
   * the line's visible end falls back to that end, per the LSP convention — never into
   * the terminator or the next line.
   */
  offsetAt(position: Position): Offset {
    throw new Error("not implemented");
  }

  /**
   * Terminal position of `offset`: the column is 1 plus the display width of the line
   * text before it, with East Asian wide characters counting 2, combining marks 0, and
   * each tab advancing to the next multiple of `tabWidth`. Clamps like {@link positionAt}.
   */
  terminalPositionAt(offset: Offset, tabWidth = 8): TerminalPosition {
    throw new Error("not implemented");
  }
}

/**
 * Throws — with "surrogate" in the message — if either end of `range` falls between the
 * two halves of a surrogate pair in `text`. A development-build guard for `Range` construction sites the parser does not
 * already guarantee; a lone (unpaired) surrogate has no pair to split and is accepted.
 *
 * TODO(DCL-03): not implemented.
 */
export function assertNoSplitSurrogate(text: string, range: Range): void {
  throw new Error("not implemented");
}
