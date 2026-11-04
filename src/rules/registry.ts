import { isSeverity } from "../diagnostic/diagnostic";
import type { Rule } from "./rule";

const ID = /^([a-z]+)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Throws if any rule is malformed: a duplicate or badly-formed ID, a category that
 * doesn't match the ID's prefix, or missing description or explain text. Runs once at
 * startup and in a test, never per document.
 */
export function validateRegistry(rules: readonly Rule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    const match = ID.exec(rule.id);
    if (!match) throw new Error(`rule ID "${rule.id}" isn't category/kebab-name`);
    if (match[1] !== rule.category)
      throw new Error(`rule "${rule.id}" has category "${rule.category}"`);
    if (seen.has(rule.id)) throw new Error(`rule ID "${rule.id}" is registered twice`);
    seen.add(rule.id);
    if (!rule.description.trim()) throw new Error(`rule "${rule.id}" has no description`);
    if (rule.explain.trim().length <= rule.description.length)
      throw new Error(`rule "${rule.id}" has no explain text beyond its description`);
    if (!isSeverity(rule.defaultSeverity))
      throw new Error(`rule "${rule.id}" has default severity "${rule.defaultSeverity}"`);
  }
}

const byId = (a: Rule, b: Rule) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A registry over `rules`, sorted by ID; throws if they don't validate. */
export function registry(rules: readonly Rule[]) {
  validateRegistry(rules);
  const sorted = [...rules].sort(byId);
  const index = new Map(sorted.map((r) => [r.id, r]));
  return {
    all: (): Rule[] => [...sorted],
    get: (id: string): Rule | undefined => index.get(id),
  };
}
