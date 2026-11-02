import * as vscode from "vscode";
import { parse } from "../../../src/jsonc/jsonc";
import { lint } from "../../../src/lint/lint";

const isDevcontainer = (doc: vscode.TextDocument) =>
  /(^|[\\/])\.?devcontainer\.json$/.test(doc.fileName);

/** Lints devcontainer.json files when they're opened and on every edit. */
export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("dcx");
  // documents whose last lint threw; a crash gets one notification, not one per keystroke
  const failing = new Set<string>();

  const check = (doc: vscode.TextDocument) => {
    if (!isDevcontainer(doc)) return;
    const uri = doc.uri.toString();
    try {
      const found = lint(parse(uri, doc.getText())).map((d) => {
        const range = new vscode.Range(doc.positionAt(d.range.start), doc.positionAt(d.range.end));
        const diagnostic = new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = "dcx";
        diagnostic.code = d.rule;
        return diagnostic;
      });
      collection.set(doc.uri, found);
      failing.delete(uri);
    } catch (err) {
      collection.delete(doc.uri);
      if (!failing.has(uri)) {
        failing.add(uri);
        const name = vscode.workspace.asRelativePath(doc.uri);
        vscode.window.showErrorMessage(`dcx couldn't lint ${name}: ${(err as Error).message}`);
      }
    }
  };

  vscode.workspace.textDocuments.forEach(check);
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => check(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      collection.delete(doc.uri);
      failing.delete(doc.uri.toString());
    }),
  );
}
