import type { Offset, Range } from "../position/position";

/** One `${...}` reference in a string. */
export interface Substitution {
  /** `localEnv`, `containerEnv`, or the whole name for a plain variable like `devcontainerId`. */
  readonly scope: string;
  /** The variable name after `scope:`, or `""` for a plain variable. */
  readonly name: string;
  /** Text after the second `:`; may itself hold substitutions, which are listed separately. */
  readonly default?: string;
  /** The whole `${...}`, in document offsets. */
  readonly range: Range;
}

/** The variables the spec defines that take no argument. */
export const PLAIN_VARIABLES = [
  "localWorkspaceFolder",
  "containerWorkspaceFolder",
  "localWorkspaceFolderBasename",
  "containerWorkspaceFolderBasename",
  "devcontainerId",
];

/** The variables the spec defines that take `:NAME` and an optional `:default`. */
export const SCOPED_VARIABLES = ["localEnv", "containerEnv", "env"];

/**
 * Every `${...}` in `raw`, the source spelling of a string literal starting at document
 * offset `base`; parsing the source rather than the decoded value keeps spans exact past
 * escapes. Nested references in a default are found too. An unclosed `${` is ignored.
 */
export function parseSubstitutions(raw: string, base: Offset): Substitution[] {
  const out: Substitution[] = [];
  const scan = (from: number, to: number) => {
    for (let i = raw.indexOf("${", from); i >= 0 && i < to; i = raw.indexOf("${", i + 2)) {
      // braces nest, so `${localEnv:A:${localEnv:B}}` closes at the last one
      let depth = 0;
      let end = -1;
      for (let j = i + 2; j < to; j++) {
        if (raw[j] === "{") depth++;
        else if (raw[j] === "}" && depth-- === 0) {
          end = j;
          break;
        }
      }
      if (end < 0) return;
      const inner = raw.slice(i + 2, end);
      const first = inner.indexOf(":");
      const second = first < 0 ? -1 : inner.indexOf(":", first + 1);
      out.push({
        scope: first < 0 ? inner : inner.slice(0, first),
        name: first < 0 ? "" : inner.slice(first + 1, second < 0 ? undefined : second),
        ...(second >= 0 && { default: inner.slice(second + 1) }),
        range: { start: base + i, end: base + end + 1 },
      });
      if (second >= 0) scan(i + 2 + second + 1, end);
      i = end - 1;
    }
  };
  scan(0, raw.length);
  return out.sort((a, b) => a.range.start - b.range.start);
}
