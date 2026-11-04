import type { Document } from "../jsonc/jsonc";
import {
  elements,
  isArray,
  isObject,
  isString,
  member,
  members,
  type Build,
  type DevContainer,
  type Field,
  type Scenario,
} from "./model";

const EMPTY = new Map<string, Field<unknown>>();

/** Builds the typed model over a parsed document. Never throws, whatever the document. */
export function lower(doc: Document): DevContainer {
  const root = doc.root?.type === "object" ? doc.root : undefined;
  const properties = root ? new Map(members(root).map((m) => [m.name, m.field] as const)) : EMPTY;
  const get = (name: string) => properties.get(name);
  const build = lowerBuild(get);
  const compose = get("dockerComposeFile");
  const composeFiles = isString(compose)
    ? [compose]
    : isArray(compose)
      ? elements(compose.node).filter(isString)
      : [];

  return Object.freeze({
    doc,
    scenario: discriminate(root ? properties : undefined, build, composeFiles),
    properties,
    build,
    composeFiles,
    get,
    string: (name: string) => {
      const f = get(name);
      return isString(f) ? f : undefined;
    },
    boolean: (name: string) => {
      const f = get(name);
      return typeof f?.value === "boolean" ? (f as Field<boolean>) : undefined;
    },
    object: (name: string) => {
      const f = get(name);
      return isObject(f) ? f : undefined;
    },
    array: (name: string) => {
      const f = get(name);
      return isArray(f) ? f : undefined;
    },
  });
}

function lowerBuild(get: (name: string) => Field<unknown> | undefined): Build | undefined {
  const build = get("build");
  if (isObject(build)) {
    const str = (name: string) => {
      const f = member(build.node, name);
      return isString(f) ? f : undefined;
    };
    const args = member(build.node, "args");
    return {
      dockerfile: str("dockerfile"),
      context: str("context"),
      target: str("target"),
      args: isObject(args) ? args : undefined,
      legacy: false,
    };
  }
  const dockerFile = get("dockerFile");
  if (dockerFile === undefined) return undefined;
  const context = get("context");
  return {
    dockerfile: isString(dockerFile) ? dockerFile : undefined,
    context: isString(context) ? context : undefined,
    target: undefined,
    args: undefined,
    legacy: true,
  };
}

/**
 * Decides the scenario from which container sources are present: `image`, a Dockerfile
 * (`build.dockerfile` or legacy `dockerFile`), or `dockerComposeFile`. More than one is
 * `ambiguous`, carrying every source so a rule can name each of them.
 */
function discriminate(
  properties: ReadonlyMap<string, Field<unknown>> | undefined,
  build: Build | undefined,
  composeFiles: readonly Field<string>[],
): Scenario {
  if (!properties) return { kind: "unknown" };
  const image = properties.get("image");
  const compose = properties.get("dockerComposeFile");
  const sources = [image, build?.dockerfile, compose].filter((f) => f !== undefined);
  if (sources.length > 1) return { kind: "ambiguous", sources };
  if (isString(image)) return { kind: "image", image };
  if (build?.dockerfile)
    return { kind: "dockerfile", dockerfile: build.dockerfile, legacy: build.legacy };
  if (compose) {
    const service = properties.get("service");
    return {
      kind: "compose",
      files: composeFiles,
      service: isString(service) ? service : undefined,
    };
  }
  // a mistyped source (`"image": 1`) is neither a source nor proof there isn't one; the
  // schema rules report the type, and no-container-source checks for the keys itself
  if (image) return { kind: "unknown" };
  return properties.size ? { kind: "metadataOnly" } : { kind: "unknown" };
}
