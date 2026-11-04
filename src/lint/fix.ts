import type { Diagnostic, TextEdit } from "../diagnostic/diagnostic";
import { applyEdits, parse, type Document } from "../jsonc/jsonc";

/** A single fix whose own edits overlap; a bug in the rule, never applied. */
export class OverlapError extends Error {
  constructor(
    readonly ruleId: string,
    readonly a: TextEdit,
    readonly b: TextEdit,
  ) {
    super(
      `${ruleId}: fix edits overlap at ${a.range.start}-${a.range.end} and ${b.range.start}-${b.range.end}`,
    );
  }
}

/** Edits touching the same spot; two inserts at one offset count, since their order is a guess. */
const overlaps = (a: TextEdit, b: TextEdit) =>
  (a.range.start < b.range.end && b.range.start < a.range.end) ||
  a.range.start === b.range.start ||
  (a.range.start === a.range.end && a.range.start === b.range.end) ||
  (b.range.start === b.range.end && b.range.start === a.range.end);

const byStart = (a: TextEdit, b: TextEdit) =>
  a.range.start - b.range.start || a.range.end - b.range.end;

/**
 * Applies the fixes on `diagnostics` that don't collide. Taken in order, a fix that
 * overlaps one already taken waits for the next pass, when it's recomputed against the
 * new text. Throws {@link OverlapError} for a fix that overlaps itself.
 */
export function applyFixes(
  text: string,
  diagnostics: readonly Diagnostic[],
): { text: string; applied: Diagnostic[] } {
  const taken: TextEdit[] = [];
  const applied: Diagnostic[] = [];
  for (const d of diagnostics) {
    if (!d.fix?.edits.length || d.suppressed || d.severity === "off") continue;
    const edits = [...d.fix.edits].sort(byStart);
    for (let i = 1; i < edits.length; i++)
      if (overlaps(edits[i - 1]!, edits[i]!))
        throw new OverlapError(d.ruleId, edits[i - 1]!, edits[i]!);
    if (edits.some((e) => taken.some((t) => overlaps(e, t)))) continue;
    taken.push(...edits);
    applied.push(d);
  }
  const out = applyEdits(
    text,
    taken.map((e) => ({
      offset: e.range.start,
      length: e.range.end - e.range.start,
      content: e.newText,
    })),
  );
  return { text: out, applied };
}

export interface FixResult {
  readonly text: string;
  /** Fixes applied, across every pass. */
  readonly applied: number;
  /** Still fixable after the last pass; non-zero only when the pass cap was hit. */
  readonly unconverged: number;
}

export const MAX_PASSES = 10;

/**
 * Fixes `text` to convergence: apply, re-lint, repeat while there's something left to
 * fix, up to {@link MAX_PASSES}. A file that never settles is reported, not looped on.
 */
export async function fixDocument(
  text: string,
  uri: string,
  lint: (doc: Document) => Promise<readonly Diagnostic[]>,
  signal?: AbortSignal,
): Promise<FixResult> {
  let applied = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (signal?.aborted) break;
    const found = await lint(parse(uri, text));
    const next = applyFixes(text, found);
    if (!next.applied.length || next.text === text) return { text, applied, unconverged: 0 };
    applied += next.applied.length;
    text = next.text;
  }
  const left = (await lint(parse(uri, text))).filter(
    (d) => d.fix && !d.suppressed && d.severity !== "off",
  );
  return { text, applied, unconverged: left.length };
}
