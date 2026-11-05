import type { Range } from "../position/position";

/** How serious a finding is; `off` disables a rule outright. */
export type Severity = "error" | "warning" | "info" | "off";

/** Ranks severities so `rank(a) >= rank(b)` reads "a is at least as bad as b". */
export const SEVERITY_RANK: Record<Severity, number> = { off: 0, info: 1, warning: 2, error: 3 };

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && value in SEVERITY_RANK;
}

/** Replace `range` in the document with `newText`; UTF-16 offsets, same as the LSP's. */
export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

/** A machine-applicable change; its edits must not overlap one another. */
export interface Fix {
  readonly title: string;
  readonly edits: readonly TextEdit[];
}

/** A second span a finding refers to, e.g. the first occurrence of a duplicated key. */
export interface RelatedInformation {
  readonly range: Range;
  readonly message: string;
}

/**
 * One finding. This is the `--format json` contract: field names and which fields are
 * optional are public API, pinned by `src/diagnostic/testdata/diagnostic.golden.json`.
 */
export interface Diagnostic {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly range: Range;
  readonly message: string;
  readonly help?: string;
  readonly docsUrl?: string;
  readonly fix?: Fix;
  readonly related?: readonly RelatedInformation[];
  /** Set by `src/suppress` on a finding an inline directive silenced. */
  readonly suppressed?: boolean;
  readonly suppressReason?: string;
}

// codepoint order, not localeCompare: output mustn't depend on the host locale
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Orders by start offset, then end, rule ID and message. Total for any two findings that
 * differ in those, so the order never depends on the order rules ran in.
 */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    a.range.start - b.range.start ||
    a.range.end - b.range.end ||
    cmp(a.ruleId, b.ruleId) ||
    cmp(a.message, b.message)
  );
}

/** A sorted copy; see {@link compareDiagnostics}. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(compareDiagnostics);
}
