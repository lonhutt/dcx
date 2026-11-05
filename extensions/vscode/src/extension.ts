import { commands, type ExtensionContext, window, workspace } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { FIX_ALL_COMMAND, isDevcontainer } from "../../../src/server/protocol";
import { createClient } from "./client";
import { readConfig } from "./config";

// what the server is started with; dcx.trace.server the client applies live
const SERVER_SETTINGS = ["enable", "path", "run", "online", "configPath"].map((k) => `dcx.${k}`);

let client: LanguageClient | undefined;

/** Starts the dcx language server, and restarts it whenever one of its settings changes. */
export async function activate(context: ExtensionContext): Promise<void> {
  const output = window.createOutputChannel("dcx");
  let queue = Promise.resolve();

  // whatever state the old client is in, crashed past its own retries included, a new
  // one is the way back; queued, so two quick setting changes don't race
  const restart = () =>
    (queue = queue
      .then(async () => {
        await client?.dispose().catch(() => {});
        const config = readConfig();
        client = config.enable ? createClient(context, config, output) : undefined;
        // a failed start is already in the output channel and a notification
        await client?.start().catch(() => {});
      })
      // one bad restart mustn't leave the queue rejected, or no later one would run
      .catch((err) => output.appendLine(`couldn't restart the server: ${err?.stack ?? err}`)));

  // opening is enough: the client syncs each one, and the server lints it
  async function lintWorkspace() {
    const files = await workspace.findFiles(
      "{**/.devcontainer/**/devcontainer.json,**/.devcontainer.json}",
      "**/node_modules/**",
    );
    for (const file of files) await workspace.openTextDocument(file);
  }

  // registered here rather than left to the client, so it answers with no server running
  async function fixAll() {
    const doc = window.activeTextEditor?.document;
    if (!doc || !isDevcontainer(doc.fileName))
      return void window.showInformationMessage("dcx: open a devcontainer.json to fix");
    if (!client?.isRunning())
      return void window.showInformationMessage(
        "dcx: the language server isn't running; check dcx.enable, or dcx: Show Output",
      );
    try {
      const fixed = await client.sendRequest("workspace/executeCommand", {
        command: FIX_ALL_COMMAND,
        arguments: [doc.uri.toString()],
      });
      if (!fixed) void window.showInformationMessage("dcx: nothing to fix");
    } catch (err) {
      void window.showErrorMessage(`dcx couldn't fix ${doc.fileName}: ${(err as Error).message}`);
    }
  }

  context.subscriptions.push(
    output,
    // settings go to the server as initializationOptions, so a change means a new server
    workspace.onDidChangeConfiguration((e) => {
      if (SERVER_SETTINGS.some((s) => e.affectsConfiguration(s))) void restart();
    }),
    commands.registerCommand("dcx.lintWorkspace", lintWorkspace),
    commands.registerCommand("dcx.fixAll", fixAll),
    commands.registerCommand("dcx.restartServer", restart),
    commands.registerCommand("dcx.showOutput", () => output.show()),
  );
  await restart();
}

export function deactivate(): Promise<void> | undefined {
  return client?.dispose();
}
