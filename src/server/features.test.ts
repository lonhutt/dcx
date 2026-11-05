import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import type {
  CodeAction,
  CompletionItem,
  DocumentLink,
  Hover,
  Location,
  TextEdit,
} from "vscode-languageserver/lib/common/api";
import type { Diagnostic } from "../diagnostic/diagnostic";
import { parse } from "../jsonc/jsonc";
import { propertiesAt } from "../schema/describe";
import { fixAllEdit } from "./actions";
import { FIX_ALL_COMMAND } from "./protocol";
import { lspPair } from "../testutil/lsp";
import { MemFS } from "../vfs/memfs";

const PATH = join("/w", ".devcontainer", "devcontainer.json");
const FIXTURES = join(import.meta.dir, "..", "..", "testdata", "fix");

let pair: ReturnType<typeof lspPair> | undefined;
async function opened(text: string, files: Record<string, string> = {}, path = PATH) {
  pair = lspPair({ fs: new MemFS({ "/w/.git/HEAD": "", ...files, [path]: text }) });
  await pair.initialize();
  await pair.open(path, text);
  return {
    p: pair,
    textDocument: { uri: pair.uriOf(path) },
    doc: TextDocument.create(pair.uriOf(path), "jsonc", 1, text),
  };
}
afterEach(async () => {
  await pair?.dispose();
  pair = undefined;
});

const applied = (text: string, edits: readonly TextEdit[]) =>
  TextDocument.applyEdits(TextDocument.create("file:///x", "jsonc", 1, text), [...edits]);

/** The line and character of the first `marker` in `text`, after removing it. */
function cursor(withMarker: string, marker = "|") {
  const offset = withMarker.indexOf(marker);
  const text = withMarker.replace(marker, "");
  return { text, position: TextDocument.create("file:///x", "jsonc", 1, text).positionAt(offset) };
}

describe("code actions", () => {
  const cases = readdirSync(FIXTURES).filter(
    (f) => f.endsWith(".jsonc") && !f.endsWith(".fixed.jsonc"),
  );

  // the fix-all action is the engine's output, so it has to match the CLI's goldens exactly
  test.each(cases)("fix-all on %s matches its .fixed.jsonc", async (name) => {
    const before = await Bun.file(join(FIXTURES, name)).text();
    const config = Bun.file(join(FIXTURES, name.replace(/\.jsonc$/, ".dcx.yaml")));
    const files: Record<string, string> = { "/w/.devcontainer/Dockerfile": "FROM x\nARG V\n" };
    if (await config.exists()) files["/w/.dcx.yaml"] = await config.text();
    const { p, textDocument } = await opened(before, files);
    await p.diagnostics(PATH);
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const actions = await p.request<CodeAction[]>("textDocument/codeAction", {
      textDocument,
      range,
      context: { diagnostics: [], only: ["source.fixAll"] },
    });
    expect(actions).toHaveLength(1);
    const after = applied(before, actions[0]!.edit!.changes![textDocument.uri]!);
    expect(after).toBe(
      await Bun.file(join(FIXTURES, name.replace(/\.jsonc$/, ".fixed.jsonc"))).text(),
    );
  });

  test("each fixable finding under the cursor gets a quick fix that applies cleanly", async () => {
    const text = '{\n  "name": "x",\n  "image": "node:22",\n  "extensions": ["a.b"]\n}\n';
    const { p, textDocument } = await opened(text);
    const found = await p.diagnostics(PATH);
    const target = found.find((d) => d.code === "deprecation/root-extensions")!;
    const actions = await p.request<CodeAction[]>("textDocument/codeAction", {
      textDocument,
      range: target.range,
      context: { diagnostics: [target] },
    });
    expect(actions.map((a) => a.kind)).toEqual(["quickfix"]);
    const after = applied(text, actions[0]!.edit!.changes![textDocument.uri]!);
    expect(parse("f", after).errors).toEqual([]);
    expect(after).toContain('"customizations"');
  });

  test("fixes that would collide still come out as one edit and a valid document", async () => {
    const text =
      '{\n  "name": "x",\n  "image": "node:22",\n  "settings": {"a": 1},\n  "extensions": ["a.b"]\n}\n';
    const { p, textDocument } = await opened(text);
    await p.diagnostics(PATH);
    const actions = await p.request<CodeAction[]>("textDocument/codeAction", {
      textDocument,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { diagnostics: [], only: ["source.fixAll.dcx"] },
    });
    const edits = actions[0]!.edit!.changes![textDocument.uri]!;
    expect(edits).toHaveLength(1);
    const after = applied(text, edits);
    expect(parse("f", after).errors).toEqual([]);
    expect(JSON.parse(after).customizations.vscode).toEqual({
      settings: { a: 1 },
      extensions: ["a.b"],
    });
  });

  test("the fix-all command asks the client to apply the same edit", async () => {
    const text = '{\n  "name": "x",\n  "image": "node:22",\n  "extensions": ["a.b"]\n}\n';
    const { p, textDocument } = await opened(text);
    await p.request("workspace/executeCommand", {
      command: FIX_ALL_COMMAND,
      arguments: [textDocument.uri],
    });
    expect(p.applied).toHaveLength(1);
  });

  // with run: onSave nothing re-analyses on an edit, so the fix has to come from the edited text
  test("after an unsaved edit, the quick fix is for the text as it is now", async () => {
    const text = '{\n  "name": "x",\n  "image": "node:22",\n  "extensions": ["a.b"]\n}\n';
    pair = lspPair({ fs: new MemFS({ "/w/.git/HEAD": "", [PATH]: text }) });
    const p = pair;
    await p.initialize({}, { run: "onSave" });
    await p.open(PATH, text);
    const target = (await p.diagnostics(PATH)).find(
      (d) => d.code === "deprecation/root-extensions",
    )!;
    const edited = '{\n  "name": "xyz",' + text.slice(text.indexOf('\n  "image'));
    await p.change(PATH, {
      range: { start: { line: 1, character: 11 }, end: { line: 1, character: 11 } },
      text: "yz",
    });
    const textDocument = { uri: p.uriOf(PATH) };
    const actions = await p.request<CodeAction[]>("textDocument/codeAction", {
      textDocument,
      range: target.range,
      context: { diagnostics: [target] },
    });
    expect(actions.map((a) => a.kind)).toEqual(["quickfix"]);
    const after = applied(edited, actions[0]!.edit!.changes![textDocument.uri]!);
    expect(JSON.parse(after)).toEqual({
      name: "xyz",
      image: "node:22",
      customizations: { vscode: { extensions: ["a.b"] } },
    });
  });
});

