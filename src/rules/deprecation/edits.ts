import type { TextEdit } from "../../diagnostic/diagnostic";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  textOf,
  type Document,
  type Node,
} from "../../jsonc/jsonc";

type JSONPath = (string | number)[];

/** A node's source text, comments and all, and the indent of the line it starts on. */
export interface Verbatim {
  readonly text: string;
  readonly indent: string;
}

/**
 * One change at `path`: set `value`, or write `raw` source text there (inserted into an
 * array at that index when `insert`), or, with neither, remove the property.
 */
export interface Change {
  readonly path: JSONPath;
  readonly value?: unknown;
  readonly raw?: Verbatim;
  readonly insert?: boolean;
}

const PLACEHOLDER = JSON.stringify("\u0000dcx-verbatim");

export function verbatim(doc: Document, node: Node): Verbatim {
  const lineStart = doc.text.lastIndexOf("\n", node.offset - 1) + 1;
  return { text: textOf(doc, node), indent: /^[ \t]*/.exec(doc.text.slice(lineStart))![0] };
}

/** The document's own indentation and line ending, so a fix doesn't reformat around it. */
function formatting(text: string) {
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

/**
 * The one edit that makes every change in `changes`, in order. Each is computed against
 * the text the previous ones left, then the whole thing is collapsed to a single
 * replacement of the span that differs, so a fix's edits can never overlap.
 */
export function rewrite(doc: Document, changes: readonly Change[]): TextEdit[] | undefined {
  const formattingOptions = formatting(doc.text);
  let text = doc.text;
  try {
    for (const c of changes) {
      if (c.raw) text = place(text, c.path, c.raw, !!c.insert, formattingOptions);
      else if (c.value === undefined) text = remove(text, c.path);
      else text = applyEdits(text, modify(text, c.path, c.value, { formattingOptions }));
    }
  } catch {
    // modify() can't write through a non-object (a "customizations": 0); no fix, then
    return undefined;
  }
  return [diff(doc.text, text)];
}

/** `{ fix }` to spread into a finding, or nothing when the edits couldn't be made. */
export const fixWith = (title: string, edits: readonly TextEdit[] | undefined) =>
  edits ? { fix: { title, edits } } : {};

/**
 * Writes `raw` at `path`: `modify()` only takes values, and a value has lost its
 * comments, so it writes a placeholder that's then swapped for the source text,
 * re-indented to where it now sits.
 */
function place(
  text: string,
  path: JSONPath,
  raw: Verbatim,
  insert: boolean,
  formattingOptions: ReturnType<typeof formatting>,
): string {
  if (text.includes(PLACEHOLDER)) throw new Error("placeholder already in the document");
  const out = applyEdits(
    text,
    modify(text, path, JSON.parse(PLACEHOLDER), { formattingOptions, isArrayInsertion: insert }),
  );
  const at = out.indexOf(PLACEHOLDER);
  const indent = /^[ \t]*/.exec(out.slice(out.lastIndexOf("\n", at - 1) + 1))![0];
  const body = raw.text
    .split("\n")
    .map((line, i) =>
      i === 0
        ? line
        : indent + (line.startsWith(raw.indent) ? line.slice(raw.indent.length) : line.trimStart()),
    )
    .join("\n");
  return out.slice(0, at) + body + out.slice(at + PLACEHOLDER.length);
}

/** The first comma in `text` between `from` and `to`, skipping comments; -1 if none. */
function commaBetween(text: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    if (text.startsWith("//", i)) i = text.indexOf("\n", i) < 0 ? to : text.indexOf("\n", i);
    else if (text.startsWith("/*", i))
      i = text.indexOf("*/", i + 2) < 0 ? to : text.indexOf("*/", i + 2) + 1;
    else if (text[i] === ",") return i;
  }
  return -1;
}

/**
 * Removes the property at `path` and one adjoining comma, but none of the comments around
 * it: `modify()` would take a comment on the same line, or the one above, with it. A line
 * left holding only whitespace goes too.
 */
function remove(text: string, path: JSONPath): string {
  const root = parse("", text).root;
  const value = root && findNodeAtLocation(root, path);
  const property = value?.parent;
  if (!property || property.type !== "property") return text;
  let start = property.offset;
  let end = property.offset + property.length;
  const parent = property.parent!;
  const siblings = parent.children!;
  const next = siblings[siblings.indexOf(property) + 1];
  const previous = siblings[siblings.indexOf(property) - 1];
  // its own comma, past any comments; the last member takes the one before it instead
  const after = commaBetween(text, end, next ? next.offset : parent.offset + parent.length - 1);
  if (after >= 0) text = text.slice(0, after) + text.slice(after + 1);
  else if (previous) {
    const before = commaBetween(text, previous.offset + previous.length, start);
    if (before >= 0) text = text.slice(0, before) + " " + text.slice(before + 1);
  }
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, start))) {
    const eol = /^[ \t]*\r?\n/.exec(text.slice(end));
    // nothing else on the line: drop it; a comment after it: keep it, at the old indent
    if (eol) [start, end] = [lineStart, end + eol[0].length];
    else end += /^[ \t]*/.exec(text.slice(end))![0].length;
  } else if (/^[ \t]*\r?\n/.test(text.slice(end))) {
    // something stays before it on the line: don't leave that trailing whitespace
    start -= /[ \t]*$/.exec(text.slice(lineStart, start))![0].length;
  }
  return text.slice(0, start) + text.slice(end);
}

/** One edit turning `before` into `after`: everything between their common prefix and suffix. */
function diff(before: string, after: string): TextEdit {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return {
    range: { start, end: before.length - end },
    newText: after.slice(start, after.length - end),
  };
}

/** Removes the top-level property `from`, then makes `into`, the changes that put it back elsewhere. */
export function moveProperty(
  doc: Document,
  from: string,
  into: readonly Change[],
): TextEdit[] | undefined {
  return rewrite(doc, [{ path: [from] }, ...into]);
}
