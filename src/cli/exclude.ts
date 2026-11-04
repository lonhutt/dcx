import { relative, sep } from "node:path";

/**
 * Whether gitignore-style `patterns` exclude `path`, matched relative to `base`. A pattern
 * with no inner slash matches at any depth; a leading `/` anchors it to `base`; a trailing
 * `/` matches a directory and everything in it; `!` re-includes; the last match wins.
 */
export function excluded(patterns: readonly string[], base: string, path: string): boolean {
  const rel = relative(base, path).split(sep).join("/");
  if (rel.startsWith("../")) return false;
  let out = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    let p = negated ? raw.slice(1) : raw;
    if (!p || p.startsWith("#")) continue;
    p = p.replace(/\/+$/, "");
    const anchored = p.startsWith("/") || p.includes("/");
    p = p.replace(/^\//, "");
    const globs = (anchored ? [p] : [p, `**/${p}`]).flatMap((g) => [g, `${g}/**`]);
    if (globs.some((g) => new Bun.Glob(g).match(rel))) out = !negated;
  }
  return out;
}
