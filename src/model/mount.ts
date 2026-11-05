import { posix } from "node:path";

/** A mount, from the `type=bind,source=…,target=…` string or the object form. */
export interface MountSpec {
  readonly type: string;
  readonly source?: string;
  readonly target?: string;
  readonly options: Readonly<Record<string, string>>;
  readonly fromString: boolean;
}

export type MountProblem = { readonly part: string; readonly reason: string };

/** Docker's `--mount` keys, aliases included; anything else Docker rejects. */
const KEYS = new Set([
  "type",
  "source",
  "src",
  "target",
  "destination",
  "dst",
  "readonly",
  "ro",
  "consistency",
  "bind-propagation",
  "bind-nonrecursive",
  "bind-recursive",
  "volume-driver",
  "volume-label",
  "volume-nocopy",
  "volume-opt",
  "volume-subpath",
  "tmpfs-size",
  "tmpfs-mode",
  "external",
]);
/** Keys that may stand alone, as flags. */
const FLAGS = new Set(["readonly", "ro", "volume-nocopy", "bind-nonrecursive", "external"]);
const TYPES = new Set(["bind", "volume", "tmpfs", "npipe", "cluster", "image"]);

/**
 * Splits on commas, honouring double quotes and backslash-escaped commas, the way
 * Docker's CSV reader does for `--mount`. A quoted value keeps its content, not its quotes.
 */
export function splitMount(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === ",") {
      cur += ",";
      i++;
    } else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

/** The string form, parsed; `problems` lists every part that isn't valid mount syntax. */
export function parseMount(s: string): { mount: MountSpec; problems: MountProblem[] } {
  const options: Record<string, string> = {};
  const problems: MountProblem[] = [];
  const parts = splitMount(s);
  parts.forEach((raw, i) => {
    const part = raw.trim();
    // Docker tolerates one trailing comma
    if (!part && i === parts.length - 1 && parts.length > 1) return;
    const eq = part.indexOf("=");
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? undefined : part.slice(eq + 1);
    if (!key) problems.push({ part: raw, reason: "is missing a key" });
    else if (!KEYS.has(key)) problems.push({ part: raw, reason: `has an unknown key "${key}"` });
    else if (value === undefined && !FLAGS.has(key))
      problems.push({ part: raw, reason: "needs a value" });
    else options[key] = value ?? "true";
  });
  const type = options.type ?? "volume";
  if (options.type !== undefined && !TYPES.has(type))
    problems.push({ part: `type=${type}`, reason: `isn't a mount type` });
  return { mount: normalise(options, true), problems };
}

/** The object form, keyed like the string form. */
export function objectMount(value: Record<string, unknown>): MountSpec {
  const options: Record<string, string> = {};
  for (const [k, v] of Object.entries(value))
    if (typeof v === "string" || typeof v === "boolean") options[k.toLowerCase()] = String(v);
  return normalise(options, false);
}

function normalise(options: Record<string, string>, fromString: boolean): MountSpec {
  const source = options.source ?? options.src;
  const target = options.target ?? options.destination ?? options.dst;
  return {
    type: options.type ?? "volume",
    ...(source !== undefined && { source }),
    ...(target !== undefined && { target }),
    options,
    fromString,
  };
}

/** A container path, normalised for comparison: always POSIX, whatever runs the linter. */
export function normalisedTarget(target: string): string {
  const n = posix.normalize(target);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}
