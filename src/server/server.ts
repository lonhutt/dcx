import { dirname, isAbsolute, join } from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  CodeActionKind,
  DiagnosticSeverity,
  DidChangeWatchedFilesNotification,
  TextDocuments,
  TextDocumentSyncKind,
  type Connection,
  type InitializeParams,
  type InitializeResult,
  type ServerCapabilities,
} from "vscode-languageserver/lib/common/api";
import { URI } from "vscode-uri";
import pkg from "../../package.json" with { type: "json" };
import { parse } from "../jsonc/jsonc";
import { analyze } from "../lint/analyze";
import { services } from "../lint/services";
import { ConfigError } from "../lintconfig/load";
import { ConfigResolver } from "../lintconfig/resolve";
import type { Fetch } from "../net/http";
import { LineIndex } from "../position/position";
import { OverlayFS } from "../vfs/overlayfs";
import type { FileSystem } from "../vfs/vfs";
import {
  FIX_ALL_COMMAND,
  FIX_ALL_KIND,
  fixAllAction,
  fixAllEdit,
  quickFixes,
  wantsFixAll,
} from "./actions";
import { completions, hover } from "./assist";
import { analyzer } from "./diagnostics";
import { definition, documentLinks } from "./links";

export interface ServerOptions {
  readonly fs: FileSystem;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  readonly fetch?: Fetch;
  /** How long typing has to pause before a document is re-analysed. */
  readonly debounceMs?: number;
}

/** What a client can pass as `initializationOptions`: the editor's own dcx settings. */
export interface InitializationOptions {
  /** Unset leaves it to .dcx.yaml and DCX_ONLINE. */
  readonly online?: boolean;
  /** An explicit .dcx.yaml, absolute or relative to the first workspace folder. */
  readonly configPath?: string;
}

/** Exactly what's implemented; a client trusts these, so over-advertising breaks it. */
export const CAPABILITIES = {
  textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: true },
  codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, FIX_ALL_KIND] },
  executeCommandProvider: { commands: [FIX_ALL_COMMAND] },
  hoverProvider: true,
  completionProvider: { triggerCharacters: ['"'] },
  documentLinkProvider: { resolveProvider: false },
  definitionProvider: true,
} as const satisfies ServerCapabilities;

const DEBOUNCE_MS = 200;
const CONFIG_FILES = "**/.dcx.{yaml,yml,json}";
const isDevcontainer = (path: string) => /(^|[\\/])\.?devcontainer\.json$/.test(path);
const pathOf = (uri: string) => URI.parse(uri).fsPath;

/**
 * Serves dcx over `connection`: the same rules, config discovery and fixes as the CLI,
 * against the editor's unsaved buffers. Starts listening; never writes anywhere but the
 * connection. Returns the overlay the rules read through, and the documents with
 * analysis still pending, for tests.
 */
