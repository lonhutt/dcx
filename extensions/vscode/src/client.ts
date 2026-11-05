import { join } from "node:path";
import { window, type ExtensionContext, type OutputChannel } from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";
import type { InitializationOptions } from "../../../src/server/server";
import type { DcxConfig } from "./config";

// the server's command; not imported, since that would bundle the rules into the client
export const FIX_ALL_COMMAND = "dcx.fixAll";
const isDevcontainer = (fileName: string) => /(^|[\\/])\.?devcontainer\.json$/.test(fileName);

/** A client for the bundled server, or for a dcx checkout's when `dcx.path` is set. */
export function createClient(
  context: ExtensionContext,
  config: DcxConfig,
  outputChannel: OutputChannel,
): LanguageClient {
  const server: ServerOptions = config.path
    ? { command: "bun", args: [join(config.path, "index.ts"), "serve", "--stdio"] }
    : { module: context.asAbsolutePath(join("dist", "server.js")), transport: TransportKind.ipc };
  const initializationOptions: InitializationOptions = {
    run: config.run,
    ...(config.online !== undefined && { online: config.online }),
    ...(config.configPath && { configPath: config.configPath }),
  };
  const options: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", pattern: "**/{devcontainer.json,.devcontainer.json}" },
      // synced so an unsaved Compose file or Dockerfile reaches the configs that use it
      { scheme: "file", language: "dockercompose" },
      { scheme: "file", language: "dockerfile" },
    ],
    initializationOptions,
    outputChannel,
    middleware: {
      // from the command palette there's no document argument; use the open one
      async executeCommand(command, args, next) {
        if (command !== FIX_ALL_COMMAND || args.length) return next(command, args);
        const doc = window.activeTextEditor?.document;
        if (!doc || !isDevcontainer(doc.fileName))
          return void window.showInformationMessage("dcx: open a devcontainer.json to fix");
        if (!(await next(command, [doc.uri.toString()])))
          void window.showInformationMessage("dcx: nothing to fix");
      },
    },
  };
  // the id makes dcx.trace.server the client's trace setting
  return new LanguageClient("dcx", "dcx", server, options);
}
