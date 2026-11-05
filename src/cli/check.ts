import { dirname, relative, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { isSeverity, type Diagnostic, type Severity } from "../diagnostic/diagnostic";
import { discoverDevcontainer } from "../discovery/discovery";
import { parse } from "../jsonc/jsonc";
import { analyze, fails, severityFor } from "../lint/analyze";
import { unifiedDiff } from "../lint/diff";
import { fixDocument, OverlapError } from "../lint/fix";
import type { Config } from "../lintconfig/config";
import { ConfigError } from "../lintconfig/load";
import { ConfigResolver } from "../lintconfig/resolve";
import type { Fetch } from "../net/http";
import { LineIndex } from "../position/position";
import { compact } from "../report/compact";
import { colorEnabled, type ColorMode } from "../report/color";
import { github } from "../report/github";
import { json } from "../report/json";
import type { FileResult, Reporter } from "../report/report";
import { catalog, explainRule, listRules } from "../report/rules";
import { sarif } from "../report/sarif";
import { text } from "../report/text";
import { all, get } from "../rules/index";
import { suggest } from "../schema/suggest";
import { DiskFS } from "../vfs/diskfs";
import type { FileSystem } from "../vfs/vfs";
import { ToolError, UsageError } from "./errors";
import { excluded } from "./exclude";
import { services as servicesFor } from "../lint/services";
import { SourceError } from "../registry/build";

/** Where the CLI's output goes; swapped out in tests. */
export interface Io {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly isTTY: boolean;
  readonly home: string;
}

declare const DCX_COMMIT: string | undefined;
declare const DCX_BUILD_DATE: string | undefined;

/** `dcx 0.1.0 (abc1234, 2026-11-04)`; the commit and date are baked in at build time. */
export function versionString(): string {
  const commit = typeof DCX_COMMIT === "string" ? DCX_COMMIT : "dev";
  const date = typeof DCX_BUILD_DATE === "string" ? DCX_BUILD_DATE : "unknown date";
  return `dcx ${pkg.version} (${commit}, ${date})`;
}

const FORMATS = ["text", "json", "compact", "sarif", "github"] as const;
type Format = (typeof FORMATS)[number];

/** Every flag, with the help line that documents it; `--help` is generated from this. */
export const OPTIONS = {
  format: {
    type: "string",
    arg: "<fmt>",
    help: `Output format: ${FORMATS.join(", ")} (default: text)`,
  },
  config: { type: "string", arg: "<path>", help: "Use this config file; disables discovery" },
  "no-config": { type: "boolean", help: "Ignore any project config" },
  online: { type: "boolean", help: "Enable rules that need network access" },
  offline: { type: "boolean", help: "Force offline (the default)" },
  rule: { type: "string", multiple: true, arg: "<id>", help: "Run only this rule (repeatable)" },
  disable: { type: "string", multiple: true, arg: "<id>", help: "Disable this rule (repeatable)" },
  severity: {
    type: "string",
    multiple: true,
    arg: "<id>=<sev>",
    help: "Override one rule's severity (repeatable)",
  },
  "max-severity": {
    type: "string",
    arg: "<sev>",
    help: "Cap every finding's severity at error, warning or info",
  },
  "error-on-warning": { type: "boolean", help: "Exit 1 for warnings too" },
  fix: { type: "boolean", help: "Apply machine-applicable fixes in place" },
  "fix-dry-run": { type: "boolean", help: "Print the unified diff --fix would apply" },
  color: {
    type: "string",
    arg: "<when>",
    help: "Colour output: auto, always or never (default: auto)",
  },
  "no-color": { type: "boolean", help: "Same as --color=never" },
  quiet: { type: "boolean", short: "q", help: "Only print diagnostics, no summary" },
  explain: { type: "string", arg: "<id>", help: "Explain a rule and exit" },
  "list-rules": {
    type: "boolean",
    help: "Print the rule catalog and exit (respects --format json)",
  },
  version: { type: "boolean", short: "v", help: "Print the version and exit" },
  help: { type: "boolean", short: "h", help: "Show this help" },
} as const satisfies Record<
  string,
  { type: "string" | "boolean"; help: string; arg?: string; short?: string; multiple?: boolean }
>;

export const HELP = `Usage: dcx check [flags] [path...]

Lints devcontainer.json. Each path is a file, or a directory to find configs in
(default: the current directory).

Flags:
${Object.entries(OPTIONS)
  .map(([name, o]) => {
    const short = "short" in o ? `-${o.short}, ` : "    ";
    const flag = `${short}--${name}${"arg" in o ? ` ${o.arg}` : ""}`;
    return `  ${flag.padEnd(30)}${o.help}`;
  })
  .join("\n")}

Exit codes: 0 nothing at or above the failure threshold, 1 findings, 2 dcx couldn't run.`;

type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K] extends { multiple: true }
    ? string[]
    : (typeof OPTIONS)[K]["type"] extends "string"
      ? string
      : boolean;
};

