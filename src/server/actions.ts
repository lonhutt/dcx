import type { TextDocument } from "vscode-languageserver-textdocument";
import {
  CodeActionKind,
  type CodeAction,
  type Range as LspRange,
  type TextEdit as LspTextEdit,
} from "vscode-languageserver/lib/common/api";
import { fixDocument } from "../lint/fix";
import { diff } from "../rules/deprecation/edits";
import { lspRange, shown, toLsp, type Analysis } from "./diagnostics";

export const FIX_ALL_KIND = `${CodeActionKind.SourceFixAll}.dcx`;
export const FIX_ALL_COMMAND = "dcx.fixAll";

/**
 * A quick fix for each fixable finding that touches `range`. `fix.edits` are already
 * UTF-16 text edits, so this is a relabelling. Nothing when the analysis is of an older
 * version than the document: its offsets would land in the wrong place.
 */
export function quickFixes(
  doc: TextDocument,
  analysis: Analysis | undefined,
  range: LspRange,
): CodeAction[] {
  if (!analysis || analysis.version !== doc.version) return [];
  const [from, to] = [doc.offsetAt(range.start), doc.offsetAt(range.end)];
  return analysis.diagnostics.flatMap((d): CodeAction[] =>
    shown(d) && d.fix && d.range.start <= to && from <= d.range.end
      ? [
          {
            title: d.fix.title,
            kind: CodeActionKind.QuickFix,
            diagnostics: [toLsp(doc, d)],
            isPreferred: true,
            edit: {
              changes: {
                [doc.uri]: d.fix.edits.map((e) => ({
                  range: lspRange(doc, e.range),
                  newText: e.newText,
                })),
              },
            },
          },
        ]
      : [],
  );
}

/** Whether a code action request's `only` asks for dcx's fix-all, directly or by a parent kind. */
export const wantsFixAll = (only: readonly string[] | undefined) =>
  !!only?.some((k) => k === FIX_ALL_KIND || FIX_ALL_KIND.startsWith(`${k}.`));

/**
 * The one edit that applies every fix, through the same engine as `dcx check --fix`;
 * undefined when there's nothing to fix.
 */
export async function fixAllEdit(
  doc: TextDocument,
  path: string,
  lint: Parameters<typeof fixDocument>[2],
): Promise<LspTextEdit | undefined> {
  const before = doc.getText();
  const { text } = await fixDocument(before, path, lint);
  if (text === before) return undefined;
  const e = diff(before, text);
  return { range: lspRange(doc, e.range), newText: e.newText };
}

export const fixAllAction = (doc: TextDocument, edit: LspTextEdit): CodeAction => ({
  title: "Fix all dcx problems",
  kind: FIX_ALL_KIND,
  edit: { changes: { [doc.uri]: [edit] } },
});