export function startServer(
  connection: Connection,
  options: ServerOptions,
): { overlay: OverlayFS; pending: () => Set<string> } {
  const documents = new TextDocuments(TextDocument);
  const overlay = new OverlayFS(options.fs);
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  let init: InitializationOptions = {};
  let folder: string | undefined;
  let canWatch = false;
  let resolver: ConfigResolver;
  let extra: ReturnType<typeof services>;
  // config files currently showing a problem, so a fixed one gets its squiggles cleared
  const brokenConfigs = new Set<string>();
  const warned = new Set<string>();

  const reset = () => {
    const configPath =
      init.configPath &&
      (isAbsolute(init.configPath) || !folder ? init.configPath : join(folder, init.configPath));
    resolver = new ConfigResolver({
      fs: overlay,
      env: options.env,
      home: options.home,
      ...(configPath && { configPath }),
      ...(init.online !== undefined && { overrides: { online: init.online } }),
    });
    extra = services(options.env, options.home, overlay, options.fetch);
    for (const uri of brokenConfigs) void connection.sendDiagnostics({ uri, diagnostics: [] });
    brokenConfigs.clear();
  };

  const lintText = async (path: string, signal?: AbortSignal) => {
    const config = await resolver.for(dirname(path));
    const more = await extra.forConfig(config);
    return (doc: ReturnType<typeof parse>) =>
      analyze(doc, path, { fs: overlay, config, ...more, ...(signal && { signal }) }).then(
        (r) => r.diagnostics,
      );
  };

  const analysis = analyzer({
    connection,
    get: (uri) => documents.get(uri),
    async lint(doc, signal) {
      const path = pathOf(doc.uri);
      const found = await (await lintText(path, signal))(parse(path, doc.getText()));
      for (const f of extra.failures()) {
        if (warned.has(f)) continue;
        warned.add(f);
        connection.console.warn(f);
      }
      return found;
    },
    failed(doc, err) {
      void connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
      if (!(err instanceof ConfigError)) {
        connection.console.error(
          `couldn't lint ${pathOf(doc.uri)}: ${(err as Error)?.stack ?? err}`,
        );
        return;
      }
      // the problem is in the config file, so that's where it's shown
      const uri = URI.file(err.path).toString();
      const lines = new LineIndex(err.text);
      brokenConfigs.add(uri);
      void connection.sendDiagnostics({
        uri,
        diagnostics: err.diagnostics.map((d) => ({
          range: { start: lines.positionAt(d.range.start), end: lines.positionAt(d.range.end) },
          severity: DiagnosticSeverity.Error,
          source: "dcx",
          code: d.ruleId,
          message: d.help ? `${d.message}\n${d.help}` : d.message,
        })),
      });
    },
  });

  const devcontainer = (uri: string) => {
    const doc = documents.get(uri);
    return doc && isDevcontainer(pathOf(uri)) ? doc : undefined;
  };
  const fixAll = async (uri: string) => {
    const doc = devcontainer(uri);
    return doc && fixAllEdit(doc, pathOf(uri), await lintText(pathOf(uri)));
  };
  const relintAll = () => {
    for (const doc of documents.all())
      if (isDevcontainer(pathOf(doc.uri))) analysis.schedule(doc.uri, 0);
  };

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    init = (params.initializationOptions as InitializationOptions | undefined) ?? {};
    const first = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    folder = first ? pathOf(first) : undefined;
    canWatch = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
    reset();
    return { capabilities: CAPABILITIES, serverInfo: { name: "dcx", version: pkg.version } };
  });

  // config is cached once read; an edited .dcx.yaml has to reach every open document
  connection.onInitialized(() => {
    if (canWatch)
      void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [{ globPattern: CONFIG_FILES }],
      });
    else
      connection.console.info(
        "the client can't watch files; edits to .dcx.yaml apply after a restart",
      );
  });
  connection.onDidChangeWatchedFiles(() => {
    reset();
    relintAll();
  });

  documents.onDidChangeContent(({ document }) => {
    const path = pathOf(document.uri);
    overlay.set(path, document.getText());
    if (isDevcontainer(path)) analysis.schedule(document.uri, debounceMs);
  });
  documents.onDidSave(({ document }) => {
    if (isDevcontainer(pathOf(document.uri))) analysis.schedule(document.uri, 0);
  });
  documents.onDidClose(({ document }) => {
    overlay.delete(pathOf(document.uri));
    if (isDevcontainer(pathOf(document.uri))) analysis.close(document.uri);
  });

  connection.onCodeAction(async ({ textDocument, range, context }) => {
    const doc = devcontainer(textDocument.uri);
    if (!doc) return [];
    const actions =
      context.only?.length && !context.only.includes(CodeActionKind.QuickFix)
        ? []
        : quickFixes(doc, analysis.latest(doc.uri), range);
    if (wantsFixAll(context.only)) {
      const edit = await fixAll(doc.uri);
      if (edit) actions.push(fixAllAction(doc, edit));
    }
    return actions;
  });
  connection.onExecuteCommand(async ({ command, arguments: args }) => {
    if (command !== FIX_ALL_COMMAND || typeof args?.[0] !== "string") return;
    const edit = await fixAll(args[0]);
    if (edit) await connection.workspace.applyEdit({ changes: { [args[0]]: [edit] } });
  });
  connection.onHover(({ textDocument, position }) => {
    const doc = devcontainer(textDocument.uri);
    return doc ? hover(doc, doc.offsetAt(position)) : undefined;
  });
  connection.onCompletion(({ textDocument, position }) => {
    const doc = devcontainer(textDocument.uri);
    return doc ? completions(doc, doc.offsetAt(position)) : [];
  });
  connection.onDocumentLinks(({ textDocument }) => {
    const doc = devcontainer(textDocument.uri);
    return doc ? documentLinks(doc, pathOf(doc.uri), overlay) : [];
  });
  connection.onDefinition(({ textDocument, position }) => {
    const doc = devcontainer(textDocument.uri);
    return doc ? definition(doc, pathOf(doc.uri), doc.offsetAt(position), overlay) : [];
  });

  connection.onShutdown(() => analysis.dispose());
  documents.listen(connection);
  connection.listen();
  return { overlay, pending: analysis.pending };
}
