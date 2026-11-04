import type { Diagnostic } from "../diagnostic/diagnostic";
import { paint, type Paint } from "./color";
import { excerpt } from "./excerpt";
import { count, shown, summary, type FileResult, type Reporter } from "./report";

/** The human format: location, message, source excerpt with a caret, help and docs. */
export const text: Reporter = (files, options) => {
  const p = paint(options.color);
  const blocks = files.flatMap((f) => f.diagnostics.filter(shown).map((d) => block(f, d, p)));
  const c = count(files);
  if (options.quiet) return blocks.join("");
  const mark = c.error ? p.red("✖") : c.warning ? p.yellow("⚠") : p.blue("✔");
  return `${blocks.join("")}${mark} ${p.bold(summary(c))}\n`;
};

function block(f: FileResult, d: Diagnostic, p: Paint): string {
  const { line, column } = f.lines.terminalPositionAt(d.range.start);
  const sev = d.severity === "error" ? p.red : d.severity === "warning" ? p.yellow : p.blue;
  const out = [
    `${p.bold(`${f.path}:${line}:${column}:`)} ${sev(d.severity)}: ${d.message} ${p.dim(`[${d.ruleId}]`)}`,
    "",
    excerpt(f.text, f.lines, d.range, p),
    "",
  ];
  if (d.help) out.push(`  ${p.cyan("help:")} ${d.help}`);
  if (d.fix) out.push(`  ${p.cyan("fix:")}  ${d.fix.title} (dcx check --fix)`);
  if (d.docsUrl) out.push(`  ${p.cyan("docs:")} ${d.docsUrl}`);
  if (d.help || d.fix || d.docsUrl) out.push("");
  return out.join("\n") + "\n";
}
