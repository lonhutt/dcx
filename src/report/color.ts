export type ColorMode = "auto" | "always" | "never";

/**
 * Whether to colour output. An explicit `always`/`never` wins; under `auto`, `NO_COLOR`
 * beats `FORCE_COLOR`, which beats TTY detection (no-color.org, then the de facto
 * FORCE_COLOR convention).
 */
export function colorEnabled(
  mode: ColorMode,
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>,
): boolean {
  if (mode !== "auto") return mode === "always";
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  return !!stream.isTTY;
}

export interface Paint {
  readonly red: (s: string) => string;
  readonly yellow: (s: string) => string;
  readonly blue: (s: string) => string;
  readonly cyan: (s: string) => string;
  readonly dim: (s: string) => string;
  readonly bold: (s: string) => string;
}

// each span resets itself; nesting one inside another never leaks the outer colour
const sgr = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;

const ON: Paint = {
  red: sgr(31, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  cyan: sgr(36, 39),
  dim: sgr(2, 22),
  bold: sgr(1, 22),
};
const id = (s: string) => s;
const OFF: Paint = { red: id, yellow: id, blue: id, cyan: id, dim: id, bold: id };

export const paint = (enabled: boolean): Paint => (enabled ? ON : OFF);
