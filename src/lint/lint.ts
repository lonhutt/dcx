import type { ErrorObject, ValidateFunction } from "ajv";
import * as validators from "../schema/generated/devContainer.scenarios.validator.js";
import {
  findNodeAtLocation,
  getNodeValue,
  printParseErrorCode,
  rangeOf,
  type Document,
  type Node,
} from "../jsonc/jsonc";
import type { Range } from "../position/position";

/** One problem found in a document. */
export interface Diagnostic {
  readonly range: Range;
  readonly message: string;
  /** What kind of problem this is, e.g. `schema/unknown-property`. */
  readonly rule: string;
}

type Scenario = "image" | "dockerfile" | "compose";

const SCENARIO_LABEL: Record<Scenario, string> = {
  image: "an image-based config",
  dockerfile: "a Dockerfile-based config",
  compose: "a Docker Compose config",
};

const ROOT_KEYS = new Set(validators.rootKeys);

/**
 * Lints a parsed devcontainer.json. Syntax errors come back on their own, since schema
 * errors on a tree the parser had to guess at are mostly noise.
 */
export function lint(doc: Document): Diagnostic[] {
  // the parser often reports several errors at the spot it gave up; the first says it best
  const firstAtOffset = doc.errors.filter(
    (e, i, all) => all.findIndex((o) => o.offset === e.offset) === i,
  );
  const syntax = firstAtOffset.map((e) => ({
    range: { start: e.offset, end: e.offset + e.length },
    message: sentence(printParseErrorCode(e.error)),
    rule: "syntax/parse-error",
  }));
  if (syntax.length) return syntax;
  const root = doc.root!;
  if (root.type !== "object") {
    return [{ range: rangeOf(root), message: "Expected an object", rule: "syntax/not-an-object" }];
  }
  return [...duplicateKeys(root), ...schemaErrors(root)].sort(
    (a, b) => a.range.start - b.range.start,
  );
}

function duplicateKeys(node: Node): Diagnostic[] {
  const found: Diagnostic[] = [];
  const seen = new Set<unknown>();
  for (const child of node.children ?? []) {
    const key = child.children?.[0];
    if (node.type === "object" && key) {
      if (seen.has(key.value)) {
        found.push({
          range: rangeOf(key),
          message: `Duplicate key "${key.value}"; only the last one takes effect`,
          rule: "syntax/duplicate-key",
        });
      }
      seen.add(key.value);
    }
    found.push(...duplicateKeys(child));
  }
  return found;
}

/**
 * Validates against the one scenario the config is trying to be, so a mistake isn't
 * buried under errors from every `oneOf` branch it was never meant to match.
 */
function schemaErrors(root: Node): Diagnostic[] {
  const value = getNodeValue(root);
  const scenario: Scenario =
    "dockerComposeFile" in value
      ? "compose"
      : "build" in value || "dockerFile" in value
        ? "dockerfile"
        : "image";
  const validate = (validators as unknown as Record<Scenario, ValidateFunction>)[scenario];
  if (validate(value)) return [];
  return relevant(validate.errors!, "build" in value).map((e) => translate(e, root, scenario));
}

/**
 * Drops errors that only restate another one: failed-branch summaries, the Dockerfile
 * form the config isn't using, a type error from one branch when another branch got
 * further, and "unevaluated" errors for properties that failed for a real reason.
 */
function relevant(
  errors: ErrorObject[],
  usesBuild: boolean,
): (ErrorObject & { types?: string[] })[] {
  const under = (path: string, e: ErrorObject) =>
    e.instancePath === path || e.instancePath.startsWith(path + "/");
  // the Dockerfile scenario is itself a oneOf: `build.dockerfile`, or the legacy `dockerFile`
  const otherForm = usesBuild ? "#/oneOf/1/" : "#/oneOf/0/";
  const kept = errors.filter(
    (e) =>
      e.keyword !== "oneOf" &&
      e.keyword !== "anyOf" &&
      !(e.schemaPath.startsWith(otherForm) && (e.instancePath === "" || under("/build", e))),
  );
  const unique = new Map<string, ErrorObject & { types?: string[] }>();
  for (const e of kept) {
    if (e.keyword === "type" && kept.some((o) => o.keyword !== "type" && under(e.instancePath, o)))
      continue;
    const prop = e.params.unevaluatedProperty;
    if (prop && kept.some((o) => o !== e && under(`${e.instancePath}/${prop}`, o))) continue;
    if (e.keyword === "type") {
      const id = `${e.instancePath} type`;
      const types = [unique.get(id)?.types ?? [], e.params.type].flat();
      unique.set(id, { ...e, types: [...new Set(types)] });
    } else {
      unique.set(`${e.instancePath} ${e.keyword} ${JSON.stringify(e.params)}`, e);
    }
  }
  return [...unique.values()];
}

