import { dirname, join } from "node:path";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { DocumentLink, Location } from "vscode-languageserver/lib/common/api";
import { URI } from "vscode-uri";
import { parse } from "../jsonc/jsonc";
import { workspaceRoot } from "../lint/analyze";
import { serviceKeys } from "../model/compose";
import { lower } from "../model/lower";
import { LineIndex } from "../position/position";
import { references } from "../rules/fs/rules";
import { resolveRef } from "../rules/fs/resolve";
import type { FileSystem } from "../vfs/vfs";
import { lspRange } from "./diagnostics";

/**
 * Links for the files the config refers to: the Dockerfile, each Compose file, and each
 * local feature's devcontainer-feature.json. Only ones that exist; a dead link is worse
 * than none. The build context is a directory, which an editor can't open, so it gets none.
 */
export async function documentLinks(
  doc: TextDocument,
  path: string,
  fs: FileSystem,
): Promise<DocumentLink[]> {
  const model = lower(parse(path, doc.getText()));
  const [root, dir] = [workspaceRoot(path), dirname(path)];
  const links: DocumentLink[] = [];
  for (const ref of references(model)) {
    if (ref.what === "build context") continue;
    const r = await resolveRef(fs, root, dir, ref.field.value);
    if (r.escapes || r.kind !== ref.want) continue;
    const target = ref.want === "file" ? r.path : join(r.path, "devcontainer-feature.json");
    if ((await fs.stat(target))?.kind !== "file") continue;
    const node = ref.field.node;
    // inside the quotes: the link is the path, not the JSON string
    links.push({
      range: lspRange(doc, { start: node.offset + 1, end: node.offset + node.length - 1 }),
      target: URI.file(target).toString(),
    });
  }
  return links;
}

/** From `"service"`'s value to that service's key in whichever Compose file defines it. */
export async function definition(
  doc: TextDocument,
  path: string,
  offset: number,
  fs: FileSystem,
): Promise<Location[]> {
  const model = lower(parse(path, doc.getText()));
  const service = model.string("service");
  const node = service?.node;
  if (!service || !node || offset < node.offset || offset > node.offset + node.length) return [];
  const [root, dir] = [workspaceRoot(path), dirname(path)];
  const out: Location[] = [];
  for (const file of model.composeFiles) {
    const r = await resolveRef(fs, root, dir, file.value);
    if (r.escapes || r.kind !== "file") continue;
    const text = await fs.readFile(r.path).catch(() => undefined);
    const key =
      text === undefined ? undefined : serviceKeys(text)?.find((k) => k.name === service.value);
    if (!key) continue;
    const lines = new LineIndex(text!);
    out.push({
      uri: URI.file(r.path).toString(),
      range: { start: lines.positionAt(key.range.start), end: lines.positionAt(key.range.end) },
    });
  }
  return out;
}