describe("hover", () => {
  test.each(propertiesAt([]).map((p) => p.name))("%s has a description", async (name) => {
    const { text, position } = cursor(`{ "${name.slice(0, 1)}|${name.slice(1)}": null }`);
    const { p, textDocument } = await opened(text);
    const h = await p.request<Hover | null>("textDocument/hover", { textDocument, position });
    expect((h!.contents as { value: string }).value).toContain(`**${name}**`);
  });

  test("over a value, and over an array element, it describes the property", async () => {
    const { text, position } = cursor('{ "forwardPorts": [3000, 30|01] }');
    const { p, textDocument } = await opened(text);
    const h = await p.request<Hover | null>("textDocument/hover", { textDocument, position });
    expect((h!.contents as { value: string }).value).toContain("**forwardPorts**");
  });

  test("nested properties describe themselves", async () => {
    const { text, position } = cursor('{ "build": { "docker|file": "Dockerfile" } }');
    const { p, textDocument } = await opened(text);
    const h = await p.request<Hover | null>("textDocument/hover", { textDocument, position });
    expect((h!.contents as { value: string }).value).toContain("relative to the folder");
  });
});

describe("completion", () => {
  const complete = async (withCursor: string) => {
    const { text, position } = cursor(withCursor);
    const { p, textDocument } = await opened(text);
    return p.request<CompletionItem[]>("textDocument/completion", { textDocument, position });
  };

  test("property names in key position, without the ones already there", async () => {
    const labels = (await complete('{ "image": "x", | }')).map((c) => c.label);
    expect(labels).toContain("forwardPorts");
    expect(labels).not.toContain("image");
    expect(labels).not.toContain('"none"');
  });

  test("enum values in value position, and no property names", async () => {
    const labels = (await complete('{ "shutdownAction": | }')).map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['"none"', '"stopContainer"']));
    expect(labels).not.toContain("forwardPorts");
  });

  test("a half-typed key in a document that doesn't parse still completes, replacing what's typed", async () => {
    const { text, position } = cursor('{ "name": "x" "forw|');
    const { p, textDocument, doc } = await opened(text);
    const items = await p.request<CompletionItem[]>("textDocument/completion", {
      textDocument,
      position,
    });
    const item = items.find((c) => c.label === "forwardPorts")!;
    const edit = item.textEdit as TextEdit;
    expect(TextDocument.applyEdits(doc, [edit])).toBe('{ "name": "x" "forwardPorts"');
  });

  test.each([
    ['{ "init": t|', "true", '{ "init": true'],
    ["{ ima|", "image", '{ "image": '],
  ])("a bare word is replaced, not appended to: %s", async (typed, label, want) => {
    const { text, position } = cursor(typed);
    const { p, textDocument, doc } = await opened(text);
    const items = await p.request<CompletionItem[]>("textDocument/completion", {
      textDocument,
      position,
    });
    const item = items.find((c) => c.label === label)!;
    expect(TextDocument.applyEdits(doc, [item.textEdit as TextEdit])).toBe(want);
  });

  test("nested objects complete their own properties", async () => {
    const labels = (await complete('{ "build": { | } }')).map((c) => c.label);
    expect(labels).toEqual(["args", "cacheFrom", "context", "dockerfile", "options", "target"]);
  });
});

