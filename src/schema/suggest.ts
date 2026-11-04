/**
 * The closest candidate, if it's close enough to be a likely typo rather than a guess:
 * within one edit per five characters, plus one. A confident wrong suggestion is worse
 * than none.
 */
export function suggest(word: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(word.length / 5)) + 1;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return best;
}

/** Edit distance, counting a swap of neighbours as one edit; `nmae` is one typo, not two. */
export function distance(a: string, b: string): number {
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        cur[j] = Math.min(cur[j]!, before[j - 2]! + 1);
    }
    [before, prev] = [prev, cur];
  }
  return prev[b.length]!;
}
