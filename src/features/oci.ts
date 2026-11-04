import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { request, Inflight, type Fetch } from "../net/http";
import type { Cache } from "../vfs/diskcache";
import { canonical } from "../model/ref";
import { parseFeatureRef } from "./ref";
import type { FeatureMetadata, FeatureResolver, Resolution } from "./resolver";
import { tarFile } from "./tar";

const MANIFEST = "application/vnd.oci.image.manifest.v1+json";
/** The devcontainers CLI copies devcontainer-feature.json into this manifest annotation. */
const METADATA_ANNOTATION = "dev.containers.metadata";

export interface ResolverOptions {
  readonly fetch: Fetch;
  readonly cache: Cache;
  /** How long a tag's resolved digest is trusted; the metadata behind a digest never changes. */
  readonly ttlMs: number;
  readonly timeoutMs?: number;
}

interface Manifest {
  readonly layers?: readonly { readonly digest: string; readonly mediaType?: string }[];
  readonly annotations?: Readonly<Record<string, string>>;
}

class Unavailable extends Error {}
class NotFound extends Error {}

/**
 * Resolves OCI and tarball feature references over the network, through the cache. A warm
 * run within the TTL makes no requests; concurrent lookups of one reference make one.
 * Every failure becomes `unavailable`, never a rejection.
 */
export function ociResolver(
  options: ResolverOptions,
): FeatureResolver & { readonly failures: readonly string[] } {
  const inflight = new Inflight<Resolution>();
  const failures: string[] = [];
  const tokens = new Map<string, string>();

  const get = async (
    url: string,
    accept: string,
    signal: AbortSignal,
    registry: string,
    repo: string,
  ) => {
    const headers = (): Record<string, string> => {
      const t = tokens.get(`${registry}/${repo}`);
      return { Accept: accept, ...(t && { Authorization: `Bearer ${t}` }) };
    };
    let res = await request(options.fetch, url, { headers: headers() }, signal, options.timeoutMs);
    if (res.status === 401) {
      await authenticate(res.headers.get("www-authenticate"), registry, repo, signal);
      res = await request(options.fetch, url, { headers: headers() }, signal, options.timeoutMs);
    }
    if (res.status === 404) throw new NotFound();
    if (!res.ok) throw new Unavailable(`${registry} answered ${res.status}`);
    return res;
  };

  /** Anonymous pull tokens, as ghcr.io and most registries hand out to anyone. */
  const authenticate = async (
    challenge: string | null,
    registry: string,
    repo: string,
    signal: AbortSignal,
  ) => {
    const params = Object.fromEntries(
      [...(challenge ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]),
    );
    if (!params.realm) throw new Unavailable(`${registry} wants credentials dcx doesn't have`);
    const url = new URL(params.realm);
    if (params.service) url.searchParams.set("service", params.service);
    url.searchParams.set("scope", params.scope ?? `repository:${repo}:pull`);
    const res = await request(options.fetch, url.toString(), {}, signal, options.timeoutMs);
    if (!res.ok) throw new Unavailable(`${registry} refused an anonymous token (${res.status})`);
    const body = (await res.json()) as { token?: string; access_token?: string };
    tokens.set(`${registry}/${repo}`, body.token ?? body.access_token ?? "");
  };

  const fromOci = async (
    registry: string,
    repo: string,
    ref: string,
    key: string,
    signal: AbortSignal,
  ): Promise<FeatureMetadata> => {
    const base = `https://${registry}/v2/${repo}`;
    let digest = await options.cache.get<string>("feature-tags", key, options.ttlMs);
    if (!digest) {
      const res = await get(`${base}/manifests/${ref}`, MANIFEST, signal, registry, repo);
      const body = await res.text();
      digest =
        res.headers.get("docker-content-digest") ??
        `sha256:${createHash("sha256").update(body).digest("hex")}`;
      const metadata = await fromManifest(
        JSON.parse(body) as Manifest,
        base,
        signal,
        registry,
        repo,
      );
      await options.cache.set("features", digest, metadata);
      await options.cache.set("feature-tags", key, digest);
      return metadata;
    }
    const cached = await options.cache.get<FeatureMetadata>("features", digest);
    if (cached) return cached;
    const res = await get(`${base}/manifests/${digest}`, MANIFEST, signal, registry, repo);
    const metadata = await fromManifest(
      (await res.json()) as Manifest,
      base,
      signal,
      registry,
      repo,
    );
    await options.cache.set("features", digest, metadata);
    return metadata;
  };

  const fromManifest = async (
    m: Manifest,
    base: string,
    signal: AbortSignal,
    registry: string,
    repo: string,
  ) => {
    const annotated = m.annotations?.[METADATA_ANNOTATION];
    if (annotated) return JSON.parse(annotated) as FeatureMetadata;
    const layer = m.layers?.[0];
    if (!layer) throw new Unavailable("the manifest has no layers");
    const res = await get(`${base}/blobs/${layer.digest}`, "*/*", signal, registry, repo);
    return metadataIn(new Uint8Array(await res.arrayBuffer()));
  };

  const fromTarball = async (url: string, signal: AbortSignal): Promise<FeatureMetadata> => {
    const cached = await options.cache.get<FeatureMetadata>("feature-tarballs", url, options.ttlMs);
    if (cached) return cached;
    const res = await request(options.fetch, url, {}, signal, options.timeoutMs);
    if (res.status === 404) throw new NotFound();
    if (!res.ok) throw new Unavailable(`${new URL(url).host} answered ${res.status}`);
    const metadata = metadataIn(new Uint8Array(await res.arrayBuffer()));
    await options.cache.set("feature-tarballs", url, metadata);
    return metadata;
  };

  return {
    failures,
    resolve(reference, signal) {
      const ref = parseFeatureRef(reference);
      if (!ref || ref.kind === "local")
        return Promise.resolve({ kind: "unavailable", reason: "not a remote feature" });
      const key = ref.kind === "oci" ? canonical(ref) : ref.url;
      return inflight.run(key, async (): Promise<Resolution> => {
        try {
          const metadata =
            ref.kind === "oci"
              ? await fromOci(
                  ref.registry!,
                  ref.repository,
                  ref.digest ?? ref.tag ?? "latest",
                  key,
                  signal,
                )
              : await fromTarball(ref.url, signal);
          return { kind: "found", metadata };
        } catch (err) {
          if (err instanceof NotFound) return { kind: "not-found" };
          const reason =
            err instanceof Unavailable
              ? err.message
              : (err as Error)?.name === "TimeoutError"
                ? "timed out"
                : String((err as Error)?.message ?? err);
          if (!signal.aborted) failures.push(`couldn't resolve feature "${reference}": ${reason}`);
          return { kind: "unavailable", reason };
        }
      });
    },
  };
}

/** devcontainer-feature.json out of a feature layer: a tar, gzipped or not. */
function metadataIn(bytes: Uint8Array): FeatureMetadata {
  const tar = bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(gunzipSync(bytes)) : bytes;
  const file = tarFile(tar, "devcontainer-feature.json");
  if (!file) throw new Unavailable("the feature has no devcontainer-feature.json");
  return JSON.parse(new TextDecoder().decode(file)) as FeatureMetadata;
}
