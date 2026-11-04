import type { Config, SourceConfig } from "./config";

/**
 * Lays `over` on top of `base`. Scalars take `over`'s value unless it said nothing
 * (`??`, never `||`: `false` is an answer). Rule and category maps merge key by key; list
 * settings accumulate; extension sources merge by ID, the later definition winning.
 */
export function merge(base: Config, over: Config): Config {
  return {
    failOn: over.failOn ?? base.failOn,
    maxSeverity: over.maxSeverity ?? base.maxSeverity,
    online: over.online ?? base.online,
    rules: over.rules || base.rules ? { ...base.rules, ...over.rules } : undefined,
    categories:
      over.categories || base.categories ? { ...base.categories, ...over.categories } : undefined,
    exclude: concat(base.exclude, over.exclude),
    allowUnpinned: concat(base.allowUnpinned, over.allowUnpinned),
    cacheTtl: over.cacheTtl ?? base.cacheTtl,
    extensionSources: mergeSources(base.extensionSources, over.extensionSources),
    satisfy: over.satisfy ?? base.satisfy,
    base: over.base ?? base.base,
  };
}

function concat<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] | undefined {
  return a || b ? [...(a ?? []), ...(b ?? [])] : undefined;
}

function mergeSources(
  a: readonly SourceConfig[] | undefined,
  b: readonly SourceConfig[] | undefined,
): SourceConfig[] | undefined {
  if (!a && !b) return undefined;
  const byId = new Map<string, SourceConfig>();
  for (const s of [...(a ?? []), ...(b ?? [])]) {
    const previous = byId.get(s.id);
    // `required` survives a redefinition that doesn't mention it
    byId.set(s.id, {
      ...s,
      ...(previous?.required !== undefined &&
        s.required === undefined && { required: previous.required }),
    });
  }
  return [...byId.values()];
}

/** The environment layer: `DCX_ONLINE` and `DCX_FAIL_ON`. */
export function fromEnv(env: Record<string, string | undefined>): Config {
  const online = env.DCX_ONLINE?.toLowerCase();
  const failOn = env.DCX_FAIL_ON;
  return {
    ...(online !== undefined && online !== "" && { online: online === "1" || online === "true" }),
    ...((failOn === "error" || failOn === "warning" || failOn === "info") && { failOn }),
  };
}
