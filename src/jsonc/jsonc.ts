/**
 * The one module that imports `jsonc-parser`. Everything else gets the parser's types and
 * helpers from here, so swapping the parser later only touches this directory.
 *
 * Node offsets and lengths from the parser are already UTF-16 code units, the same unit
 * as {@link Range}; no conversion needed.
 */

import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { LineIndex, type Range } from "../position/position";

export type { Node, ParseError };
export {
  applyEdits,
  findNodeAtLocation,
  findNodeAtOffset,
  getNodeValue,
  modify,
  printParseErrorCode,
} from "jsonc-parser";

/** A parsed devcontainer.json; frozen, built once per text. */
export interface Document {
  readonly uri: string;
  readonly text: string;
  /**
   * The tree, or undefined when the text has no value at all (empty, only comments, or
   * garbage). Partly broken JSON still gets a root; the parser recovers and reports what
   * it skipped in `errors`.
   */
  readonly root: Node | undefined;
  /** Syntax errors, in source order. Trailing commas are allowed, so they never show up here. */
  readonly errors: readonly ParseError[];
  readonly lines: LineIndex;
}

/**
 * Parses `text` as JSONC with trailing commas allowed (one stray comma shouldn't cost the
 * rest of the parse). Never throws, whatever the input.
 */
export function parse(uri: string, text: string): Document {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  return Object.freeze({ uri, text, root, errors, lines: new LineIndex(text) });
}

/** The source span of `node`. Use this rather than doing the offset math by hand. */
export function rangeOf(node: Node): Range {
  return { start: node.offset, end: node.offset + node.length };
}
