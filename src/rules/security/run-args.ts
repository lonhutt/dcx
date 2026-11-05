/** Docker flags that take a value; for these, `--flag value` and `--flag=value` mean the same. */
const VALUED = new Set([
  "--cap-add",
  "--security-opt",
  "--pid",
  "--ipc",
  "--userns",
  "--network",
  "--net",
  "--device",
  "-v",
  "--volume",
  "--mount",
  "--uts",
  "--cgroupns",
]);

export interface RunArg {
  readonly flag: string;
  readonly value: string | undefined;
  /** Index into `runArgs` of the flag itself. */
  readonly index: number;
}

/** `runArgs` as flags and their values, both `--cap-add=X` and `--cap-add X` syntaxes. */
export function parseRunArgs(args: readonly unknown[]): RunArg[] {
  const out: RunArg[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== "string" || !a.startsWith("-")) continue;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (eq > 0) out.push({ flag, value: a.slice(eq + 1), index: i });
    else if (VALUED.has(flag) && typeof args[i + 1] === "string")
      out.push({ flag, value: args[++i] as string, index: i - 1 });
    else out.push({ flag, value: undefined, index: i });
  }
  return out;
}
