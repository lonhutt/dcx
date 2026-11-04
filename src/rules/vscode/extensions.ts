import { elements, isString, member, type Field } from "../../model/model";
import type { Pass } from "../rule";

export interface ExtensionEntry {
  readonly field: Field<string>;
  readonly publisher: string;
  readonly name: string;
  readonly version?: string;
  /** A leading `-`: remove an extension a feature or image would otherwise add. */
  readonly excluded: boolean;
}

const ID = /^(-?)([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9_-]*)(?:@([^\s@]+))?$/i;

/** Lowercased, for lookup keys only; never shown back to the user. */
export const normaliseId = (id: string) => id.toLowerCase();

export function parseExtensionId(s: string): Omit<ExtensionEntry, "field"> | undefined {
  const m = ID.exec(s.trim());
  if (!m) return undefined;
  return { excluded: m[1] === "-", publisher: m[2]!, name: m[3]!, ...(m[4] && { version: m[4] }) };
}

/** `customizations.vscode.extensions`' string entries, with `ok` false for a malformed one. */
export function extensionEntries(
  pass: Pass,
): { field: Field<string>; entry: ReturnType<typeof parseExtensionId> }[] {
  const list = member(member(pass.model.get("customizations")?.node, "vscode")?.node, "extensions");
  if (!list || list.node.type !== "array") return [];
  return elements(list.node)
    .filter(isString)
    .map((field) => ({ field, entry: parseExtensionId(field.value) }));
}