/** Parses `check`'s arguments; throws {@link UsageError}. */
export function parseCheckArgs(args: string[]): { values: Values; paths: string[] } {
  const options = Object.fromEntries(
    Object.entries(OPTIONS).map(([name, o]) => [
      name,
      {
        type: o.type,
        ...("short" in o && { short: o.short }),
        ...("multiple" in o && { multiple: o.multiple }),
      },
    ]),
  ) as ParseArgsConfig["options"];
  try {
    const { values, positionals } = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Values, paths: positionals };
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

/** The flags layer of the config, validated against the registry. */
export function flagConfig(values: Values): Config {
  const rules: Record<string, Severity> = {};
  for (const id of values.disable ?? []) rules[known(id)] = "off";
  for (const s of values.severity ?? []) {
    const [id, sev] = s.split("=", 2);
    if (!id || !isSeverity(sev))
      throw new UsageError(`--severity takes <id>=<error|warning|info|off>, not "${s}"`);
    rules[known(id)] = sev;
  }
  const max = values["max-severity"];
  if (max !== undefined && (!isSeverity(max) || max === "off"))
    throw new UsageError(`--max-severity takes error, warning or info, not "${max}"`);
  if (values.online && values.offline)
    throw new UsageError("--online and --offline contradict each other");
  return {
    ...(Object.keys(rules).length && { rules }),
    ...(max && { maxSeverity: max as Config["maxSeverity"] }),
    ...(values["error-on-warning"] && { failOn: "warning" as const }),
    ...(values.online && { online: true }),
    ...(values.offline && { online: false }),
  };
}

function known(id: string): string {
  if (get(id)) return id;
  const guess = suggest(
    id,
    all().map((r) => r.id),
  );
  throw new UsageError(`unknown rule "${id}"${guess ? `; did you mean "${guess}"?` : ""}`);
}

function formatOf(values: Values): Format {
  const f = values.format ?? "text";
  if (!(FORMATS as readonly string[]).includes(f))
    throw new UsageError(`unknown format "${f}"; use one of ${FORMATS.join(", ")}`);
  return f as Format;
}

function colorOf(values: Values, io: Io): boolean {
  if (values["no-color"]) return false;
  const mode = values.color ?? "auto";
  if (mode !== "auto" && mode !== "always" && mode !== "never")
    throw new UsageError(`--color takes auto, always or never, not "${mode}"`);
  return colorEnabled(mode as ColorMode, { isTTY: io.isTTY }, io.env);
}

const REPORTERS: Record<Exclude<Format, "sarif">, Reporter> = { text, json, compact, github };

/** `dcx check`; resolves to the exit code. Throws {@link UsageError} and {@link ToolError}. */
export async function check(
  args: string[],
  io: Io,
  fs: FileSystem = new DiskFS(),
  fetchFn: Fetch = fetch,
): Promise<number> {
  const { values, paths } = parseCheckArgs(args);
  if (values.help) return (io.stdout(HELP + "\n"), 0);
  if (values.version) return (io.stdout(versionString() + "\n"), 0);
  const format = formatOf(values);
  const color = colorOf(values, io);

  if (values["list-rules"]) {
    io.stdout(
      format === "json" ? JSON.stringify(catalog(all()), null, 2) + "\n" : listRules(all()),
    );
    return 0;
  }
  if (values.explain !== undefined) {
    io.stdout(explainRule(catalog([get(known(values.explain))!])[0]!));
    return 0;
  }
  if (values.fix && values["fix-dry-run"])
    throw new UsageError("--fix and --fix-dry-run contradict each other");
  if (values.config && values["no-config"])
    throw new UsageError("--config and --no-config contradict each other");

  const flags = flagConfig(values);
  const only = values.rule?.map(known);
  const resolver = new ConfigResolver({
    fs,
    env: io.env,
    home: io.home,
    ...(values.config && { configPath: resolve(io.cwd, values.config) }),
    noConfig: !!values["no-config"],
    overrides: flags,
  });
  const configFor = (dir: string) =>
    resolver.for(dir).catch((err: Error) => {
      if (err instanceof ConfigError) throw new ToolError(configProblem(err, io));
      throw new ToolError(`can't read config: ${err.message}`);
    });

  const files: { path: string; config: Config }[] = [];
  for (const target of paths.length ? paths : ["."]) {
    const abs = resolve(io.cwd, target);
    const found = await discoverDevcontainer(fs, abs).catch((err: Error) => {
      throw new ToolError(`can't read ${target}: ${err.message}`);
    });
    if (!found.targets.length) {
      const searched = found.searched.map((p) => relative(io.cwd, p) || p);
      throw new ToolError(`no devcontainer.json found; looked for:\n  ${searched.join("\n  ")}`);
    }
    const isFile = (await fs.stat(abs))?.kind === "file";
    const config = await configFor(isFile ? dirname(abs) : abs);
    for (const path of found.targets) {
      // a file named outright is always linted; exclude only filters what discovery found
      if (!isFile && config.exclude?.length && excluded(config.exclude, config.base ?? abs, path))
        continue;
      if (!files.some((f) => f.path === path)) files.push({ path, config });
    }
  }

  const services = servicesFor(io.env, io.home, fs, fetchFn);
  const results: FileResult[] = [];
  let failed = false;
  let diffs = "";
  const rules = only && all().filter((r) => only.includes(r.id));
  // one Config per project config, so services.forConfig builds each one's sources once
  const named = new Map<Config, Config>();
  for (const { path, config: base } of files) {
    let config = base;
    if (only) named.set(base, (config = named.get(base) ?? withNamedRulesOn(only, base)));
    const extra = await services.forConfig(config).catch((err: Error) => {
      if (err instanceof SourceError) throw new ToolError(err.message);
      throw err;
    });
    const lint = async (doc: ReturnType<typeof parse>) =>
      (await analyze(doc, path, { fs, config, rules, ...extra })).diagnostics;

    let source = await fs.readFile(path).catch((err: Error) => {
      throw new ToolError(`can't read ${relative(io.cwd, path)}: ${err.message}`);
    });
    if (values.fix || values["fix-dry-run"]) {
      const before = source;
      const fixed = await fixDocument(source, path, lint).catch((err) => {
        if (err instanceof OverlapError)
          throw new ToolError(`a fix is broken; this is a bug in dcx: ${err.message}`);
        throw err;
      });
      if (fixed.unconverged)
        io.stderr(
          `dcx: ${relative(io.cwd, path)}: fixes didn't settle; ${fixed.unconverged} left unapplied (please report this)\n`,
        );
      if (values["fix-dry-run"])
        diffs += unifiedDiff(relative(io.cwd, path).replace(/\\/g, "/"), before, fixed.text);
      else {
        if (fixed.text !== before) await Bun.write(path, fixed.text);
        source = fixed.text;
      }
    }
    const doc = parse(path, source);
    const diagnostics = await lint(doc);
    failed ||= fails(diagnostics, config);
    results.push({
      path: relative(io.cwd, path) || path,
      text: source,
      lines: doc.lines,
      diagnostics,
    });
  }

  for (const f of services.failures()) io.stderr(`dcx: warning: ${f}\n`);
  if (values["fix-dry-run"]) io.stdout(diffs);
  else if (format === "sarif") io.stdout(sarif(results, all(), pkg.version));
  else io.stdout(REPORTERS[format](results, { color, quiet: !!values.quiet }));
  return failed ? 1 : 0;
}

/** `--rule` names a rule to run: one that's off by default or by config runs at warning. */
function withNamedRulesOn(only: readonly string[], config: Config): Config {
  const rules = { ...config.rules };
  for (const id of only) if (severityFor(get(id)!, config) === "off") rules[id] = "warning";
  return { ...config, rules };
}

/** A broken config file, rendered like any other finding: excerpt, caret and all. */
function configProblem(err: ConfigError, io: Io): string {
  const file: FileResult = {
    path: relative(io.cwd, err.path) || err.path,
    text: err.text,
    lines: new LineIndex(err.text),
    diagnostics: err.diagnostics as Diagnostic[],
  };
  return `invalid config file\n\n${text([file], { color: false, quiet: true }).trimEnd()}`;
}
