import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  CodeActionKind,
  DiagnosticSeverity,
  DidChangeWatchedFilesNotification,
  TextDocuments,
  TextDocumentSyncKind,
  type Connection,
  type DidChangeWatchedFilesClientCapabilities,
  type InitializeParams,
  type InitializeResult,
  type FileSystemWatcher,
  type ServerCapabilities,
} from "vscode-languageserver/lib/common/api";
import { URI } from "vscode-uri";
import pkg from "../../package.json" with { type: "json" };
import { parse } from "../jsonc/jsonc";
import { analyze } from "../lint/analyze";
import { services } from "../lint/services";
import { ConfigError } from "../lintconfig/load";
import { userConfigPath } from "../lintconfig/discover";
import { ConfigResolver } from "../lintconfig/resolve";
import type { Fetch } from "../net/http";
import { LineIndex } from "../position/position";
import { OverlayFS } from "../vfs/overlayfs";
import type { FileSystem } from "../vfs/vfs";
import { FIX_ALL_COMMAND, FIX_ALL_KIND, fixAllEdit, quickFixes, wantsFixAll } from "./actions";
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
  /** `onSave` lints a document when it's opened and saved, not as it's edited. Default `onType`. */
  readonly run?: "onSave" | "onType";
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
// fsPath lowercases a Windows drive letter and Node's paths don't; the overlay is keyed
// by exact path, so a buffer stored under d:\ would be missed by a read of D:\
const pathOf = (uri: string) =>
  URI.parse(uri).fsPath.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
// a git: or untitled: document can share a working copy's fsPath, but isn't what's on disk
const isLocal = (uri: string) => URI.parse(uri).scheme === "file";

/**
 * Serves dcx over `connection`: the same rules, config discovery and fixes as the CLI,
 * against the editor's unsaved buffers. Starts listening; never writes anywhere but the
 * connection. Returns the overlay the rules read through, the documents with analysis
 * still pending (for tests), and `dispose`, which stops any analysis still going.
 */
export function startServer(
  connection: Connection,
  options: ServerOptions,
): { overlay: OverlayFS; pending: () => Set<string>; dispose: () => void } {
  const documents = new TextDocuments(TextDocument);
  const overlay = new OverlayFS(options.fs);
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  let init: InitializationOptions = {};
  let folder: string | undefined;
  let watch: DidChangeWatchedFilesClientCapabilities | undefined;
  let resolver: ConfigResolver;
  let extra: ReturnType<typeof services>;
  // config files currently showing a problem, so a fixed one gets its squiggles cleared
  const brokenConfigs = new Set<string>();
  const warned = new Set<string>();

  const configPath = () => {
    if (!init.configPath || isAbsolute(init.configPath)) return init.configPath;
    return folder ? join(folder, init.configPath) : undefined;
  };

  const reset = () => {
    const explicit = configPath();
    resolver = new ConfigResolver({
      fs: overlay,
      env: options.env,
      home: options.home,
      ...(explicit && { configPath: explicit }),
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
    return doc && isLocal(uri) && isDevcontainer(pathOf(uri)) ? doc : undefined;
  };
  const fixAll = async (uri: string) => {
    const doc = devcontainer(uri);
    if (!doc) return undefined;
    try {
      return await fixAllEdit(doc, pathOf(uri), await lintText(pathOf(uri)));
    } catch (err) {
      // a broken .dcx.yaml is already shown in that file by the analysis
      if (!(err instanceof ConfigError))
        connection.console.error(`couldn't fix ${pathOf(uri)}: ${(err as Error)?.stack ?? err}`);
      return undefined;
    }
  };
  const relintAll = (delayMs: number) => {
    for (const doc of documents.all())
      if (devcontainer(doc.uri)) analysis.schedule(doc.uri, delayMs);
  };
  // the explicit config and the user config can live anywhere, under any name
  const watchers = (): FileSystemWatcher[] => {
    // resolved as the config loader resolves them: on Windows "/etc" means the current drive
    const files = [configPath(), userConfigPath(options.env, options.home)].flatMap((p) =>
      p ? [resolve(p)] : [],
    );
    return [
      { globPattern: CONFIG_FILES },
      ...files.map((p) => ({
        globPattern: watch?.relativePatternSupport
          ? { baseUri: URI.file(dirname(p)).toString(), pattern: basename(p) }
          : p.replaceAll("\\", "/"),
      })),
    ];
  };

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    init = (params.initializationOptions as InitializationOptions | undefined) ?? {};
    const first = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    folder = first ? pathOf(first) : undefined;
    watch = params.capabilities.workspace?.didChangeWatchedFiles;
    reset();
    return { capabilities: CAPABILITIES, serverInfo: { name: "dcx", version: pkg.version } };
  });

  // config is cached once read; an edited .dcx.yaml has to reach every open document
  connection.onInitialized(() => {
    if (init.configPath && !configPath())
      connection.console.warn(
        `configPath "${init.configPath}" is relative and there's no workspace folder to resolve it against; ignoring it`,
      );
    if (watch?.dynamicRegistration)
      void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: watchers(),
      });
    else
      connection.console.info(
        "the client can't watch files; edits to .dcx.yaml apply after a restart",
      );
  });
  connection.onDidChangeWatchedFiles(() => {
    reset();
    relintAll(0);
  });

  const onType = () => init.run !== "onSave";
  documents.onDidOpen(({ document }) => {
    if (!onType() && devcontainer(document.uri)) analysis.schedule(document.uri, 0);
  });
  // an open Compose file or Dockerfile is what the open configs read, so editing it re-lints them
  documents.onDidChangeContent(({ document }) => {
    if (!isLocal(document.uri)) return;
    const path = pathOf(document.uri);
    overlay.set(path, document.getText());
    if (!onType()) return;
    if (isDevcontainer(path)) analysis.schedule(document.uri, debounceMs);
    else relintAll(debounceMs);
  });
  documents.onDidSave(({ document }) => {
    if (devcontainer(document.uri)) analysis.schedule(document.uri, 0);
    else if (isLocal(document.uri) && !onType()) relintAll(0);
  });
  documents.onDidClose(({ document }) => {
    if (!isLocal(document.uri)) return;
    const path = pathOf(document.uri);
    overlay.delete(path);
    if (isDevcontainer(path)) analysis.close(document.uri);
    else relintAll(debounceMs);
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
      if (edit)
        actions.push({
          title: "Fix all dcx problems",
          kind: FIX_ALL_KIND,
          edit: { changes: { [doc.uri]: [edit] } },
        });
    }
    return actions;
  });
  // answers whether it changed anything, so a client can say there was nothing to fix
  connection.onExecuteCommand(async ({ command, arguments: args }) => {
    if (command !== FIX_ALL_COMMAND || typeof args?.[0] !== "string") return false;
    const edit = await fixAll(args[0]);
    if (!edit) return false;
    return (await connection.workspace.applyEdit({ changes: { [args[0]]: [edit] } })).applied;
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
  return { overlay, pending: analysis.pending, dispose: analysis.dispose };
}
