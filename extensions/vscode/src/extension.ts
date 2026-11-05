import { commands, type ExtensionContext, window, workspace } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { createClient } from "./client";
import { readConfig } from "./config";

let client: LanguageClient | undefined;

/** Starts the dcx language server, and restarts it whenever a dcx setting changes. */
export async function activate(context: ExtensionContext): Promise<void> {
  const output = window.createOutputChannel("dcx");
  let queue = Promise.resolve();

  // whatever state the old client is in, crashed past its own retries included, a new
  // one is the way back; queued, so two quick setting changes don't race
  const restart = () =>
    (queue = queue.then(async () => {
      await client?.dispose().catch(() => {});
      const config = readConfig();
      client = config.enable ? createClient(context, config, output) : undefined;
      // a failed start is already in the output channel and a notification
      await client?.start().catch(() => {});
    }));

  // opening is enough: the client syncs each one, and the server lints it
  async function lintWorkspace() {
    const files = await workspace.findFiles(
      "{**/.devcontainer/**/devcontainer.json,**/.devcontainer.json}",
      "**/node_modules/**",
    );
    for (const file of files) await workspace.openTextDocument(file);
  }

  context.subscriptions.push(
    output,
    // settings go to the server as initializationOptions, so a change means a new server
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dcx")) void restart();
    }),
    commands.registerCommand("dcx.lintWorkspace", lintWorkspace),
    commands.registerCommand("dcx.restartServer", restart),
    commands.registerCommand("dcx.showOutput", () => output.show()),
  );
  await restart();
}

export function deactivate(): Promise<void> | undefined {
  return client?.dispose();
}
