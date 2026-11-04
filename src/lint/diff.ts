const CONTEXT = 3;

/** A unified diff of `before` against `after`, `--- a/path` / `+++ b/path`; empty if equal. */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const ops = lineOps(splitLines(before), splitLines(after));
  const changed = ops.flatMap((o, i) => (o.kind === " " ? [] : [i]));

  // runs of changes no more than 2 * CONTEXT unchanged lines apart share a hunk
  const groups: [number, number][] = [];
  for (const i of changed) {
    const last = groups.at(-1);
    if (last && i - last[1] <= 2 * CONTEXT + 1) last[1] = i;
    else groups.push([i, i]);
  }

  let out = `--- a/${path}\n+++ b/${path}\n`;
  for (const [first, last] of groups) {
    const slice = ops.slice(Math.max(0, first - CONTEXT), Math.min(ops.length, last + CONTEXT + 1));
    const before = ops.slice(0, Math.max(0, first - CONTEXT));
    const aStart = before.filter((o) => o.kind !== "+").length;
    const bStart = before.filter((o) => o.kind !== "-").length;
    const aLen = slice.filter((o) => o.kind !== "+").length;
    const bLen = slice.filter((o) => o.kind !== "-").length;
    out += `@@ -${span(aStart, aLen)} +${span(bStart, bLen)} @@\n`;
    for (const o of slice)
      out += o.kind + o.text + (o.text.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");
  }
  return out;
}

/** `start,len` in unified-diff convention: 1-based, and an empty side names the line before. */
const span = (start: number, len: number) =>
  len === 1 ? `${start + 1}` : `${len ? start + 1 : start},${len}`;

/** Lines with their terminators kept, so a changed line ending shows up as a change. */
function splitLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

interface Op {
  readonly kind: " " | "-" | "+";
  readonly text: string;
}

/** A shortest edit script by LCS, removals first; devcontainer.json is small enough for O(n·m). */
function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i++]! });
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!))
      ops.push({ kind: "-", text: a[i++]! });
    else ops.push({ kind: "+", text: b[j++]! });
  }
  return ops;
}
