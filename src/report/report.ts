import type { Diagnostic } from "../diagnostic/diagnostic";
import type { LineIndex } from "../position/position";

/** One linted file and what was found in it. */
export interface FileResult {
  /** As it should be printed: relative to the working directory. */
  readonly path: string;
  readonly text: string;
  readonly lines: LineIndex;
  readonly diagnostics: readonly Diagnostic[];
}

/** Turns results into output; never writes it anywhere itself. */
export type Reporter = (files: readonly FileResult[], options: ReportOptions) => string;

export interface ReportOptions {
  readonly color: boolean;
  /** No summary line. */
  readonly quiet: boolean;
}

/** Suppressed findings stay in the results for `json`; everything else skips them. */
export const shown = (d: Diagnostic) => !d.suppressed;

export interface Counts {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
  readonly files: number;
}

export function count(files: readonly FileResult[]): Counts {
  const c = { error: 0, warning: 0, info: 0, files: 0 };
  for (const f of files) {
    const visible = f.diagnostics.filter(shown);
    if (visible.length) c.files++;
    for (const d of visible) if (d.severity !== "off") c[d.severity]++;
  }
  return c;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `1 error, 2 warnings in 1 file`; empty counts read `no problems`. */
export function summary(c: Counts): string {
  const parts = [
    c.error && plural(c.error, "error"),
    c.warning && plural(c.warning, "warning"),
    c.info && plural(c.info, "info"),
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")} in ${plural(c.files, "file")}` : "no problems";
}
