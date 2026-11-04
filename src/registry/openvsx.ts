import { request, type Fetch } from "../net/http";
import type { Cache } from "../vfs/diskcache";
import type { Extension, Source } from "./sources";

export const OPEN_VSX = "https://open-vsx.org";

export interface HttpSourceOptions {
  readonly fetch: Fetch;
  readonly cache: Cache;
  readonly ttlMs: number;
  readonly timeoutMs?: number;
}

interface OpenVsxExtension {
  readonly version?: string;
  readonly deprecated?: boolean;
  readonly downloadable?: boolean;
  readonly targetPlatform?: string;
  readonly allTargetPlatformVersions?: readonly { readonly targetPlatform: string }[];
}

/**
 * An Open VSX registry: `GET {base}/api/{namespace}/{name}`, unauthenticated. A
 * self-hosted instance only differs by `base`.
 */
export function openVsx(id: string, base: string, options: HttpSourceOptions): Source {
  const root = base.replace(/\/+$/, "");
  return {
    id,
    kind: "openvsx",
    requiresNetwork: true,
    async lookup(publisher, name, signal) {
      const key = `${root}/${publisher}.${name}`.toLowerCase();
      const cached = await options.cache.get<{ found: Extension | null }>(
        "openvsx",
        key,
        options.ttlMs,
      );
      if (cached) return cached.found ?? undefined;
      const res = await request(
        options.fetch,
        `${root}/api/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`,
        { headers: { Accept: "application/json" } },
        signal,
        options.timeoutMs,
      );
      if (res.status === 404) {
        await options.cache.set("openvsx", key, { found: null });
        return undefined;
      }
      if (!res.ok) throw new Error(`${new URL(root).host} answered ${res.status}`);
      const body = (await res.json()) as OpenVsxExtension;
      const found: Extension = {
        version: body.version,
        deprecated: body.deprecated ?? false,
        downloadable: body.downloadable ?? true,
        allowedVersions: undefined,
        targetPlatforms:
          body.allTargetPlatformVersions?.map((t) => t.targetPlatform) ??
          (body.targetPlatform ? [body.targetPlatform] : []),
      };
      await options.cache.set("openvsx", key, { found });
      return found;
    },
  };
}
