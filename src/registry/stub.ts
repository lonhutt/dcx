import type { Extension, ExtensionSources, Source } from "./sources";

export interface StubSource {
  readonly id: string;
  readonly kind?: Source["kind"];
  readonly required?: boolean;
  /** Fails every lookup, as an unreachable source does. */
  readonly unreachable?: boolean;
  /** By `publisher.name`, any case; absent means not in this source. */
  readonly extensions: Readonly<Record<string, Partial<Extension>>>;
}

/** Map-backed extension sources, for tests and fixtures. */
export function stubSources(spec: {
  readonly sources: readonly StubSource[];
  readonly satisfy?: "all" | "any";
}): ExtensionSources {
  return {
    satisfy: spec.satisfy ?? "all",
    sources: spec.sources.map((s) => {
      const byId = new Map(Object.entries(s.extensions).map(([k, v]) => [k.toLowerCase(), v]));
      const source: Source = {
        id: s.id,
        kind: s.kind ?? "openvsx",
        requiresNetwork: (s.kind ?? "openvsx") !== "policy",
        async lookup(publisher, name) {
          if (s.unreachable) throw new Error(`${s.id} is unreachable`);
          const e = byId.get(`${publisher}.${name}`.toLowerCase());
          return (
            e && {
              version: "1.0.0",
              deprecated: false,
              downloadable: true,
              allowedVersions: undefined,
              targetPlatforms: [],
              ...e,
            }
          );
        },
      };
      return { source, required: s.required ?? false };
    }),
  };
}
