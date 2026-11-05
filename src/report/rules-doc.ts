import type { Category, Rule } from "../rules/rule";
import { catalog } from "./rules";

const ORDER: Category[] = [
  "syntax",
  "schema",
  "scenario",
  "semantic",
  "fs",
  "deprecation",
  "feature",
  "port",
  "mount",
  "lifecycle",
  "security",
  "vscode",
  "repro",
  "style",
  "meta",
];

/** RULES.md: a table per category, then each rule's explanation under its own heading. */
export function renderRulesDoc(rules: readonly Rule[]): string {
  const info = catalog(rules);
  const out = [
    "# dcx rules",
    "",
    "Generated from the rule registry by `bun scripts/rules-doc.ts`; don't edit by hand.",
    "",
    `${info.length} rules. Rules marked 🌐 only run with \`--online\`; ✎ means \`--fix\` can fix it.`,
    "Change a rule's severity in `.dcx.yaml` (`rules: { <id>: off }`), or for one line with",
    "`// dcx-disable-next-line <id> -- <reason>`.",
    "",
  ];
  for (const category of ORDER) {
    const inCat = info.filter((r) => r.category === category);
    if (!inCat.length) continue;
    out.push(`## ${category}`, "", "| Rule | Default | Description |", "| --- | --- | --- |");
    for (const r of inCat) {
      const marks = `${r.requiresNetwork ? " 🌐" : ""}${r.fixable ? " ✎" : ""}`;
      out.push(
        `| [\`${r.id}\`](#${r.helpUri.split("#")[1]})${marks} | ${r.defaultSeverity} | ${r.description.replace(/\|/g, "\\|")} |`,
      );
    }
    out.push("");
    for (const r of inCat) out.push(`### ${r.id}`, "", r.explain.trim(), "");
  }
  return out.join("\n");
}
