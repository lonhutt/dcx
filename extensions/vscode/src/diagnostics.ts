import * as vscode from "vscode";
import type { Diagnostic, Severity } from "../../../src/diagnostic/diagnostic";
import { catalog } from "../../../src/report/rules";
import { all } from "../../../src/rules/index";

const SEVERITY: Record<Exclude<Severity, "off">, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

const HELP = new Map(catalog(all()).map((r) => [r.id, r.helpUri]));

/**
 * dcx findings as VS Code diagnostics; suppressed ones are left out. Ranges convert
 * directly: dcx offsets and `positionAt` both count UTF-16 code units.
 */
export function toDiagnostics(
  doc: vscode.TextDocument,
  diagnostics: readonly Diagnostic[],
): vscode.Diagnostic[] {
  const range = (r: { start: number; end: number }) =>
    new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end));
  return diagnostics
    .filter((d) => !d.suppressed && d.severity !== "off")
    .map((d) => {
      const message = d.help ? `${d.message}\n${d.help}` : d.message;
      const out = new vscode.Diagnostic(
        range(d.range),
        message,
        SEVERITY[d.severity as keyof typeof SEVERITY],
      );
      out.source = "dcx";
      const help = HELP.get(d.ruleId);
      out.code = help ? { value: d.ruleId, target: vscode.Uri.parse(help) } : d.ruleId;
      if (d.related?.length)
        out.relatedInformation = d.related.map(
          (r) =>
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(doc.uri, range(r.range)),
              r.message,
            ),
        );
      if (d.ruleId.startsWith("deprecation/")) out.tags = [vscode.DiagnosticTag.Deprecated];
      if (d.ruleId === "meta/unused-suppression") out.tags = [vscode.DiagnosticTag.Unnecessary];
      return out;
    });
}
