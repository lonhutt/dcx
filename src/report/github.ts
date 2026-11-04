import type { Severity } from "../diagnostic/diagnostic";
import { shown, type Reporter } from "./report";

const COMMAND: Record<Exclude<Severity, "off">, string> = {
  error: "error",
  warning: "warning",
  info: "notice",
};

/** A workflow command's message: `%`, CR and LF escaped. */
export const escapeMessage = (s: string) =>
  s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** A workflow command's property value: the message escapes plus `:` and `,`. */
export const escapeProperty = (s: string) =>
  escapeMessage(s).replaceAll(":", "%3A").replaceAll(",", "%2C");

/** GitHub Actions annotations, `::error file=…,line=…::message`, one per finding. */
export const github: Reporter = (files) =>
  files
    .flatMap((f) =>
      f.diagnostics.filter(shown).flatMap((d) => {
        if (d.severity === "off") return [];
        const start = f.lines.terminalPositionAt(d.range.start);
        const end = f.lines.terminalPositionAt(d.range.end);
        const props = [
          `file=${escapeProperty(f.path.replace(/\\/g, "/"))}`,
          `line=${start.line}`,
          `col=${start.column}`,
          `endLine=${end.line}`,
          `endColumn=${end.column}`,
          `title=${escapeProperty(d.ruleId)}`,
        ];
        const message = d.help
          ? `${d.message} (${d.help}) [${d.ruleId}]`
          : `${d.message} [${d.ruleId}]`;
        return [`::${COMMAND[d.severity]} ${props.join(",")}::${escapeMessage(message)}\n`];
      }),
    )
    .join("");
