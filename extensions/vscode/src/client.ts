import { join } from "node:path";
import type { ExtensionContext, OutputChannel } from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";
import type { InitializationOptions } from "../../../src/server/server";
import type { DcxConfig } from "./config";

/** A client for the bundled server, or for a dcx checkout's when `dcx.path` is set. */
export function createClient(
  context: ExtensionContext,
  config: DcxConfig,
  outputChannel: OutputChannel,
): LanguageClient {
  const server: ServerOptions = config.path
    ? // run from the checkout, or bun loads the opened project's .env into the server
      {
        command: "bun",
        args: [join(config.path, "index.ts"), "serve", "--stdio"],
        options: { cwd: config.path },
      }
    : { module: context.asAbsolutePath(join("dist", "server.js")), transport: TransportKind.ipc };
  const initializationOptions: InitializationOptions = {
    run: config.run,
    ...(config.online !== undefined && { online: config.online }),
    ...(config.configPath && { configPath: config.configPath }),
  };
  const options: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", pattern: "**/{devcontainer.json,.devcontainer.json}" },
      // synced so an unsaved Compose file or Dockerfile reaches the configs that use it; by
      // name, since the dockercompose language only exists with Docker's extension installed
      { scheme: "file", pattern: "**/*compose*.{yml,yaml}" },
      { scheme: "file", language: "dockerfile" },
    ],
    initializationOptions,
    outputChannel,
  };
  // the id makes dcx.trace.server the client's trace setting
  return new LanguageClient("dcx", "dcx", server, options);
}
