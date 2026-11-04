import type { Diagnostic } from "../diagnostic/diagnostic";
import type { LineIndex } from "../position/position";
import type { Directive } from "./directive";

/**
 * Marks each diagnostic a directive covers as suppressed (with the directive's reason),
 * and returns the directives that covered nothing.
 */
export function apply(
  diagnostics: readonly Diagnostic[],
  directives: readonly Directive[],
  lines: LineIndex,
): { diagnostics: Diagnostic[]; unused: Directive[] } {
  const used = new Set<Directive>();
  const out = diagnostics.map((d) => {
    const line = lines.lineAt(d.range.start);
    const covering = directives.filter(
      (s) =>
        line >= s.lines.first &&
        line <= s.lines.last &&
        (s.ruleIds.length === 0 || s.ruleIds.includes(d.ruleId)),
    );
    const by = covering[0];
    if (!by) return d;
    covering.forEach((s) => used.add(s));
    return { ...d, suppressed: true, ...(by.reason && { suppressReason: by.reason }) };
  });
  return { diagnostics: out, unused: directives.filter((s) => !used.has(s)) };
}
