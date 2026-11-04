import { applyEdits, modify } from "../../jsonc/jsonc";
import { rule } from "../util";

export const SCHEMA_URL =
  "https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainer.schema.json";

export const missingName = rule({
  id: "style/missing-name",
  description: 'No "name"; tools will display a generated label',
  explain: `"name" is what the editor shows for the container (in the status bar, the
remote explorer, Codespaces). Without one you get a label made from the folder or image,
which gets confusing with more than one config.

    { "name": "api (Node 22)", "image": "node:22" }`,
  defaultSeverity: "info",
  check({ model, doc, report }) {
    if (doc.root?.type !== "object" || model.properties.has("name")) return;
    report({
      range: { start: doc.root.offset, end: doc.root.offset + 1 },
      message: 'This config has no "name"',
      help: 'add a "name" so the editor can tell this container apart',
      docsUrl: "https://containers.dev/implementors/json_reference/#general-properties",
    });
  },
});

export const missingSchema = rule({
  id: "style/missing-schema",
  description: 'No "$schema"; adding it enables editor completion',
  explain: `A "$schema" property points editors without built-in dev container support
at the schema, so they offer completion and validation as you type.

    { "$schema": "${SCHEMA_URL}", ... }

Off by default; VS Code already knows the schema for devcontainer.json. The fix adds it
as the first property.`,
  defaultSeverity: "off",
  fixable: true,
  check({ model, doc, report }) {
    if (doc.root?.type !== "object" || model.properties.has("$schema")) return;
    const indent = /^([ \t]+)"/m.exec(doc.text)?.[1] ?? "  ";
    const edits = modify(doc.text, ["$schema"], SCHEMA_URL, {
      getInsertionIndex: () => 0,
      formattingOptions: {
        insertSpaces: !indent.startsWith("\t"),
        tabSize: indent.startsWith("\t") ? 1 : indent.length,
        eol: doc.text.includes("\r\n") ? "\r\n" : "\n",
      },
    });
    // one edit: what modify() produced, collapsed so it can't overlap another fix
    const fixed = applyEdits(doc.text, edits);
    let start = 0;
    while (start < doc.text.length && doc.text[start] === fixed[start]) start++;
    let tail = 0;
    while (tail < doc.text.length - start && doc.text.at(-1 - tail) === fixed.at(-1 - tail)) tail++;
    report({
      range: { start: doc.root.offset, end: doc.root.offset + 1 },
      message: 'This config has no "$schema"',
      help: "add it so any JSON-schema-aware editor offers completion",
      fix: {
        title: 'Add "$schema"',
        edits: [
          {
            range: { start, end: doc.text.length - tail },
            newText: fixed.slice(start, fixed.length - tail),
          },
        ],
      },
    });
  },
});
