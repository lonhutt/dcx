import { elements, members, type Field } from "./model";
import type { DevContainer } from "./model";

export const LIFECYCLE = [
  "initializeCommand",
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand",
] as const;

export type LifecycleProperty = (typeof LIFECYCLE)[number];

/** One command: a property's value, or one named entry of its parallel (object) form. */
export type LifecycleCommand =
  | {
      readonly property: LifecycleProperty;
      readonly name?: string;
      readonly form: "string";
      readonly field: Field<string>;
    }
  | {
      readonly property: LifecycleProperty;
      readonly name?: string;
      readonly form: "array";
      readonly field: Field<unknown[]>;
      readonly argv: readonly Field<unknown>[];
    }
  | {
      readonly property: LifecycleProperty;
      readonly name?: string;
      readonly form: "other";
      readonly field: Field<unknown>;
    };

/** The object form itself, for rules about its shape rather than its commands. */
export interface ParallelForm {
  readonly property: LifecycleProperty;
  readonly field: Field<Record<string, unknown>>;
}

function command(
  property: LifecycleProperty,
  field: Field<unknown>,
  name?: string,
): LifecycleCommand {
  const base = { property, ...(name !== undefined && { name }) };
  if (typeof field.value === "string")
    return { ...base, form: "string", field: field as Field<string> };
  if (field.node.type === "array")
    return { ...base, form: "array", field: field as Field<unknown[]>, argv: elements(field.node) };
  return { ...base, form: "other", field };
}

/**
 * Every command in all six lifecycle properties, with the object form's entries
 * flattened in, so a rule that handles one handles all six.
 */
export function lifecycleCommands(model: DevContainer): LifecycleCommand[] {
  return LIFECYCLE.flatMap((property) => {
    const f = model.get(property);
    if (!f) return [];
    if (f.node.type !== "object") return [command(property, f)];
    return members(f.node).map(({ name, field }) => command(property, field, name));
  });
}

export function parallelForms(model: DevContainer): ParallelForm[] {
  return LIFECYCLE.flatMap((property) => {
    const f = model.get(property);
    return f?.node.type === "object"
      ? [{ property, field: f as Field<Record<string, unknown>> }]
      : [];
  });
}

/**
 * Shell operators outside quotes in `s`: `&&`, `||`, `|`, `;`, `>`, `<`, `&`. A
 * quote-aware scan, so `"a && b"` with its quotes doesn't count.
 */
export function shellOperators(s: string): string[] {
  const found: string[] = [];
  let quote: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "\\") i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === "&" || c === "|" || c === ">" || c === "<") {
      const two = s.slice(i, i + 2);
      const op = two === "&&" || two === "||" || two === ">>" ? two : c;
      found.push(op);
      i += op.length - 1;
    } else if (c === ";") found.push(c);
  }
  return found;
}
