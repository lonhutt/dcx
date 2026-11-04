import { shown, type Reporter } from "./report";

/** `file:line:col: severity: message [rule]`, one per line; vim's `%f:%l:%c: %m`. */
export const compact: Reporter = (files) =>
  files
    .flatMap((f) =>
      f.diagnostics.filter(shown).map((d) => {
        const { line, column } = f.lines.terminalPositionAt(d.range.start);
        return `${f.path}:${line}:${column}: ${d.severity}: ${d.message} [${d.ruleId}]\n`;
      }),
    )
    .join("");
