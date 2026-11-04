import type { Diagnostic, Severity } from "../../diagnostic/diagnostic";
import type { LineIndex } from "../../position/position";

/** An expected finding, from a `// want: <severity>: <message substring>` annotation. */
export interface Want {
  /** 0-based line the finding must start on: the annotation's own line. */
  readonly line: number;
  readonly severity: Severity;
  readonly message: string;
  /** 0-based character, from a caret line (`//   ^`) under the annotated line. */
  readonly column?: number;
}

const MARKER = "// want: ";

/** Every annotation in a fixture; one line may carry several, each starting `// want: `. */
export function parseWants(text: string): Want[] {
  const lines = text.split(/\r?\n/);
  return lines.flatMap((line, i) => {
    const at = line.indexOf(MARKER);
    if (at < 0) return [];
    const caret = lines[i + 1]?.match(/^\s*\/\/(\s*)\^\s*$/);
    const column = caret ? lines[i + 1]!.indexOf("^") : undefined;
    return line
      .slice(at + MARKER.length)
      .split(` ${MARKER}`)
      .map((spec) => {
        const colon = spec.indexOf(": ");
        return {
          line: i,
          severity: spec.slice(0, colon) as Severity,
          message: spec.slice(colon + 2).trim(),
          ...(column !== undefined && { column }),
        };
      });
  });
}

/** Whether `want` describes `got`. */
function matches(want: Want, got: Diagnostic, lines: LineIndex): boolean {
  const { line, character } = lines.positionAt(got.range.start);
  return (
    line === want.line &&
    got.severity === want.severity &&
    got.message.includes(want.message) &&
    (want.column === undefined || character === want.column)
  );
}

/**
 * Pairs wants with findings one-to-one and describes whatever's left over on either side,
 * with the source line for context.
 */
export function compare(
  wants: readonly Want[],
  got: readonly Diagnostic[],
  text: string,
  lines: LineIndex,
): { ok: true } | { ok: false; report: string } {
  const unmatched = [...got];
  const missing: Want[] = [];
  for (const want of wants) {
    const i = unmatched.findIndex((d) => matches(want, d, lines));
    if (i < 0) missing.push(want);
    else unmatched.splice(i, 1);
  }
  if (!missing.length && !unmatched.length) return { ok: true };
  const source = text.split(/\r?\n/);
  const context = (line: number) => `    ${line + 1} | ${source[line] ?? ""}`;
  const report = [
    ...missing.map(
      (w) =>
        `missing: line ${w.line + 1}${w.column !== undefined ? ` col ${w.column + 1}` : ""}: ${w.severity}: ${w.message}\n${context(w.line)}`,
    ),
    ...unmatched.map((d) => {
      const { line, character } = lines.positionAt(d.range.start);
      return `unexpected: line ${line + 1} col ${character + 1}: ${d.severity}: ${d.message} [${d.ruleId}]\n${context(line)}`;
    }),
  ].join("\n");
  return { ok: false, report };
}

/** `text` with its annotations rewritten to describe `got`; the `UPDATE=1` path. */
export function rewrite(text: string, got: readonly Diagnostic[], lines: LineIndex): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out = text.split(/\r?\n/).map((line) => {
    const at = line.indexOf(` ${MARKER}`);
    return at < 0 ? line : line.slice(0, at);
  });
  for (const d of got) {
    const { line } = lines.positionAt(d.range.start);
    out[line] += ` ${MARKER}${d.severity}: ${d.message}`;
  }
  return out.join(eol);
}
