import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extensionDir = join(import.meta.dir, "..");
const sandbox = mkdtempSync(join(tmpdir(), "dcx-vscode-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

// Just enough of the vscode API for activate(); positionAt returns the raw offset so
// the test can check ranges against the text.
const stub = `
const set = [], errors = [];
class Range { constructor(start, end) { Object.assign(this, { start, end }); } }
class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
const event = () => () => ({ dispose() {} });
const doc = (fileName, text) => ({ fileName, uri: { toString: () => fileName }, getText: () => text, positionAt: (o) => o });
module.exports = {
  Range, Diagnostic, DiagnosticSeverity: { Error: 0 },
  languages: { createDiagnosticCollection: () => ({ set: (uri, d) => set.push({ uri: uri.toString(), d }), delete() {} }) },
  workspace: {
    textDocuments: [doc("/w/.devcontainer.json", '{"image": "x", "nmae": "y"}'), doc("/w/package.json", "{")],
    onDidOpenTextDocument: event(), onDidChangeTextDocument: event(), onDidCloseTextDocument: event(),
    asRelativePath: String,
  },
  window: { showErrorMessage: (m) => errors.push(m) },
  results: { set, errors },
};`;

// Under Node, not Bun: the extension host is Node, so a Bun-only API that slips into the
// bundle passes every other test and only breaks inside VS Code.
test("the bundled extension lints open devcontainer.json files under Node", async () => {
  const build = Bun.spawnSync([process.execPath, "run", "build"], { cwd: extensionDir });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  mkdirSync(join(sandbox, "node_modules", "vscode"), { recursive: true });
  writeFileSync(join(sandbox, "node_modules", "vscode", "index.js"), stub);
  copyFileSync(join(extensionDir, "dist", "extension.js"), join(sandbox, "extension.js"));
  writeFileSync(
    join(sandbox, "run.cjs"),
    `require("./extension.js").activate({ subscriptions: [] });
     console.log(JSON.stringify(require("vscode").results));`,
  );

  const run = Bun.spawnSync(["node", "run.cjs"], { cwd: sandbox });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(JSON.parse(run.stdout.toString())).toEqual({
    set: [
      {
        uri: "/w/.devcontainer.json",
        d: [
          {
            range: { start: 15, end: 21 },
            message: 'Unknown property "nmae"; did you mean "name"?',
            severity: 0,
            source: "dcx",
            code: "schema/unknown-property",
          },
        ],
      },
    ],
    errors: [],
  });
});
