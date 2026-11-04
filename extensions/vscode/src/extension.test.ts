import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extensionDir = join(import.meta.dir, "..");
const sandbox = mkdtempSync(join(tmpdir(), "dcx-vscode-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
const manifest = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));

// Just enough of the vscode API for activate(); positionAt returns the raw offset so
// the test can check ranges against the text.
const stub = (settings: Record<string, unknown>) => `
const set = [], errors = [], commands = [];
class Range { constructor(start, end) { Object.assign(this, { start, end }); } }
class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
class Location { constructor(uri, range) { Object.assign(this, { range }); } }
class DiagnosticRelatedInformation { constructor(location, message) { Object.assign(this, { location, message }); } }
const event = () => () => ({ dispose() {} });
const doc = (fileName, text) => ({ fileName, uri: { toString: () => fileName, fsPath: fileName, scheme: "file" }, getText: () => text, positionAt: (o) => o });
const settings = ${JSON.stringify(settings)};
module.exports = {
  Range, Diagnostic, Location, DiagnosticRelatedInformation,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
  Uri: { parse: (s) => s },
  languages: { createDiagnosticCollection: () => ({ set: (uri, d) => set.push({ uri: uri.toString(), d }), delete() {}, clear() {} }) },
  workspace: {
    textDocuments: [
      doc(${JSON.stringify(join(sandbox, "w", ".devcontainer.json"))}, '{"name": "x", "image": "node:22", "nmae": "y", "privileged": "yes"}'),
      doc(${JSON.stringify(join(sandbox, "w", "package.json"))}, "{"),
    ],
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
    workspaceFolders: undefined,
    onDidOpenTextDocument: event(), onDidSaveTextDocument: event(), onDidChangeTextDocument: event(),
    onDidCloseTextDocument: event(), onDidChangeConfiguration: event(),
    asRelativePath: String,
  },
  window: { showErrorMessage: (m) => errors.push(m), createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
  commands: { registerCommand: (id) => (commands.push(id), { dispose() {} }) },
  results: { set, errors, commands },
};`;

async function activate(settings: Record<string, unknown> = {}) {
  mkdirSync(join(sandbox, "node_modules", "vscode"), { recursive: true });
  mkdirSync(join(sandbox, "w"), { recursive: true });
  writeFileSync(join(sandbox, "node_modules", "vscode", "index.js"), stub(settings));
  copyFileSync(join(extensionDir, "dist", "extension.js"), join(sandbox, "extension.js"));
  writeFileSync(
    join(sandbox, "run.cjs"),
    `require("./extension.js").activate({ subscriptions: [] });
     setTimeout(() => console.log(JSON.stringify(require("vscode").results)), 500);`,
  );
  const run = Bun.spawnSync(["node", "run.cjs"], { cwd: sandbox });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return JSON.parse(run.stdout.toString());
}

// Under Node, not Bun: the extension host is Node, so a Bun-only API that slips into the
// bundle passes every other test and only breaks inside VS Code.
test("the bundled extension lints open devcontainer.json files under Node", async () => {
  const build = Bun.spawnSync([process.execPath, "run", "build"], { cwd: extensionDir });
  expect(build.exitCode, build.stderr.toString()).toBe(0);

  const results = await activate();
  expect(results.errors).toEqual([]);
  expect(results.set).toHaveLength(1);
  const [unknown, privileged] = results.set[0].d;
  expect(unknown).toEqual({
    range: { start: 34, end: 40 },
    message: 'Unknown property "nmae"; did you mean "name"?\nrename it to "name"',
    severity: 1,
    source: "dcx",
    code: {
      value: "schema/unknown-property",
      target: "https://github.com/lonhutt/dcx/blob/main/RULES.md#schemaunknown-property",
    },
  });
  expect(privileged).toMatchObject({ severity: 0, code: { value: "schema/type-mismatch" } });
}, 30_000); // a build plus a cold node start; windows runners blow through the 5s default

test("dcx.enable: false lints nothing", async () => {
  expect((await activate({ enable: false })).set).toEqual([]);
}, 30_000);

test("every command in package.json is registered, and nothing else", async () => {
  const { commands } = await activate();
  expect([...commands].sort()).toEqual(
    manifest.contributes.commands.map((c: { command: string }) => c.command).sort(),
  );
}, 30_000);

test("every setting the extension reads is declared", () => {
  const source = readFileSync(join(extensionDir, "src", "config.ts"), "utf8");
  const read = [...source.matchAll(/c\.get(?:<\w+>)?\("([^"]+)"/g)].map((m) => `dcx.${m[1]}`);
  expect(read.sort()).toEqual(Object.keys(manifest.contributes.configuration.properties).sort());
});
