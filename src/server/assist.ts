import type { TextDocument } from "vscode-languageserver-textdocument";
import {
  CompletionItemKind,
  MarkupKind,
  type CompletionItem,
  type Hover,
} from "vscode-languageserver/lib/common/api";
import { findNodeAtLocation, getLocation, parse, type Node } from "../jsonc/jsonc";
import { describe, propertiesAt, valuesAt } from "../schema/describe";
import { docsUrl } from "../schema/docs-url";
import { lspRange } from "./diagnostics";

/** The spec's description of the property under `offset`, over its key or its value. */
export function hover(doc: TextDocument, offset: number): Hover | undefined {
  const text = doc.getText();
  const location = getLocation(text, offset);
  // an array element has no description of its own; its property does
  const path = location.path.slice();
  while (typeof path.at(-1) === "number") path.pop();
  const names = path as string[];
  if (!names.length || names.at(-1) === "") return undefined;
  const d = describe(names);
  if (!d) return undefined;
  const node = location.previousNode;
  const value = [
    `**${names.join(".")}**`,
    d.deprecated ? `*Deprecated:* ${d.deprecated}` : undefined,
    d.description,
    `[Reference](${docsUrl(names)})`,
  ].filter(Boolean);
  return {
    contents: { kind: MarkupKind.Markdown, value: value.join("\n\n") },
    ...(node && { range: lspRange(doc, { start: node.offset, end: node.offset + node.length }) }),
  };
}

/**
 * Property names in key position, allowed values in value position. Which one comes from
 * the parser's view of the cursor, which also works mid-edit, in a document that doesn't
 * parse yet.
 */
export function completions(doc: TextDocument, offset: number): CompletionItem[] {
  const text = doc.getText();
  const location = getLocation(text, offset);
  const typed = location.previousNode;
  // `"name": "x" "ima|` (no comma yet) reads as a value; the property node says otherwise
  const atKey = location.isAtPropertyKey || typed?.type === "property";
  const replace = (newText: string) =>
    typed
      ? { range: lspRange(doc, { start: typed.offset, end: typed.offset + typed.length }), newText }
      : { range: lspRange(doc, { start: offset, end: offset }), newText };

  if (atKey) {
    const objectPath = location.path.slice(0, -1);
    const present = new Set(keysOf(text, objectPath));
    const current = location.path.at(-1);
    return propertiesAt(objectPath)
      .filter((p) => p.name === current || !present.has(p.name))
      .map((p) => ({
        label: p.name,
        kind: CompletionItemKind.Property,
        ...(p.description && { documentation: p.description }),
        textEdit: replace(typed ? JSON.stringify(p.name) : `${JSON.stringify(p.name)}: `),
      }));
  }
  return valuesAt(location.path).map((v) => ({
    label: JSON.stringify(v),
    kind: typeof v === "boolean" ? CompletionItemKind.Value : CompletionItemKind.EnumMember,
    textEdit: replace(JSON.stringify(v)),
  }));
}

/** The keys already in the object at `path`, as far as the parser could recover it. */
function keysOf(text: string, path: readonly (string | number)[]): string[] {
  const root = parse("", text).root;
  const object: Node | undefined =
    root && (path.length ? findNodeAtLocation(root, [...path]) : root);
  if (object?.type !== "object") return [];
  return (object.children ?? []).flatMap((p) => {
    const key = p.children?.[0]?.value;
    return typeof key === "string" ? [key] : [];
  });
}
