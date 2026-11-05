import type { ErrorObject, ValidateFunction } from "ajv";
import { dirname, resolve } from "node:path";
import { isMap, isSeq, parseDocument, type Document as YamlDocument } from "yaml";
import type { Diagnostic } from "../diagnostic/diagnostic";
import type { Range } from "../position/position";
import { validate as generated } from "../schema/generated/dcxConfig.validator.js";
import type { FileSystem } from "../vfs/vfs";
import type { Config, Layer, SourceConfig } from "./config";

/** A config file that can't be used; carries findings with spans into that file. */
export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly text: string,
    readonly diagnostics: readonly Diagnostic[],
  ) {
    super(`${path}: ${diagnostics.map((d) => d.message).join("; ")}`);
  }
}

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// tokens people paste by mistake; an env var is named, never one of these
const validate = generated as unknown as ValidateFunction;

const TOKEN_PREFIXES = [
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "xox",
  "sk-",
  "akia",
];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads and validates a config file for `layer`. YAML and JSON both go through the YAML
 * parser, which is a superset of JSON. Throws {@link ConfigError} for anything wrong.
 */
export async function load(fs: FileSystem, path: string, layer: Layer): Promise<Config> {
  const text = await fs.readFile(path);
  return parseConfig(path, text, layer);
}

export function parseConfig(path: string, text: string, layer: Layer): Config {
  const yaml = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  const fail = (range: Range, message: string, help?: string): never => {
    throw new ConfigError(path, text, [
      { ruleId: "config/invalid", severity: "error", range, message, ...(help && { help }) },
    ]);
  };
  for (const e of yaml.errors) fail({ start: e.pos[0], end: e.pos[1] }, e.message.split("\n")[0]!);

  // a file of only comments parses to null; that's an empty config, not an error
  const value = (yaml.toJS() ?? {}) as Record<string, unknown>;
  if (!validate(value)) {
    // propertyNames reports itself and, again, the inner error that failed the name
    const errors = (validate.errors ?? []).filter(
      (e) => !("propertyName" in e) || e.keyword === "propertyNames",
    );
    throw new ConfigError(
      path,
      text,
      errors.map((e) => ({
        ruleId: "config/invalid",
        severity: "error" as const,
        range: spanOf(yaml, e, text),
        message: describe(e),
      })),
    );
  }

  const sources = value["extension-sources"] as Record<string, unknown>[] | undefined;
  sources?.forEach((s, i) => {
    const env = s["token-env"];
    if (typeof env === "string" && !looksLikeEnvName(env)) {
      fail(
        nodeRange(yaml, ["extension-sources", i, "token-env"], text),
        `"token-env" must name an environment variable, and "${redact(env)}" looks like a token`,
        "put the token in an environment variable and give its name here; a committed file must never hold a credential",
      );
    }
    if (layer === "user" && s.required !== undefined) {
      fail(
        nodeRange(yaml, ["extension-sources", i, "required"], text),
        '"required" can only be set in the project config',
        "which sources a repo must support is the project's call; a user config can add sources, not weaken that",
      );
    }
  });
  const extensions = value.extensions as Record<string, unknown> | undefined;
  if (layer === "user" && extensions?.satisfy !== undefined) {
    fail(
      nodeRange(yaml, ["extensions", "satisfy"], text),
      '"extensions.satisfy" can only be set in the project config',
    );
  }
  return toConfig(value, dirname(path));
}

function looksLikeEnvName(name: string): boolean {
  const lower = name.toLowerCase();
  return IDENTIFIER.test(name) && !TOKEN_PREFIXES.some((p) => lower.startsWith(p));
}

const redact = (s: string) => (s.length > 8 ? `${s.slice(0, 4)}…` : s);

function toConfig(v: Record<string, unknown>, base: string): Config {
  const features = v.features as Record<string, unknown> | undefined;
  const ttl = features?.["cache-ttl"] as string | undefined;
  const sources = v["extension-sources"] as Record<string, unknown>[] | undefined;
  return {
    failOn: v["fail-on"] as Config["failOn"],
    online: v.online as boolean | undefined,
    rules: v.rules as Config["rules"],
    categories: v.categories as Config["categories"],
    exclude: v.exclude as string[] | undefined,
    allowUnpinned: features?.["allow-unpinned"] as string[] | undefined,
    cacheTtl: ttl ? Number(ttl.slice(0, -1)) * UNITS[ttl.at(-1) as keyof typeof UNITS] : undefined,
    extensionSources: sources?.map((s): SourceConfig => ({
      id: s.id as string,
      kind: s.kind as SourceConfig["kind"],
      ...(s.url !== undefined && { url: s.url as string }),
      // resolved here: once layers merge, nothing knows which file a path came from
      ...(s.path !== undefined && { path: resolve(base, s.path as string) }),
      ...(s.allowed !== undefined && { allowed: s.allowed as Record<string, unknown> }),
      ...(s["token-env"] !== undefined && { tokenEnv: s["token-env"] as string }),
      ...(s.required !== undefined && { required: s.required as boolean }),
    })),
    satisfy: (v.extensions as Record<string, unknown> | undefined)?.satisfy as Config["satisfy"],
    base,
  };
}

const segments = (pointer: string) =>
  pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

function describe(e: ErrorObject): string {
  const where = e.instancePath ? `"${segments(e.instancePath).join(".")}"` : "The config";
  switch (e.keyword) {
    case "additionalProperties":
      return `${where} has unknown setting "${e.params.additionalProperty}"`;
    case "enum":
      return `${where} must be one of ${(e.params.allowedValues as unknown[]).map((x) => JSON.stringify(x)).join(", ")}`;
    case "type":
      return `${where} must be ${/^[aeiou]/.test(e.params.type) ? "an" : "a"} ${e.params.type}`;
    case "required":
      return `${where} is missing "${e.params.missingProperty}"`;
    case "const":
      return `${where} must be ${JSON.stringify(e.params.allowedValue)}`;
    case "propertyNames":
      return `${where} has an invalid key "${e.params.propertyName}"`;
    default:
      return `${where} ${e.message}`;
  }
}

function spanOf(yaml: YamlDocument, e: ErrorObject, text: string): Range {
  const path = segments(e.instancePath);
  const key = e.params.additionalProperty ?? e.params.propertyName;
  return nodeRange(yaml, key !== undefined ? [...path, key] : path, text, key !== undefined);
}

/** The span of the node at `path`, or of its key; the whole document as a last resort. */
function nodeRange(
  yaml: YamlDocument,
  path: (string | number)[],
  text: string,
  keyOnly = false,
): Range {
  let node: unknown = yaml.contents;
  let keyNode: unknown;
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => (p.key as { value?: unknown })?.value === seg);
      keyNode = pair?.key;
      node = pair?.value;
    } else if (isSeq(node)) {
      keyNode = undefined;
      node = node.items[Number(seg)];
    } else {
      node = undefined;
    }
    if (node === undefined && keyNode === undefined) break;
  }
  const range = ((keyOnly ? keyNode : (node ?? keyNode)) as { range?: [number, number] })?.range;
  return range ? { start: range[0], end: range[1] } : { start: 0, end: Math.min(1, text.length) };
}
