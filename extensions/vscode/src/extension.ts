import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import { parse } from "../../../src/jsonc/jsonc";
import { analyze } from "../../../src/lint/analyze";
import { fixDocument } from "../../../src/lint/fix";
import { ConfigError } from "../../../src/lintconfig/load";
import { ConfigResolver } from "../../../src/lintconfig/resolve";
import { services as servicesFor } from "../../../src/lint/services";
import { NodeFS } from "../../../src/vfs/nodefs";
import { NEEDS_RELOAD, readConfig, type DcxConfig } from "./config";
import { toDiagnostics } from "./diagnostics";

const isDevcontainer = (doc: vscode.TextDocument) =>
  /(^|[\\/])\.?devcontainer\.json$/.test(doc.fileName);

const TYPING_DELAY_MS = 300;

/** Lints devcontainer.json files on open, and on save or as you type. */
export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("dcx");
  const output = vscode.window.createOutputChannel("dcx");
  const fs = new NodeFS();
  let config = readConfig();
  let resolver = newResolver(config);
  let services = servicesFor(process.env, homedir(), fs);
  // one run in flight per document; a newer edit aborts the older run
  const running = new Map<string, AbortController>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // documents whose last lint failed; a crash gets one notification, not one per keystroke
  const failing = new Set<string>();
  // network problems go to the output channel once each; a VPN-only gallery shouldn't nag
  const warned = new Set<string>();

  function newResolver(c: DcxConfig) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const configPath =
      c.configPath &&
      (isAbsolute(c.configPath) || !folder ? c.configPath : join(folder, c.configPath));
    return new ConfigResolver({
      fs,
      env: process.env,
      home: homedir(),
      ...(configPath && { configPath }),
      overrides: { online: c.online },
    });
  }

  async function lint(doc: vscode.TextDocument): Promise<void> {
    if (!isDevcontainer(doc) || doc.uri.scheme !== "file") return;
    const uri = doc.uri.toString();
    if (!config.enable) return void collection.delete(doc.uri);
    running.get(uri)?.abort();
    const ac = new AbortController();
    running.set(uri, ac);
    try {
      const path = doc.uri.fsPath;
      const settings = await resolver.for(dirname(path));
      const extra = await services.forConfig(settings);
      const result = await analyze(parse(path, doc.getText()), path, {
        fs,
        config: settings,
        ...extra,
        signal: ac.signal,
      });
      for (const f of services.failures()) {
        if (warned.has(f)) continue;
        warned.add(f);
        output.appendLine(`warning: ${f}`);
      }
      if (ac.signal.aborted) return;
      collection.set(doc.uri, toDiagnostics(doc, result.diagnostics));
      failing.delete(uri);
    } catch (err) {
      if (ac.signal.aborted) return;
      collection.delete(doc.uri);
      const name = vscode.workspace.asRelativePath(doc.uri);
      const message =
        err instanceof ConfigError ? `invalid config ${err.message}` : (err as Error).message;
      output.appendLine(`couldn't lint ${name}: ${(err as Error)?.stack ?? message}`);
      if (!failing.has(uri)) {
        failing.add(uri);
        void vscode.window.showErrorMessage(`dcx couldn't lint ${name}: ${message}`);
      }
    } finally {
      if (running.get(uri) === ac) running.delete(uri);
    }
  }

  function onType(doc: vscode.TextDocument) {
    if (config.run !== "onType" || !isDevcontainer(doc)) return;
    const uri = doc.uri.toString();
    clearTimeout(timers.get(uri));
    timers.set(
      uri,
      setTimeout(() => void lint(doc), TYPING_DELAY_MS),
    );
  }

  const lintOpen = () => Promise.all(vscode.workspace.textDocuments.map(lint));

  async function lintWorkspace() {
    const files = await vscode.workspace.findFiles(
      "{**/.devcontainer/**/devcontainer.json,**/.devcontainer.json}",
      "**/node_modules/**",
    );
    for (const file of files) await lint(await vscode.workspace.openTextDocument(file));
  }

  async function fixAll() {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !isDevcontainer(doc))
      return void vscode.window.showInformationMessage("dcx: open a devcontainer.json to fix");
    const path = doc.uri.fsPath;
    const settings = await resolver.for(dirname(path));
    const extra = await services.forConfig(settings);
    const before = doc.getText();
    const fixed = await fixDocument(
      before,
      path,
      async (d) => (await analyze(d, path, { fs, config: settings, ...extra })).diagnostics,
    );
    if (fixed.text === before)
      return void vscode.window.showInformationMessage("dcx: nothing to fix");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)),
      fixed.text,
    );
    await vscode.workspace.applyEdit(edit);
  }

  function restart() {
    for (const ac of running.values()) ac.abort();
    collection.clear();
    failing.clear();
    resolver = newResolver(config);
    services = servicesFor(process.env, homedir(), fs);
    return lintOpen();
  }

  void lintOpen();
  context.subscriptions.push(
    collection,
    output,
    vscode.workspace.onDidOpenTextDocument(lint),
    vscode.workspace.onDidSaveTextDocument(lint),
    vscode.workspace.onDidChangeTextDocument((e) => onType(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const uri = doc.uri.toString();
      running.get(uri)?.abort();
      clearTimeout(timers.get(uri));
      collection.delete(doc.uri);
      failing.delete(uri);
    }),
    // an edited .dcx.yaml changes every result; the resolver caches what it read
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/(^|[\\/])\.dcx\.(ya?ml|json)$/.test(doc.fileName)) void restart();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("dcx")) return;
      const before = config;
      config = readConfig();
      if (NEEDS_RELOAD.some((k) => before[k] !== config[k]))
        void vscode.window.showInformationMessage(
          "dcx: reload the window for the new dcx.path to take effect",
        );
      void restart();
    }),
    vscode.commands.registerCommand("dcx.lintWorkspace", lintWorkspace),
    vscode.commands.registerCommand("dcx.fixAll", fixAll),
    vscode.commands.registerCommand("dcx.restartServer", restart),
    vscode.commands.registerCommand("dcx.showOutput", () => output.show()),
  );
}

export function deactivate(): void {}
