import { deprecationRules } from "./deprecation/index";
import { featureRules } from "./feature/index";
import { fsRules } from "./fs/index";
import { lifecycleRules } from "./lifecycle/index";
import { metaRules } from "./meta/index";
import { mountRules } from "./mount/index";
import { portRules } from "./port/index";
import { registry } from "./registry";
import { reproRules } from "./repro/index";
import type { Rule } from "./rule";
import { scenarioRules } from "./scenario/index";
import { schemaRules } from "./schema/index";
import { securityRules } from "./security/index";
import { semanticRules } from "./semantic/index";
import { styleRules } from "./style/index";
import { syntaxRules } from "./syntax/index";
import { vscodeRules } from "./vscode/index";

/**
 * The manifest: every rule, by explicit import. No registration by side effect, which a
 * bundler is free to drop; a rule left out of this list fails the completeness test.
 */
export const RULES: readonly Rule[] = [
  ...syntaxRules,
  ...schemaRules,
  ...scenarioRules,
  ...semanticRules,
  ...fsRules,
  ...deprecationRules,
  ...featureRules,
  ...portRules,
  ...mountRules,
  ...lifecycleRules,
  ...securityRules,
  ...reproRules,
  ...vscodeRules,
  ...styleRules,
  ...metaRules,
];

const rules = registry(RULES);

/** Every rule, sorted by ID. */
export const all = rules.all;
export const get = rules.get;
export type { Category, Finding, Pass, Rule } from "./rule";
