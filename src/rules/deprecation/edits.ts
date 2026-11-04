import type { TextEdit } from "../../diagnostic/diagnostic";
import { applyEdits, findNodeAtLocation, modify, parse, type Document } from "../../jsonc/jsonc";

type JSONPath = (string | number)[];

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
 * The one edit that makes every change in `changes` (a value to set, or `undefined` to
 * remove), in order. Each `modify()` is computed against the text the previous ones left,
 * then the whole thing is collapsed to a single replacement of the span that differs, so
 * a fix's edits can never overlap.
 */
export function rewrite(
  doc: Document,
  changes: readonly { path: JSONPath; value: unknown }[],
): TextEdit[] | undefined {
  const options = { formattingOptions: formatting(doc.text) };
  let text = doc.text;
  try {
    for (const { path, value } of changes)
      text =
        value === undefined
          ? remove(text, path)
          : applyEdits(text, modify(text, path, value, options));
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
  const after = /^\s*,/.exec(text.slice(end));
  if (after) end += after[0].length;
  else {
    // the last member: take the comma before it instead, past any comments in between
    const siblings = property.parent!.children!;
    const previous = siblings[siblings.indexOf(property) - 1];
    if (previous) {
      const from = previous.offset + previous.length;
      const comma = text.indexOf(",", from);
      if (comma >= 0 && comma < start) text = text.slice(0, comma) + " " + text.slice(comma + 1);
    }
  }
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, start))) {
    const eol = /^[ \t]*\r?\n/.exec(text.slice(end));
    // nothing else on the line: drop it; a comment after it: keep it, at the old indent
    if (eol) [start, end] = [lineStart, end + eol[0].length];
    else end += /^[ \t]*/.exec(text.slice(end))![0].length;
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

/** Moves the top-level property `from` to `to`, merging into what's already there. */
export function moveProperty(
  doc: Document,
  from: string,
  to: JSONPath,
  merged: unknown,
): TextEdit[] | undefined {
  return rewrite(doc, [
    { path: [from], value: undefined },
    { path: to, value: merged },
  ]);
}
