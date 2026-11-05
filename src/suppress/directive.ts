import type { Comment, Document } from "../jsonc/jsonc";
import type { Range } from "../position/position";

export type Scope = "next-line" | "line" | "file";

/** A `dcx-disable-*` comment. */
export interface Directive {
  readonly scope: Scope;
  /** Empty means every rule. */
  readonly ruleIds: readonly string[];
  /** Whatever follows ` -- `. */
  readonly reason?: string;
  /** The comment itself. */
  readonly range: Range;
  /** The 0-based lines it covers, inclusive. */
  readonly lines: { readonly first: number; readonly last: number };
}

const KEYWORDS: Record<string, Scope> = {
  "dcx-disable-next-line": "next-line",
  "dcx-disable-line": "line",
  "dcx-disable-file": "file",
};

/** The comment's text without its `//` or `/* *\/`. */
function body(doc: Document, c: Comment): string {
  const raw = doc.text.slice(c.range.start, c.range.end);
  return (c.block ? raw.slice(2, -2) : raw.slice(2)).trim();
}

/**
 * Every directive in the document. `dcx-disable-file` only counts in the leading comment
 * block; anywhere else, and a misspelt keyword, it's an ordinary comment.
 */
export function parseDirectives(doc: Document): Directive[] {
  const leading = new Set(doc.leadingComments);
  return doc.comments.flatMap((c) => {
    const text = body(doc, c);
    const keyword = text.split(/\s/, 1)[0]!;
    const scope = KEYWORDS[keyword];
    if (!scope || (scope === "file" && !leading.has(c))) return [];
    // indexOf, not split: a reason may itself contain " -- "
    const rest = text.slice(keyword.length);
    const cut = rest.indexOf(" -- ");
    const ids = (cut < 0 ? rest : rest.slice(0, cut)).split(/[\s,]+/).filter(Boolean);
    const reason = cut < 0 ? undefined : rest.slice(cut + 4).trim() || undefined;
    const startLine = doc.lines.lineAt(c.range.start);
    const endLine = doc.lines.lineAt(c.range.end);
    const lines =
      scope === "file"
        ? { first: 0, last: doc.lines.lineCount - 1 }
        : scope === "line"
          ? { first: startLine, last: startLine }
          : { first: endLine + 1, last: endLine + 1 };
    return [{ scope, ruleIds: ids, ...(reason && { reason }), range: c.range, lines }];
  });
}
