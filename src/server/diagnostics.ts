import type { TextDocument } from "vscode-languageserver-textdocument";
import {
  DiagnosticSeverity,
  DiagnosticTag,
  type Connection,
  type Diagnostic as LspDiagnostic,
  type Range as LspRange,
} from "vscode-languageserver/lib/common/api";
import type { Diagnostic, Severity } from "../diagnostic/diagnostic";
import type { Range } from "../position/position";
import { catalog } from "../report/rules";
import { all } from "../rules/index";

const SEVERITY: Record<Exclude<Severity, "off">, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
};

const HELP = new Map(catalog(all()).map((r) => [r.id, r.helpUri]));

export const lspRange = (doc: TextDocument, r: Range): LspRange => ({
  start: doc.positionAt(r.start),
  end: doc.positionAt(r.end),
});

/** Whether a finding is one the editor shows: not suppressed, not off. */
export const shown = (d: Diagnostic): d is Diagnostic & { severity: Exclude<Severity, "off"> } =>
  !d.suppressed && d.severity !== "off";

/** A dcx finding as an LSP diagnostic. Offsets are UTF-16 on both sides, so ranges map directly. */
export function toLsp(
  doc: TextDocument,
  d: Diagnostic & { severity: Exclude<Severity, "off"> },
): LspDiagnostic {
  const help = HELP.get(d.ruleId);
  const tags = d.ruleId.startsWith("deprecation/")
    ? [DiagnosticTag.Deprecated]
    : d.ruleId === "meta/unused-suppression"
      ? [DiagnosticTag.Unnecessary]
      : undefined;
  return {
    range: lspRange(doc, d.range),
    severity: SEVERITY[d.severity],
    source: "dcx",
    code: d.ruleId,
    ...(help && { codeDescription: { href: help } }),
    message: d.help ? `${d.message}\n${d.help}` : d.message,
    ...(tags && { tags }),
    ...(d.related?.length && {
      relatedInformation: d.related.map((r) => ({
        location: { uri: doc.uri, range: lspRange(doc, r.range) },
        message: r.message,
      })),
    }),
  };
}

/** What the last finished analysis of a document found, for code actions to serve from. */
export interface Analysis {
  readonly version: number;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Debounced, cancellable analysis per document. A newer request for a document aborts
 * the older one, and a cancelled run never publishes: the check sits right before
 * `sendDiagnostics`, since an async function doesn't stop when its signal aborts.
 */
export function analyzer(options: {
  readonly connection: Connection;
  readonly get: (uri: string) => TextDocument | undefined;
  readonly lint: (doc: TextDocument, signal: AbortSignal) => Promise<readonly Diagnostic[]>;
  /** A run that threw; the server reports it however suits the error. */
  readonly failed: (doc: TextDocument, err: unknown) => void;
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, AbortController>();
  const latest = new Map<string, Analysis>();

  const cancel = (uri: string) => {
    clearTimeout(timers.get(uri));
    timers.delete(uri);
    running.get(uri)?.abort();
    running.delete(uri);
  };

  async function run(uri: string, signal: AbortSignal) {
    const doc = options.get(uri);
    if (!doc || signal.aborted) return;
    try {
      const found = await options.lint(doc, signal);
      if (signal.aborted) return;
      latest.set(uri, { version: doc.version, diagnostics: found });
      await options.connection.sendDiagnostics({
        uri,
        version: doc.version,
        diagnostics: found.filter(shown).map((d) => toLsp(doc, d)),
      });
    } catch (err) {
      if (!signal.aborted) options.failed(doc, err);
    }
  }

  return {
    /** Analyses `uri` after `delayMs`, replacing anything already pending or running for it. */
    schedule(uri: string, delayMs: number) {
      cancel(uri);
      const ac = new AbortController();
      running.set(uri, ac);
      timers.set(
        uri,
        setTimeout(() => {
          timers.delete(uri);
          void run(uri, ac.signal).finally(() => {
            if (running.get(uri) === ac) running.delete(uri);
          });
        }, delayMs),
      );
    },
    /** Stops any analysis of `uri` and clears what the editor shows for it. */
    close(uri: string) {
      cancel(uri);
      latest.delete(uri);
      void options.connection.sendDiagnostics({ uri, diagnostics: [] });
    },
    latest: (uri: string) => latest.get(uri),
    /** Documents with a timer or a run still going; for tests to assert nothing leaks. */
    pending: () => new Set([...timers.keys(), ...running.keys()]),
    dispose() {
      for (const uri of [...timers.keys(), ...running.keys()]) cancel(uri);
    },
  };
}
