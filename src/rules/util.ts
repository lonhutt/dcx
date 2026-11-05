import { rangeOf, type Node } from "../jsonc/jsonc";
import type { Range } from "../position/position";
import type { Rule } from "./rule";

export { REFERENCE } from "../schema/docs-url";

/** Declares a rule; the defaults cover what most rules share. */
export function rule(
  r: Omit<Rule, "requiresNetwork" | "fixable" | "category"> &
    Partial<Pick<Rule, "requiresNetwork" | "fixable">>,
): Rule {
  return Object.freeze({
    requiresNetwork: false,
    fixable: false,
    ...r,
    category: r.id.slice(0, r.id.indexOf("/")) as Rule["category"],
  });
}

/** A property's key span, given its value node; the value's own span for an array element. */
export function keyOf(node: Node): Range {
  const key = node.parent?.type === "property" ? node.parent.children?.[0] : undefined;
  return rangeOf(key ?? node);
}

/** `PropertyNameExpected` → `Property name expected`. */
export const sentence = (code: string) =>
  code.replace(/(?<!^)([A-Z])/g, " $1").replace(/ [A-Z]/g, (s) => s.toLowerCase());

/** A JSON string value's content span: inside the quotes. */
export function inside(node: Node): Range {
  return { start: node.offset + 1, end: node.offset + node.length - 1 };
}
