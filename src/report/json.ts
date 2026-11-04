import type { Diagnostic, Severity } from "../diagnostic/diagnostic";
import type { LineIndex } from "../position/position";
import { count, type Reporter } from "./report";

/**
 * Bumped on any breaking change to the shape below (a field removed, renamed or retyped);
 * adding an optional field isn't one.
 */
export const JSON_FORMAT_VERSION = "1";

export interface JsonOutput {
  readonly version: string;
  readonly files: readonly JsonFile[];
  readonly summary: {
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
    readonly files: number;
  };
}
export interface JsonFile {
  readonly path: string;
  readonly diagnostics: readonly JsonDiagnostic[];
}
export interface JsonDiagnostic {
  readonly ruleId: string;
  readonly severity: Exclude<Severity, "off">;
  readonly message: string;
  readonly help?: string;
  readonly docsUrl?: string;
  readonly range: JsonRange;
  readonly related?: readonly { readonly range: JsonRange; readonly message: string }[];
  readonly fix?: {
    readonly title: string;
    readonly edits: readonly { readonly range: JsonRange; readonly newText: string }[];
  };
  readonly suppressed?: true;
  readonly suppressReason?: string;
}
export interface JsonRange {
  readonly start: JsonPosition;
  readonly end: JsonPosition;
}
/** Both coordinate systems: a UTF-16 offset, and a 1-based line and display-width column. */
export interface JsonPosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** The versioned envelope; suppressed findings are included, marked, with their reason. */
export const json: Reporter = (files) => {
  const c = count(files);
  const out: JsonOutput = {
    version: JSON_FORMAT_VERSION,
    files: files.map((f) => ({
      path: f.path,
      diagnostics: f.diagnostics.map((d) => wire(d, f.lines)),
    })),
    summary: { errors: c.error, warnings: c.warning, infos: c.info, files: c.files },
  };
  return JSON.stringify(out, null, 2) + "\n";
};

function wire(d: Diagnostic, lines: LineIndex): JsonDiagnostic {
  const range = (r: { start: number; end: number }) => ({
    start: pos(r.start, lines),
    end: pos(r.end, lines),
  });
  // built key by key: an absent field must be absent, never `null` or `undefined`
  return {
    ruleId: d.ruleId,
    severity: d.severity as JsonDiagnostic["severity"],
    message: d.message,
    ...(d.help && { help: d.help }),
    ...(d.docsUrl && { docsUrl: d.docsUrl }),
    range: range(d.range),
    ...(d.related?.length && {
      related: d.related.map((r) => ({ range: range(r.range), message: r.message })),
    }),
    ...(d.fix && {
      fix: {
        title: d.fix.title,
        edits: d.fix.edits.map((e) => ({ range: range(e.range), newText: e.newText })),
      },
    }),
    ...(d.suppressed && { suppressed: true as const }),
    ...(d.suppressReason && { suppressReason: d.suppressReason }),
  };
}

function pos(offset: number, lines: LineIndex): JsonPosition {
  const { line, column } = lines.terminalPositionAt(offset);
  return { offset, line, column };
}