describe("links and definition", () => {
  const compose = "services:\n  db:\n    image: postgres\n  app:\n    build: .\n";

  test("links go to files that exist, resolved from the config's folder", async () => {
    const text =
      '{\n  "build": { "dockerfile": "../Dockerfile", "context": ".." },\n  "features": { "./tool": {}, "./gone": {} }\n}';
    const { p, textDocument } = await opened(text, {
      "/w/Dockerfile": "FROM x",
      "/w/.devcontainer/tool/devcontainer-feature.json": "{}",
    });
    const links = await p.request<DocumentLink[]>("textDocument/documentLink", { textDocument });
    expect(links.map((l) => l.target)).toEqual([
      p.uriOf("/w/Dockerfile"),
      p.uriOf("/w/.devcontainer/tool/devcontainer-feature.json"),
    ]);
    const first = links[0]!.range;
    expect(text.split("\n")[1]!.slice(first.start.character, first.end.character)).toBe(
      "../Dockerfile",
    );
  });

  test("a root-level .devcontainer.json links relative to its own folder", async () => {
    const path = "/w/.devcontainer.json";
    const { p, textDocument } = await opened(
      '{ "dockerComposeFile": ["a.yml", "missing.yml"], "service": "app" }',
      { "/w/a.yml": compose },
      path,
    );
    const links = await p.request<DocumentLink[]>("textDocument/documentLink", { textDocument });
    expect(links.map((l) => l.target)).toEqual([p.uriOf("/w/a.yml")]);
  });

  test("definition jumps from service to its key, across every Compose file", async () => {
    const { text, position } = cursor(
      '{ "dockerComposeFile": ["../a.yml", "../b.yml"], "service": "a|pp" }',
    );
    const { p, textDocument } = await opened(text, {
      "/w/a.yml": compose,
      "/w/b.yml": "services:\n  app:\n    environment: {}\n",
    });
    const found = await p.request<Location[]>("textDocument/definition", {
      textDocument,
      position,
    });
    expect(found).toEqual([
      {
        uri: p.uriOf("/w/a.yml"),
        range: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } },
      },
      {
        uri: p.uriOf("/w/b.yml"),
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
      },
    ]);
  });

  test("anywhere but the service value, there's no definition", async () => {
    const { text, position } = cursor('{ "dockerComposeFile": "../a.yml", "serv|ice": "app" }');
    const { p, textDocument } = await opened(text, { "/w/a.yml": compose });
    expect(
      await p.request<Location[]>("textDocument/definition", { textDocument, position }),
    ).toEqual([]);
  });
});

test("fix-all gives up if the document changes while it's working", async () => {
  const doc = TextDocument.create("file:///w/devcontainer.json", "jsonc", 1, "{}");
  let passes = 0;
  const edit = await fixAllEdit(doc, "/w/devcontainer.json", async (): Promise<Diagnostic[]> => {
    // the client's next keystroke lands while the lint is awaited
    if (passes++) return [];
    TextDocument.update(doc, [{ text: "{ }" }], 2);
    const range = { start: 1, end: 1 };
    return [
      {
        ruleId: "x/y",
        severity: "warning",
        range,
        message: "m",
        fix: { title: "t", edits: [{ range, newText: '"a": 1' }] },
      },
    ];
  });
  expect(edit).toBeUndefined();
});
