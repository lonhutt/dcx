import {
  Diagnostic as VsDiagnostic,
  DiagnosticRelatedInformation,
  DiagnosticSeverity,
  DiagnosticTag,
  Location,
  Range,
  type TextDocument,
  Uri,
} from "vscode";
import type { Diagnostic, Severity } from "../../../src/diagnostic/diagnostic";
import { catalog } from "../../../src/report/rules";
import { all } from "../../../src/rules/index";

type Shown = Diagnostic & { readonly severity: Exclude<Severity, "off"> };

const SEVERITY: Record<Shown["severity"], DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
};

const HELP = new Map(catalog(all()).map((r) => [r.id, r.helpUri]));

/**
 * dcx findings as VS Code diagnostics; suppressed ones are left out. Ranges convert
 * directly: dcx offsets and `positionAt` both count UTF-16 code units.
 */
export function toDiagnostics(
  doc: TextDocument,
  diagnostics: readonly Diagnostic[],
): VsDiagnostic[] {
  const range = (r: { start: number; end: number }) =>
    new Range(doc.positionAt(r.start), doc.positionAt(r.end));
  return diagnostics
    .filter((d): d is Shown => !d.suppressed && d.severity !== "off")
    .map((d) => {
      const message = d.help ? `${d.message}\n${d.help}` : d.message;
      const out = new VsDiagnostic(range(d.range), message, SEVERITY[d.severity]);
      out.source = "dcx";
      const help = HELP.get(d.ruleId);
      out.code = help ? { value: d.ruleId, target: Uri.parse(help) } : d.ruleId;
      if (d.related?.length)
        out.relatedInformation = d.related.map(
          (r) => new DiagnosticRelatedInformation(new Location(doc.uri, range(r.range)), r.message),
        );
      if (d.ruleId.startsWith("deprecation/")) out.tags = [DiagnosticTag.Deprecated];
      if (d.ruleId === "meta/unused-suppression") out.tags = [DiagnosticTag.Unnecessary];
      return out;
    });
}
