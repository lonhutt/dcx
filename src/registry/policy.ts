import { members } from "../model/model";
import { parse } from "../jsonc/jsonc";
import type { Extension, Source } from "./sources";

/** What an `extensions.allowed` entry says: allowed, denied, stable releases only, or these versions. */
export type PolicyValue = boolean | "stable" | readonly string[];

export interface Verdict {
  readonly allowed: boolean;
  /** Pinned versions, platform suffix (`@win32-x64`) stripped; undefined when unconstrained. */
  readonly versions?: readonly string[];
  readonly stableOnly?: boolean;
  /** The policy key that decided it. */
  readonly by: string;
}

export class PolicyError extends Error {}

/**
 * VS Code's `extensions.allowed`: keys are `*`, a publisher, or `publisher.name`, and the
 * most specific one that matches decides. Specificity is computed, never taken from key
 * order. With any policy set, an extension nothing matches is denied.
 */
export class Policy {
  private readonly entries = new Map<string, PolicyValue>();

  constructor(entries: Iterable<[string, unknown]>) {
    const seen = new Map<string, string>();
    for (const [rawKey, value] of entries) {
      const key = rawKey.toLowerCase();
      const v = asValue(rawKey, value);
      const previous = seen.get(key);
      if (previous !== undefined && JSON.stringify(this.entries.get(key)) !== JSON.stringify(v))
        throw new PolicyError(
          `"${rawKey}" is in the policy twice with different values (also as "${previous}")`,
        );
      seen.set(key, rawKey);
      this.entries.set(key, v);
    }
  }

  lookup(publisher: string, name: string): Verdict {
    const id = `${publisher}.${name}`.toLowerCase();
    for (const key of [id, publisher.toLowerCase(), "*"]) {
      const v = this.entries.get(key);
      if (v === undefined) continue;
      if (typeof v === "boolean") return { allowed: v, by: key };
      if (v === "stable") return { allowed: true, stableOnly: true, by: key };
      return { allowed: true, versions: v.map((s) => s.split("@")[0]!), by: key };
    }
    return { allowed: this.entries.size === 0, by: "" };
  }
}

function asValue(key: string, value: unknown): PolicyValue {
  if (typeof value === "boolean" || value === "stable") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    if (!key.includes("."))
      throw new PolicyError(`"${key}": only a single extension can pin versions, not a publisher`);
    return value;
  }
  throw new PolicyError(`"${key}" must be true, false, "stable", or a list of versions`);
}

/**
 * A policy from a file: either the bare `extensions.allowed` object, or a settings.json
 * holding one. Parsed as JSONC through the CST, so a key given twice is caught rather
 * than silently last-wins.
 */
export function parsePolicyFile(text: string): Policy {
  const doc = parse("policy", text);
  if (doc.errors.length || doc.root?.type !== "object")
    throw new PolicyError("isn't a JSON object");
  const nested = members(doc.root).findLast((m) => m.name === "extensions.allowed");
  const node = nested ? nested.field.node : doc.root;
  if (node.type !== "object") throw new PolicyError('"extensions.allowed" must be an object');
  return new Policy(members(node).map((m) => [m.name, m.field.value] as [string, unknown]));
}

/** A policy as an extension {@link Source}: offline, and `undefined` for a denied extension. */
export function policySource(id: string, policy: Policy): Source & { readonly policy: Policy } {
  return {
    id,
    kind: "policy",
    requiresNetwork: false,
    policy,
    async lookup(publisher, name): Promise<Extension | undefined> {
      const v = policy.lookup(publisher, name);
      if (!v.allowed) return undefined;
      return {
        version: undefined,
        deprecated: false,
        downloadable: true,
        allowedVersions: v.versions,
        targetPlatforms: [],
      };
    },
  };
}
