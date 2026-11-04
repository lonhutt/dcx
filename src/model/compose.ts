import { isMap, parseDocument } from "yaml";

/**
 * The service names defined across `files`, in order, without duplicates. Only the
 * `services` key list is read: no interpolation, no `extends`, no merging (design
 * decision 1). Resolves `undefined` when any file can't be read (`read` gives
 * `undefined`) or parsed reliably; that's a reason to skip a check, not an error.
 */
export async function readServices(
  read: (file: string) => Promise<string | undefined>,
  files: readonly string[],
): Promise<string[] | undefined> {
  const names = new Set<string>();
  for (const file of files) {
    const text = await read(file);
    if (text === undefined) return undefined;
    const services = servicesOf(text);
    if (!services) return undefined;
    services.forEach((s) => names.add(s));
  }
  return [...names];
}

function servicesOf(text: string): string[] | undefined {
  // catch only around the parse; a bug below it should surface, not quietly skip the rule
  let doc;
  try {
    doc = parseDocument(text, { uniqueKeys: false });
  } catch {
    return undefined;
  }
  if (doc.errors.length || !isMap(doc.contents)) return undefined;
  const services = doc.contents.get("services", true);
  if (!isMap(services)) return undefined;
  const keys = services.items.map((p) => (p.key as { value?: unknown } | null)?.value);
  // a merge key at this level means names come from somewhere we don't follow
  if (keys.some((k) => typeof k !== "string" || k === "<<")) return undefined;
  return keys as string[];
}
