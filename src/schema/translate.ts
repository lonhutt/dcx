import type { ErrorObject, ValidateFunction } from "ajv";
import {
  compose,
  definitionKeys,
  dockerfile,
  image,
  rootKeys,
} from "./generated/devContainer.scenarios.validator.js";
import { findNodeAtLocation, rangeOf, type Node } from "../jsonc/jsonc";
import type { DevContainer } from "../model/model";
import type { Range } from "../position/position";
import { docsUrl } from "./docs-url";
import { suggest } from "./suggest";

/** Which schema rule a translated error belongs to. */
export type ErrorClass =
  "unknown-property" | "type-mismatch" | "invalid-enum" | "missing-required" | "other";

/** A schema error rewritten as prose, with the span it's about; rules add ID and severity. */
export interface TranslatedError {
  readonly class: ErrorClass;
  readonly node: Node | undefined;
  readonly range: Range;
  readonly message: string;
  readonly help?: string;
  readonly docsUrl: string;
  /** For an unknown property; absent when no candidate is close enough. */
  readonly suggestion?: string;
}

type Validator = "image" | "dockerfile" | "compose";

const LABEL: Record<Validator, string> = {
  image: "an image-based config",
  dockerfile: "a Dockerfile-based config",
  compose: "a Docker Compose config",
};

const VALIDATORS = { image, dockerfile, compose } as unknown as Record<Validator, ValidateFunction>;
const ROOT_KEYS = new Set(rootKeys);
const SOURCE_KEYS = new Set(["image", "build", "dockerFile", "dockerComposeFile"]);
const NON_COMPOSE_ONLY = new Set(
  definitionKeys.nonCompose.filter((k) => !definitionKeys.compose.includes(k)),
);
/** Root keys the deprecation rules report instead. */
const DEPRECATED_ROOT = new Set(["extensions", "settings"]);

/**
 * Which scenario's validator to run. Keyed off which source properties are present at
 * all, not whether they're well-formed: a `build` with a typo'd `dockerfile` should be
 * validated as a Dockerfile config, so the error says what `build` is missing.
 */
function validatorFor(model: DevContainer): Validator {
  if (model.properties.has("dockerComposeFile")) return "compose";
  if (model.properties.has("build") || model.properties.has("dockerFile")) return "dockerfile";
  return "image";
}

/**
 * Validates the document against the one scenario it's trying to be, and translates what
 * fails. Errors the scenario and deprecation rules report better (no source, a second
 * source, a property Compose ignores, a missing `service`) are left to them.
 */
export function schemaErrors(model: DevContainer): TranslatedError[] {
  const root = model.doc.root;
  if (root?.type !== "object") return [];
  const scenario = validatorFor(model);
  const validate = VALIDATORS[scenario];
  const value = Object.fromEntries([...model.properties].map(([k, f]) => [k, f.value]));
  if (validate(value)) return [];
  return relevant(validate.errors!, model.properties.has("build"))
    .filter((e) => !ownedElsewhere(e, scenario, model))
    .map((e) => translate(e, root, scenario));
}

function ownedElsewhere(e: ErrorObject, scenario: Validator, model: DevContainer): boolean {
  if (e.instancePath !== "") {
    // shutdownAction's values swap between scenarios: scenario/shutdown-action-mismatch
    const other = scenario === "compose" ? "stopContainer" : "stopCompose";
    return (
      e.instancePath === "/shutdownAction" &&
      e.keyword === "enum" &&
      model.get("shutdownAction")?.value === other
    );
  }
  const prop: unknown = e.params.unevaluatedProperty ?? e.params.additionalProperty;
  if (typeof prop === "string") {
    if (SOURCE_KEYS.has(prop)) return true; // scenario/conflicting-source
    if (scenario === "compose" && NON_COMPOSE_ONLY.has(prop)) return true; // scenario/non-compose-property
    return DEPRECATED_ROOT.has(prop);
  }
  if (e.keyword === "required") {
    const missing = e.params.missingProperty;
    if (scenario === "compose") return missing === "service" || missing === "workspaceFolder";
    // scenario/no-container-source, unless a source is present but mistyped
    return missing === "image" && ![...SOURCE_KEYS].some((k) => model.properties.has(k));
  }
  return false;
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
    const deeper = (o: ErrorObject) =>
      under(e.instancePath, o) && (o.keyword !== "type" || o.instancePath !== e.instancePath);
    if (e.keyword === "type" && kept.some(deeper)) continue;
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

/** Builds the message from `params`, never Ajv's own `message`, which may change. */
function translate(
  e: ErrorObject & { types?: string[] },
  root: Node,
  scenario: Validator,
): TranslatedError {
  const path = e.instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const node = nodeAt(root, path) ?? root;
  const name = path.length ? `"${path.join(".")}"` : "The config";

  const prop: string | undefined = e.params.unevaluatedProperty ?? e.params.additionalProperty;
  if (prop !== undefined) {
    const target = nodeAt(node, [prop]);
    const range = keyRange(target) ?? keyRange(node);
    const url = docsUrl([...path, prop]);
    if (!path.length && ROOT_KEYS.has(prop)) {
      return {
        class: "unknown-property",
        node: target,
        range,
        message: `"${prop}" doesn't apply to ${LABEL[scenario]}`,
        help: `remove "${prop}"`,
        docsUrl: url,
      };
    }
    const suggestion = path.length ? undefined : suggest(prop, ROOT_KEYS);
    return {
      class: "unknown-property",
      node: target,
      range,
      message: `Unknown property "${prop}"${suggestion ? `; did you mean "${suggestion}"?` : ""}`,
      ...(suggestion && { help: `rename it to "${suggestion}"`, suggestion }),
      docsUrl: url,
    };
  }

  const base = { node, docsUrl: docsUrl(path) };
  switch (e.keyword) {
    case "required":
      return {
        ...base,
        class: "missing-required",
        range: keyRange(node),
        message: `${name} is missing required property "${e.params.missingProperty}"`,
      };
    case "enum": {
      const allowed = (e.params.allowedValues as unknown[]).map((v) => JSON.stringify(v));
      return {
        ...base,
        class: "invalid-enum",
        range: rangeOf(node),
        message: `${name} must be one of ${allowed.join(", ")}`,
      };
    }
    case "type": {
      const types = e.types!.join(" or ");
      return {
        ...base,
        class: "type-mismatch",
        range: rangeOf(node),
        message: `${name} must be ${/^[aeiou]/.test(types) ? "an" : "a"} ${types}`,
      };
    }
    default:
      return { ...base, class: "other", range: rangeOf(node), message: `${name} ${e.message}` };
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
