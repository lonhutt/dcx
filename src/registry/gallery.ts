import { request } from "../net/http";
import type { HttpSourceOptions } from "./openvsx";
import type { Secret } from "./secret";
import type { Extension, Source } from "./sources";

/** The query VS Code itself sends: one extension by name, with its versions. */
export function galleryQuery(publisher: string, name: string): unknown {
  return {
    filters: [
      {
        criteria: [{ filterType: 7, value: `${publisher}.${name}` }],
        pageNumber: 1,
        pageSize: 1,
        sortBy: 0,
        sortOrder: 0,
      },
    ],
    assetTypes: [],
    // IncludeVersions | IncludeFiles | IncludeVersionProperties | ExcludeNonValidated | IncludeLatestVersionOnly
    flags: 0x1 | 0x2 | 0x10 | 0x20 | 0x200,
  };
}

interface GalleryResponse {
  readonly results?: readonly {
    readonly extensions?: readonly {
      readonly extensionName: string;
      readonly publisher: { readonly publisherName: string };
      readonly flags?: string;
      readonly versions?: readonly { readonly version: string; readonly targetPlatform?: string }[];
    }[];
  }[];
}

/**
 * A VS Code gallery: `POST {serviceUrl}/extensionquery`. The Microsoft Marketplace, a
 * Private Marketplace container, or anything speaking the protocol. A token, if any, is
 * sent as a bearer token; there's no sign-in flow, by design.
 */
export function gallery(
  id: string,
  serviceUrl: string,
  token: Secret | undefined,
  options: HttpSourceOptions,
): Source {
  const root = serviceUrl.replace(/\/+$/, "");
  return {
    id,
    kind: "vscode-gallery",
    requiresNetwork: true,
    async lookup(publisher, name, signal) {
      const key = `${root}/${publisher}.${name}`.toLowerCase();
      const cached = await options.cache.get<{ found: Extension | null }>(
        "gallery",
        key,
        options.ttlMs,
      );
      if (cached) return cached.found ?? undefined;
      const res = await request(
        options.fetch,
        `${root}/extensionquery`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json;api-version=3.0-preview.1",
            ...(token && { Authorization: `Bearer ${token.reveal()}` }),
          },
          body: JSON.stringify(galleryQuery(publisher, name)),
        },
        signal,
        options.timeoutMs,
      );
      if (!res.ok) throw new Error(`${new URL(root).host} answered ${res.status}`);
      const body = (await res.json()) as GalleryResponse;
      const ext = body.results?.[0]?.extensions?.find(
        (e) =>
          `${e.publisher.publisherName}.${e.extensionName}`.toLowerCase() ===
          `${publisher}.${name}`.toLowerCase(),
      );
      const found: Extension | null = ext
        ? {
            version: ext.versions?.[0]?.version,
            deprecated: /\bdeprecated\b/i.test(ext.flags ?? ""),
            downloadable: !/\bunpublished\b/i.test(ext.flags ?? ""),
            allowedVersions: undefined,
            targetPlatforms: [
              ...new Set(
                (ext.versions ?? []).flatMap((v) => (v.targetPlatform ? [v.targetPlatform] : [])),
              ),
            ],
          }
        : null;
      await options.cache.set("gallery", key, { found });
      return found ?? undefined;
    },
  };
}
