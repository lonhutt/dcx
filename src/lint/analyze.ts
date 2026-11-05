import { basename, dirname } from "node:path";
import {
  SEVERITY_RANK,
  sortDiagnostics,
  type Diagnostic,
  type Severity,
} from "../diagnostic/diagnostic";
import type { FeatureResolver } from "../features/resolver";
import type { Document } from "../jsonc/jsonc";
import { DEFAULTS, type Config } from "../lintconfig/config";
import { lower } from "../model/lower";
import { NO_SOURCES, type ExtensionSources } from "../registry/sources";
import { runRules, type PassInput } from "../rules/engine";
import { all, get } from "../rules/index";
import type { Rule } from "../rules/rule";
import { schemaErrors } from "../schema/translate";
import { apply } from "../suppress/apply";
import { parseDirectives, type Directive } from "../suppress/directive";
import type { FileSystem } from "../vfs/vfs";

export interface AnalyzeOptions {
  readonly fs: FileSystem;
  /** The merged config, all layers applied. */
  readonly config?: Config;
  /** Defaults to every registered rule. */
  readonly rules?: readonly Rule[];
  /** Used only when `config.online` is on. */
  readonly features?: FeatureResolver;
  readonly extensions?: ExtensionSources;
  readonly signal?: AbortSignal;
}

export interface LintResult {
  /** Sorted. Suppressed findings stay in, marked `suppressed`, so JSON output can show why. */
  readonly diagnostics: readonly Diagnostic[];
  /** Suppression directives that matched nothing. */
  readonly unused: readonly Directive[];
}

const UNUSED_SUPPRESSION = "meta/unused-suppression";

/**
 * Lints one parsed devcontainer.json at `path`. This is the facade every entry point
 * calls (the CLI, the editor extension, the language server), and it never throws.
 */
export async function analyze(
  doc: Document,
  path: string,
  options: AnalyzeOptions,
): Promise<LintResult> {
  const config = options.config ?? DEFAULTS;
  const signal = options.signal ?? new AbortController().signal;
  const rules = (options.rules ?? all()).filter((r) => config.online || !r.requiresNetwork);
  // schema errors on a tree the parser had to guess at are mostly noise
  const parsedCleanly = doc.errors.length === 0 && doc.root?.type === "object";
  const runnable = parsedCleanly ? rules : rules.filter((r) => r.category === "syntax");

  const input = passInput(doc, path, options, config, signal, parsedCleanly);
  const found = await runRules(runnable, input, (rule) => severityFor(rule, config));

  const { diagnostics, unused } = apply(found, parseDirectives(doc), doc.lines);
  const unusedRule = rules.find((r) => r.id === UNUSED_SUPPRESSION);
  const unusedSeverity = unusedRule ? severityFor(unusedRule, config) : "off";
  // a directive for a rule that didn't run (offline, --rule, a parse error) can't be judged;
  // one naming no rule dcx knows always can
  const ran = new Set(runnable.filter((r) => severityFor(r, config) !== "off").map((r) => r.id));
  const everything = !options.rules && parsedCleanly;
  const judged = unused.filter((d) =>
    d.ruleIds.length ? d.ruleIds.every((id) => ran.has(id) || !get(id)) : everything,
  );
  const extra: Diagnostic[] =
    unusedSeverity === "off" || signal.aborted
      ? []
      : judged.map((d) => ({
          ruleId: UNUSED_SUPPRESSION,
          severity: unusedSeverity,
          range: d.range,
          message: d.ruleIds.length
            ? `This suppression of ${d.ruleIds.join(", ")} matched nothing`
            : "This suppression matched nothing",
          help: "remove the directive, or fix the rule ID it names",
        }));
  return { diagnostics: sortDiagnostics([...diagnostics, ...extra]), unused: judged };
}

/** The pass a rule sees for `doc`; exported for the rule test harness. */
export function passInput(
  doc: Document,
  path: string,
  options: AnalyzeOptions,
  config: Config,
  signal: AbortSignal,
  parsedCleanly = true,
): PassInput {
  const model = lower(doc);
  return Object.freeze({
    doc,
    model,
    fs: options.fs,
    dir: dirname(path),
    root: workspaceRoot(path),
    schema: parsedCleanly ? schemaErrors(model) : [],
    settings: { allowUnpinnedFeatures: config.allowUnpinned ?? [] },
    features: config.online ? options.features : undefined,
    extensions: options.extensions ?? NO_SOURCES,
    signal,
  });
}

/**
 * The folder the dev container opens: the parent of `.devcontainer/` for a config
 * inside it (at any of the spec's nesting levels), or the config's own folder otherwise.
 */
export function workspaceRoot(path: string): string {
  let dir = dirname(path);
  for (let i = 0; i < 2; i++) {
    if (basename(dir) === ".devcontainer") return dirname(dir);
    dir = dirname(dir);
  }
  return dirname(path);
}

/**
 * The severity `rule` runs at: its own setting, else its category's, else its default;
 * then capped at `maxSeverity`. A cap never turns a rule on.
 */
export function severityFor(rule: Rule, config: Config): Severity {
  const configured =
    config.rules?.[rule.id] ?? config.categories?.[rule.category] ?? rule.defaultSeverity;
  const cap = config.maxSeverity;
  return cap && SEVERITY_RANK[configured] > SEVERITY_RANK[cap] ? cap : configured;
}

/** Whether `diagnostics` should fail the run: any unsuppressed finding at or above `failOn`. */
export function fails(diagnostics: readonly Diagnostic[], config: Config): boolean {
  const threshold = SEVERITY_RANK[config.failOn ?? "error"];
  return diagnostics.some((d) => !d.suppressed && SEVERITY_RANK[d.severity] >= threshold);
}
