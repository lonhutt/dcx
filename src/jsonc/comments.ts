import type { Node } from "jsonc-parser/lib/esm/main.js";
import type { LineIndex, Range } from "../position/position";

/** A `//` or `/* *\/` comment, and the syntax it belongs to if any. */
export interface Comment {
  readonly range: Range;
  /** `/* *\/` rather than `//`. */
  readonly block: boolean;
  /**
   * The property or array element the comment annotates: the one that follows it with
   * no blank line between, or the one it trails on the same line. Undefined when
   * nothing qualifies.
   */
  readonly attached: Node | undefined;
  /** Sits after `attached` on its line, rather than above it. */
  readonly trailing: boolean;
}

/** Properties and array elements in source order: the things a comment can annotate. */
function annotatable(root: Node | undefined): Node[] {
  const out: Node[] = [];
  const walk = (node: Node) => {
    for (const child of node.children ?? []) {
      if (node.type === "object" || node.type === "array") out.push(child);
      walk(child);
    }
  };
  if (root) walk(root);
  return out;
}

const BLANK_LINE = /\n[ \t]*\r?\n|\r[ \t]*\r/;

/**
 * Attaches each comment to the syntax it annotates. Trailing wins over leading, so
 * `"a": 1, // x` belongs to `a` even when `b` follows on the next line.
 */
export function attachComments(
  text: string,
  root: Node | undefined,
  raw: readonly { range: Range; block: boolean }[],
  lines: LineIndex,
): Comment[] {
  const nodes = annotatable(root);
  // gaps are judged with every comment masked, so a stack of comments above a property
  // all attach to it; masked with a non-space, or a comment's own line reads as blank
  const parts: string[] = [];
  let at = 0;
  for (const { range } of raw) {
    parts.push(text.slice(at, range.start), "#".repeat(range.end - range.start));
    at = range.end;
  }
  const masked = parts.join("") + text.slice(at);
  const endOf = (node: Node) => node.offset + node.length;
  // pre-order is already sorted by start; a stable sort by end keeps outer nodes first
  // among equal ends
  const byEnd = [...nodes].sort((a, b) => endOf(a) - endOf(b));

  return raw.map(({ range, block }) => {
    const startLine = lines.lineAt(range.start);
    const endLine = lines.lineAt(range.end);
    const after = nodes[firstIndex(nodes, (n) => n.offset >= range.end)];
    // whatever ends last on the comment's first line, the outer node on a tie:
    // `"a": [1, 2], // x` is about `a`, not `2`
    let i = firstIndex(byEnd, (n) => endOf(n) > range.start) - 1;
    while (i > 0 && endOf(byEnd[i - 1]!) === endOf(byEnd[i]!)) i--;
    const last = byEnd[i];
    const before = last && lines.lineAt(endOf(last)) === startLine ? last : undefined;
    if (before) return { range, block, attached: before, trailing: true };
    if (
      after &&
      lines.lineAt(after.offset) > endLine &&
      !BLANK_LINE.test(masked.slice(range.end, after.offset))
    ) {
      return { range, block, attached: after, trailing: false };
    }
    return { range, block, attached: undefined, trailing: false };
  });
}

/** Index of the first item matching `pred`, which must be false-then-true over `items`. */
function firstIndex<T>(items: readonly T[], pred: (item: T) => boolean): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(items[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The comments before the first property, up to the first blank line: the document's
 * leading block, the only place `dcx-disable-file` is honoured.
 */
export function leadingBlock(
  text: string,
  root: Node | undefined,
  comments: readonly Comment[],
): Comment[] {
  const first = root?.type === "object" ? root.children?.[0] : undefined;
  const limit = first?.offset ?? text.length;
  const out: Comment[] = [];
  for (const c of comments) {
    if (c.range.start >= limit) break;
    const previous = out.at(-1);
    if (previous && BLANK_LINE.test(text.slice(previous.range.end, c.range.start))) break;
    out.push(c);
  }
  return out;
}
