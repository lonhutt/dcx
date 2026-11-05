import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type {
  CodeAction,
  CompletionItem,
  Hover,
  PublishDiagnosticsParams,
} from "vscode-languageserver/lib/common/api";
import { URI } from "vscode-uri";

const extensionDir = join(import.meta.dir, "..");
const sandbox = mkdtempSync(join(tmpdir(), "dcx-vscode-"));
const manifest = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));
const source = (name: string) => readFileSync(join(extensionDir, "src", name), "utf8");

beforeAll(() => {
  const build = Bun.spawnSync([process.execPath, "run", "build"], { cwd: extensionDir });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
}, 30_000); // windows runners blow through the 5s default on a build
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

// Under Node, not Bun: the extension host is Node, so a Bun-only API that slips into the
// bundle passes every other test and only breaks inside VS Code. Over stdio rather than
// the IPC the client uses, which only differs in the transport the library sets up.
test("the bundled server, under Node, lints, hovers, completes and fixes", async () => {
  const path = join(sandbox, ".devcontainer.json");
  const text = '{"name": "x", "image": "node:22", "nmae": "y", "extensions": ["a.b"]}';
  writeFileSync(path, text);
  const uri = URI.file(path).toString();

  const child = spawn("node", [join(extensionDir, "dist", "server.js"), "--stdio"], {
    cwd: sandbox,
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const client = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  const published = new Promise<PublishDiagnosticsParams>((resolve) =>
    client.onNotification("textDocument/publishDiagnostics", resolve),
  );
  client.onNotification("window/logMessage", () => {});
  client.listen();

  await client.sendRequest("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    initializationOptions: { run: "onSave" },
  });
  await client.sendNotification("initialized", {});
  await client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "jsonc", version: 1, text },
  });

  const { diagnostics } = await published;
  const unknown = diagnostics.find((d) => d.code === "schema/unknown-property")!;
  expect(unknown).toMatchObject({
    range: { start: { line: 0, character: 34 }, end: { line: 0, character: 40 } },
    message: 'Unknown property "nmae"; did you mean "name"?\nrename it to "name"',
    source: "dcx",
    codeDescription: {
      href: "https://github.com/lonhutt/dcx/blob/main/RULES.md#schemaunknown-property",
    },
  });

  const textDocument = { uri };
  const hover = await client.sendRequest<Hover>("textDocument/hover", {
    textDocument,
    position: { line: 0, character: 3 },
  });
  expect((hover.contents as { value: string }).value).toContain("**name**");
  const items = await client.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument,
    position: { line: 0, character: 1 },
  });
  expect(items.map((i) => i.label)).toContain("forwardPorts");
  const actions = await client.sendRequest<CodeAction[]>("textDocument/codeAction", {
    textDocument,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: [], only: ["source.fixAll"] },
  });
  expect(actions.map((a) => a.kind)).toEqual(["source.fixAll.dcx"]);

  await client.sendRequest("shutdown");
  await client.sendNotification("exit");
  expect(await exited).toBe(0);
  client.dispose();
}, 30_000);

// the extension is a client now; linting in-process as well would be two of everything
test("no rules or analyser are left in the client", () => {
  expect(existsSync(join(extensionDir, "src", "diagnostics.ts"))).toBe(false);
  for (const name of ["extension.ts", "client.ts", "config.ts"])
    expect(source(name)).not.toMatch(/from "\.\.\/\.\.\/\.\.\/src\/(?!server\/(server|protocol)")/);
  const bundle = readFileSync(join(extensionDir, "dist", "extension.js"), "utf8");
  expect(bundle).not.toContain("schema/unknown-property");
});

// Just enough of the vscode API to load the bundle (the language client subclasses these)
// and activate it; what it registers and says is written to results.json on exit.
const stub = (settings: Record<string, unknown>, activeFile: string) => `
const results = { commands: {}, messages: [] };
const classes = "CompletionItem CodeLens DocumentLink CodeAction Diagnostic CallHierarchyItem TypeHierarchyItem SymbolInformation InlayHint CancellationError".split(" ");
const disposable = { dispose() {} };
process.on("exit", () => require("fs").writeFileSync("results.json", JSON.stringify({ ...results, commands: Object.keys(results.commands) })));
module.exports = {
  ...Object.fromEntries(classes.map((c) => [c, class {}])),
  results,
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    activeTextEditor: { document: { fileName: ${JSON.stringify(activeFile)}, uri: { toString: () => "file:///x" } } },
    showInformationMessage: (m) => results.messages.push(m),
    showErrorMessage: (m) => results.messages.push(m),
  },
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (k in ${JSON.stringify(settings)} ? ${JSON.stringify(settings)}[k] : d),
      inspect: () => ({}),
    }),
    onDidChangeConfiguration: () => disposable,
  },
  commands: { registerCommand: (id, fn) => ((results.commands[id] = fn), disposable) },
};`;

async function activate(settings: Record<string, unknown>, activeFile: string, run = "") {
  const dir = mkdtempSync(join(sandbox, "activate-"));
  mkdirSync(join(dir, "node_modules", "vscode"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "vscode", "index.js"), stub(settings, activeFile));
  copyFileSync(join(extensionDir, "dist", "extension.js"), join(dir, "extension.js"));
  writeFileSync(
    join(dir, "run.cjs"),
    `require("./extension.js").activate({ subscriptions: [] }).then(() => { ${run} });`,
  );
  const node = Bun.spawnSync(["node", "run.cjs"], { cwd: dir });
  expect(node.exitCode, node.stderr.toString()).toBe(0);
  return JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
}

// Under Node for the same reason as the server: a load-time crash only shows up there
test("with dcx.enable off, the client bundle activates under Node and starts nothing", async () => {
  const fix = `return require("vscode").results.commands["dcx.fixAll"]();`;
  const off = await activate({ enable: false }, "/w/.devcontainer.json", fix);
  expect(off.commands.sort()).toEqual(
    manifest.contributes.commands.map((c: { command: string }) => c.command).sort(),
  );
  expect(off.messages).toEqual([
    "dcx: the language server isn't running; check dcx.enable, or dcx: Show Output",
  ]);
  const elsewhere = await activate({ enable: false }, "/w/Dockerfile", fix);
  expect(elsewhere.messages).toEqual(["dcx: open a devcontainer.json to fix"]);
}, 30_000);

// dcx.trace.server is read by the language client, through the client's id
test("every setting the extension reads is declared", () => {
  const read = [...source("config.ts").matchAll(/c\.(?:get|inspect)(?:<\w+>)?\("([^"]+)"/g)].map(
    (m) => `dcx.${m[1]}`,
  );
  expect([...read, "dcx.trace.server"].sort()).toEqual(
    Object.keys(manifest.contributes.configuration.properties).sort(),
  );
});
