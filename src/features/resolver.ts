/** A feature's `devcontainer-feature.json`, as far as the network rules read it. */
export interface FeatureMetadata {
  readonly id: string;
  readonly version?: string;
  readonly deprecated?: boolean;
  readonly options?: Readonly<Record<string, FeatureOption>>;
  readonly dependsOn?: Readonly<Record<string, unknown>>;
}

export interface FeatureOption {
  readonly type?: "boolean" | "string";
  readonly enum?: readonly string[];
  readonly proposals?: readonly string[];
  readonly default?: unknown;
}

/**
 * What resolving a reference found: the metadata, proof there's no such feature, or
 * nothing either way because the registry couldn't be asked.
 */
export type Resolution =
  | { readonly kind: "found"; readonly metadata: FeatureMetadata }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Looks features up online. Never rejects: a flaky registry is a warning, not a failed run. */
export interface FeatureResolver {
  resolve(reference: string, signal: AbortSignal): Promise<Resolution>;
}

/** A resolver over fixed metadata, keyed by reference; anything else is not found. */
export function stubResolver(metadata: Readonly<Record<string, FeatureMetadata>>): FeatureResolver {
  return {
    async resolve(reference) {
      const m = metadata[reference];
      return m ? { kind: "found", metadata: m } : { kind: "not-found" };
    },
  };
}
