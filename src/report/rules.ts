import type { Severity } from "../diagnostic/diagnostic";
import type { Category, Rule } from "../rules/rule";

/** Where each rule's reference entry lives; `#` plus {@link ruleAnchor}. */
export const RULES_URL = "https://github.com/lonhutt/dcx/blob/main/RULES.md";

/** One catalog entry; the `--list-rules --format json` contract, and what RULES.md is built from. */
export interface RuleInfo {
  readonly id: string;
  readonly category: Category;
  readonly defaultSeverity: Severity;
  readonly description: string;
  readonly explain: string;
  readonly requiresNetwork: boolean;
  readonly fixable: boolean;
  readonly helpUri: string;
}

/** GitHub's heading anchor for a rule's `### id` heading. */
export const ruleAnchor = (id: string) => id.replace(/\//g, "").toLowerCase();

/** Sorted by ID. */
export function catalog(rules: readonly Rule[]): RuleInfo[] {
  return [...rules]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({
      id: r.id,
      category: r.category,
      defaultSeverity: r.defaultSeverity,
      description: r.description,
      explain: r.explain,
      requiresNetwork: r.requiresNetwork,
      fixable: r.fixable,
      helpUri: `${RULES_URL}#${ruleAnchor(r.id)}`,
    }));
}

/** The `--list-rules` table: one rule per line, padded into columns. */
export function listRules(rules: readonly Rule[]): string {
  const rows = catalog(rules).map((r) => [
    r.id,
    r.defaultSeverity,
    [r.requiresNetwork && "online", r.fixable && "fixable"].filter(Boolean).join(","),
    r.description,
  ]);
  const width = (i: number) => Math.max(...rows.map((r) => r[i]!.length));
  return rows
    .map((r) =>
      [r[0]!.padEnd(width(0)), r[1]!.padEnd(width(1)), r[2]!.padEnd(width(2)), r[3]].join("  "),
    )
    .join("\n")
    .concat("\n");
}

/** The `--explain` text. */
export function explainRule(r: RuleInfo): string {
  const flags = [
    `default: ${r.defaultSeverity}`,
    r.requiresNetwork && "needs --online",
    r.fixable && "fixable with --fix",
  ];
  return `${r.id}: ${r.description}\n(${flags.filter(Boolean).join("; ")})\n\n${r.explain.trim()}\n`;
}
