/**
 * The one module that imports `jsonc-parser`. Everything else gets the parser's types and
 * helpers from here, so swapping the parser later only touches this directory.
 *
 * Node offsets and lengths from the parser are already UTF-16 code units, the same unit
 * as {@link Range}; no conversion needed.
 */

// The ESM build, not the package's default UMD one: UMD loads its own files with runtime
// require() calls a bundler can't follow, so a Node-target bundle breaks on load.
import { parseTree, visit, type Node, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { LineIndex, type Offset, type Range } from "../position/position";
import { attachComments, leadingBlock, type Comment } from "./comments";
import { containersByOffset, type TrailingComma } from "./separators";

export type { Comment, Node, ParseError, TrailingComma };
export {
  applyEdits,
  findNodeAtLocation,
  findNodeAtOffset,
  getLocation,
  getNodeValue,
  modify,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js";

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
  /** Every comment, in source order; `parseTree` drops them, so they live here. */
  readonly comments: readonly Comment[];
  /** The comments before the first property, up to the first blank line. */
  readonly leadingComments: readonly Comment[];
  /** Trailing commas are legal, so the parse never reports them; this is the only record. */
  readonly trailingCommas: readonly TrailingComma[];
}

/**
 * Parses `text` as JSONC with trailing commas allowed (one stray comma shouldn't cost the
 * rest of the parse). Never throws, whatever the input.
 */
export function parse(uri: string, text: string): Document {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  const lines = new LineIndex(text);
  const { comments: raw, trailing } = scan(text);
  const containers = containersByOffset(root);
  const trailingCommas = trailing.flatMap(({ offset, container }) => {
    const node = containers.get(container);
    return node ? [{ offset, container: node }] : [];
  });
  const comments = attachComments(text, root, raw, lines);
  const leadingComments = leadingBlock(text, root, comments);
  return Object.freeze({
    uri,
    text,
    root,
    errors,
    lines,
    comments,
    leadingComments,
    trailingCommas,
  });
}

/**
 * One `visit()` pass for what `parseTree` throws away: comments, and commas followed
 * directly by a closing bracket. Containers are tracked by opening offset, since the
 * visitor never hands over a node.
 */
function scan(text: string) {
  const comments: { range: Range; block: boolean }[] = [];
  const trailing: { offset: Offset; container: Offset }[] = [];
  const open: Offset[] = [];
  let comma: Offset | undefined;
  const close = () => {
    const container = open.pop();
    if (comma !== undefined && container !== undefined) trailing.push({ offset: comma, container });
    comma = undefined;
  };
  const token = () => (comma = undefined);
  visit(
    text,
    {
      onObjectBegin: (offset) => {
        token();
        open.push(offset);
      },
      onArrayBegin: (offset) => {
        token();
        open.push(offset);
      },
      onObjectEnd: close,
      onArrayEnd: close,
      onObjectProperty: token,
      onLiteralValue: token,
      onSeparator: (character, offset) => (comma = character === "," ? offset : undefined),
      onComment: (offset, length) =>
        comments.push({
          range: { start: offset, end: offset + length },
          block: text.startsWith("/*", offset),
        }),
    },
    { allowTrailingComma: true },
  );
  return { comments, trailing };
}

/** The raw source spelling of `node`, escapes and all; spans inside it stay exact. */
export function textOf(doc: Document, node: Node): string {
  return doc.text.slice(node.offset, node.offset + node.length);
}

/** The source span of `node`. Use this rather than doing the offset math by hand. */
export function rangeOf(node: Node): Range {
  return { start: node.offset, end: node.offset + node.length };
}
