import base from "./generated/devContainer.base.schema.json" with { type: "json" };

interface Schema {
  readonly $ref?: string;
  readonly allOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly patternProperties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: Schema | boolean;
  readonly items?: Schema | readonly Schema[];
  readonly enum?: readonly unknown[];
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly markdownDescription?: string;
  readonly deprecated?: boolean;
  readonly deprecationMessage?: string;
}

// a few properties (portsAttributes) only have the VS Code-flavoured markdownDescription
const text = (s: Schema) => s.description ?? s.markdownDescription;

const ROOT = base as unknown as Schema & { readonly definitions: Record<string, Schema> };
const DEFINITIONS = ROOT.definitions;

/** `schema` and everything it composes: refs followed, `allOf`/`anyOf`/`oneOf` flattened. */
function expand(schema: Schema, seen = new Set<Schema>()): Schema[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const ref = schema.$ref?.match(/^#\/definitions\/(.+)$/)?.[1];
  return [
    schema,
    ...(ref && DEFINITIONS[ref] ? expand(DEFINITIONS[ref], seen) : []),
    ...[...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].flatMap((s) =>
      expand(s, seen),
    ),
  ];
}

/**
 * Every schema that can describe the value at `path` (property names and array indices,
 * as `getLocation` gives them), across all three scenarios: the editor doesn't know yet
 * which one the user means.
 */
function schemasAt(path: readonly (string | number)[]): Schema[] {
  let current = expand(ROOT);
  for (const seg of path) {
    current = current
      .flatMap((s): (Schema | undefined)[] => {
        if (typeof seg === "number")
          return Array.isArray(s.items) ? [s.items[seg]] : [s.items as Schema | undefined];
        const named = s.properties?.[seg];
        if (named) return [named];
        const patterned = Object.entries(s.patternProperties ?? {})
          .filter(([p]) => new RegExp(p, "u").test(seg))
          .map(([, v]) => v);
        if (patterned.length) return patterned;
        return typeof s.additionalProperties === "object" ? [s.additionalProperties] : [];
      })
      .filter((s): s is Schema => s !== undefined)
      .flatMap((s) => expand(s));
  }
  return current;
}

export interface Description {
  readonly description: string;
  readonly deprecated?: string;
}

/** The spec's description of the property at `path`, or undefined when the schema has none. */
export function describe(path: readonly (string | number)[]): Description | undefined {
  const schemas = schemasAt(path);
  const description = schemas.map(text).find(Boolean);
  if (!description) return undefined;
  const deprecated = schemas.find((s) => s.deprecated || s.deprecationMessage);
  return {
    description,
    ...(deprecated && { deprecated: deprecated.deprecationMessage ?? "deprecated" }),
  };
}

/** Property names the object at `path` can have, with their descriptions, sorted. */
export function propertiesAt(
  path: readonly (string | number)[],
): { name: string; description?: string }[] {
  const out = new Map<string, string | undefined>();
  for (const s of schemasAt(path))
    for (const [name, p] of Object.entries(s.properties ?? {}))
      // upstream lists "additionalProperties" as a property of devContainerCommon by mistake
      if (name !== "additionalProperties" && !out.get(name))
        out.set(name, expand(p).map(text).find(Boolean));
  return [...out]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, description]) => ({ name, ...(description && { description }) }));
}

/** The values the schema allows at `path`: enums, and `true`/`false` for a boolean. */
export function valuesAt(path: readonly (string | number)[]): unknown[] {
  const out = new Set<unknown>();
  for (const s of schemasAt(path)) {
    for (const v of s.enum ?? []) out.add(v);
    const types = typeof s.type === "string" ? [s.type] : (s.type ?? []);
    if (types.includes("boolean")) [true, false].forEach((v) => out.add(v));
  }
  return [...out];
}