function translate(
  e: ErrorObject & { types?: string[] },
  root: Node,
  scenario: Scenario,
): Diagnostic {
  const path = e.instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const node = nodeAt(root, path) ?? root;
  const name = path.length ? `"${path.join(".")}"` : "The config";

  const prop: string | undefined = e.params.unevaluatedProperty ?? e.params.additionalProperty;
  if (prop !== undefined) {
    const range = keyRange(nodeAt(node, [prop])) ?? keyRange(node);
    if (!path.length && ROOT_KEYS.has(prop)) {
      return {
        range,
        message: `"${prop}" doesn't apply to ${SCENARIO_LABEL[scenario]}`,
        rule: "schema/scenario-conflict",
      };
    }
    const guess = path.length ? undefined : suggest(prop, ROOT_KEYS);
    const hint = guess ? `; did you mean "${guess}"?` : "";
    return { range, message: `Unknown property "${prop}"${hint}`, rule: "schema/unknown-property" };
  }

  const range = keyRange(node);
  switch (e.keyword) {
    case "required":
      if (!path.length && e.params.missingProperty === "image") {
        return {
          range,
          message: 'Nothing to run: set "image", "build" or "dockerComposeFile"',
          rule: "schema/no-source",
        };
      }
      return {
        range,
        message: `${name} is missing required property "${e.params.missingProperty}"`,
        rule: "schema/missing-required",
      };
    case "enum":
      return {
        range: rangeOf(node),
        message: `${name} must be one of ${e.params.allowedValues.map((v: unknown) => JSON.stringify(v)).join(", ")}`,
        rule: "schema/invalid-value",
      };
    case "type": {
      const types = e.types!.join(" or ");
      return {
        range: rangeOf(node),
        message: `${name} must be ${/^[aeiou]/.test(types) ? "an" : "a"} ${types}`,
        rule: "schema/wrong-type",
      };
    }
    default:
      return { range: rangeOf(node), message: `${name} ${e.message}`, rule: `schema/${e.keyword}` };
  }
}

/** Follows JSON Pointer segments; array indexes and numeric object keys look alike in one. */
function nodeAt(node: Node | undefined, segments: string[]): Node | undefined {
  for (const s of segments)
    node = node && findNodeAtLocation(node, [node.type === "array" ? Number(s) : s]);
  return node;
}

/** The key of a property's value, or the first character of anything else. */
function keyRange(node: Node): Range;
function keyRange(node: Node | undefined): Range | undefined;
function keyRange(node: Node | undefined): Range | undefined {
  if (!node) return undefined;
  const key = node.parent?.type === "property" ? node.parent.children?.[0] : undefined;
  return key ? rangeOf(key) : { start: node.offset, end: node.offset + 1 };
}

/** The closest candidate, if it's close enough to be a likely typo rather than a guess. */
export function suggest(word: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(word.length / 5)) + 1;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return best;
}

/** Edit distance, counting a swap of neighbours as one edit; `nmae` is one typo, not two. */
function distance(a: string, b: string): number {
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        cur[j] = Math.min(cur[j]!, before[j - 2]! + 1);
    }
    [before, prev] = [prev, cur];
  }
  return prev[b.length]!;
}

/** `PropertyNameExpected` → `Property name expected`. */
const sentence = (code: string) =>
  code.replace(/(?<!^)([A-Z])/g, " $1").replace(/ [A-Z]/g, (s) => s.toLowerCase());
