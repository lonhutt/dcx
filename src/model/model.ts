import { rangeOf, type Document, type Node } from "../jsonc/jsonc";
import type { Range } from "../position/position";

/** A value from the document, with the node it came from; `node` is the span source. */
export interface Field<T> {
  readonly value: T;
  /** The value's node. */
  readonly node: Node;
  /** The property key's node; absent for array elements. */
  readonly key: Node | undefined;
}

/** Where a diagnostic about this field should point: its key if it has one. */
export function keySpan(field: Field<unknown>): Range {
  return rangeOf(field.key ?? field.node);
}

/** Which kind of container the config describes; decided before validation. */
export type Scenario =
  | { readonly kind: "unknown" }
  | { readonly kind: "image"; readonly image: Field<string> }
  | { readonly kind: "dockerfile"; readonly dockerfile: Field<string>; readonly legacy: boolean }
  | {
      readonly kind: "compose";
      readonly files: readonly Field<string>[];
      readonly service: Field<string> | undefined;
    }
  | { readonly kind: "ambiguous"; readonly sources: readonly Field<unknown>[] }
  | { readonly kind: "metadataOnly" };

/** `build.*`, or the legacy top-level `dockerFile`/`context` normalised to the same shape. */
export interface Build {
  readonly dockerfile: Field<string> | undefined;
  readonly context: Field<string> | undefined;
  readonly target: Field<string> | undefined;
  readonly args: Field<Record<string, unknown>> | undefined;
  /** Spelled as top-level `dockerFile`/`context` rather than under `build`. */
  readonly legacy: boolean;
}

/**
 * The typed view of a devcontainer.json. Accessors return a field only when its value has
 * the expected JSON type; a wrong type is the schema rules' finding, so the rest skip it.
 */
export interface DevContainer {
  readonly doc: Document;
  readonly scenario: Scenario;
  /** Every top-level property, the last one winning on a duplicate key (as JSON does). */
  readonly properties: ReadonlyMap<string, Field<unknown>>;
  readonly build: Build | undefined;
  /** `dockerComposeFile`, always as a list. */
  readonly composeFiles: readonly Field<string>[];
  get(name: string): Field<unknown> | undefined;
  string(name: string): Field<string> | undefined;
  boolean(name: string): Field<boolean> | undefined;
  object(name: string): Field<Record<string, unknown>> | undefined;
  array(name: string): Field<unknown[]> | undefined;
}

/** Fields for each element of an array node. */
export function elements(node: Node): Field<unknown>[] {
  return node.type === "array" ? (node.children ?? []).map((n) => valueField(n, undefined)) : [];
}

/** Fields for each property of an object node, in source order, duplicates included. */
export function members(node: Node): { name: string; field: Field<unknown> }[] {
  if (node.type !== "object") return [];
  return (node.children ?? []).flatMap((property) => {
    const [key, value] = property.children ?? [];
    return key && value && typeof key.value === "string"
      ? [{ name: key.value, field: valueField(value, key) }]
      : [];
  });
}

/** The last property named `name` in an object node. */
export function member(node: Node | undefined, name: string): Field<unknown> | undefined {
  return node ? members(node).findLast((m) => m.name === name)?.field : undefined;
}

export function valueField(node: Node, key: Node | undefined): Field<unknown> {
  return { value: plain(node), node, key };
}

/**
 * The JS value of a node. Duplicate keys collapse last-wins, the way the dev container CLI
 * reads them; `syntax/duplicate-key` walks the nodes itself.
 */
function plain(node: Node): unknown {
  switch (node.type) {
    case "object":
      return Object.fromEntries(members(node).map((m) => [m.name, m.field.value]));
    case "array":
      return (node.children ?? []).map(plain);
    default:
      return node.value;
  }
}

export const isString = (f: Field<unknown> | undefined): f is Field<string> =>
  typeof f?.value === "string";
export const isObject = (f: Field<unknown> | undefined): f is Field<Record<string, unknown>> =>
  f?.node.type === "object";
export const isArray = (f: Field<unknown> | undefined): f is Field<unknown[]> =>
  f?.node.type === "array";
