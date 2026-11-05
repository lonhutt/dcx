import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  createConnection,
  createProtocolConnection,
  type ClientCapabilities,
  type Diagnostic,
  type PublishDiagnosticsParams,
  type TextDocumentContentChangeEvent,
} from "vscode-languageserver/lib/common/api";
import { URI } from "vscode-uri";
import { startServer, type ServerOptions } from "../server/server";

/**
 * A dcx language server and a client talking to it over in-memory streams. The server's
 * watchdog records the exit code instead of exiting, so a test can drive the whole
 * lifecycle; everything the server writes is kept in `wire`.
 */
export function lspPair(options: Pick<ServerOptions, "fs"> & Partial<ServerOptions>) {
  const up = new PassThrough();
  const down = new PassThrough();
  const wire: Buffer[] = [];
  down.on("data", (b: Buffer) => wire.push(b));
  let shutdownReceived = false;
  let exitCode: number | undefined;
  const server = createConnection(
    (logger) =>
      createProtocolConnection(new StreamMessageReader(up), new StreamMessageWriter(down), logger),
    {
      get shutdownReceived() {
        return shutdownReceived;
      },
      set shutdownReceived(v) {
        shutdownReceived = v;
      },
      initialize() {},
      exit: (code) => void (exitCode = code),
    },
  );
  const { overlay, pending } = startServer(server, {
    env: {},
    home: "/home",
    debounceMs: 5,
    ...options,
  });

  const client: MessageConnection = createMessageConnection(
    new StreamMessageReader(down),
    new StreamMessageWriter(up),
  );
  const published: PublishDiagnosticsParams[] = [];
  const applied: unknown[] = [];
  client.onNotification(
    "textDocument/publishDiagnostics",
    (p: PublishDiagnosticsParams) => void published.push(p),
  );
  client.onNotification("window/logMessage", () => {});
  client.onRequest("client/registerCapability", () => null);
  client.onRequest("workspace/applyEdit", (p: unknown) => (applied.push(p), { applied: true }));
  client.listen();

  // resolved, as the server resolves it: on Windows "/w" is "D:\\w"
  const uriOf = (path: string) => URI.file(resolve(path)).toString();
  const versions = new Map<string, number>();

  return {
    client,
    overlay,
    pending,
    published,
    applied,
    wire,
    uriOf,
    exitCode: () => exitCode,
    async initialize(capabilities: ClientCapabilities = {}, initializationOptions?: object) {
      const result = await client.sendRequest("initialize", {
        processId: null,
        rootUri: null,
        capabilities,
        ...(initializationOptions && { initializationOptions }),
      });
      await client.sendNotification("initialized", {});
      return result as { capabilities: Record<string, unknown> };
    },
    open(path: string, text: string) {
      versions.set(path, 1);
      return client.sendNotification("textDocument/didOpen", {
        textDocument: { uri: uriOf(path), languageId: "jsonc", version: 1, text },
      });
    },
    change(path: string, ...contentChanges: TextDocumentContentChangeEvent[]) {
      const version = (versions.get(path) ?? 1) + 1;
      versions.set(path, version);
      return client.sendNotification("textDocument/didChange", {
        textDocument: { uri: uriOf(path), version },
        contentChanges,
      });
    },
    close(path: string) {
      return client.sendNotification("textDocument/didClose", {
        textDocument: { uri: uriOf(path) },
      });
    },
    request<T>(method: string, params: object): Promise<T> {
      return client.sendRequest(method, params) as Promise<T>;
    },
    /** The latest diagnostics published for `path`, once there are some (or `count` sets). */
    async diagnostics(path: string, count = 1, timeoutMs = 5000): Promise<Diagnostic[]> {
      const uri = uriOf(path);
      const deadline = Date.now() + timeoutMs;
      while (published.filter((p) => p.uri === uri).length < count) {
        if (Date.now() > deadline)
          throw new Error(`no diagnostics for ${uri} after ${timeoutMs}ms`);
        await Bun.sleep(5);
      }
      return published.filter((p) => p.uri === uri).at(-1)!.diagnostics;
    },
    /** Waits until no analysis is pending, then a little longer for its publish to arrive. */
    async settle() {
      while (pending().size) await Bun.sleep(5);
      await Bun.sleep(20);
    },
    /** Shuts the server down first, so no pending analysis fires at a closed connection. */
    async dispose() {
      await client.sendRequest("shutdown").catch(() => {});
      client.dispose();
      server.dispose();
    },
  };
}
