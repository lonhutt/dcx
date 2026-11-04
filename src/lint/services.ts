import { ociResolver } from "../features/oci";
import type { AnalyzeOptions } from "./analyze";
import type { Config } from "../lintconfig/config";
import type { Fetch } from "../net/http";
import { buildSources, type Network } from "../registry/build";
import { cacheDir, DiskCache } from "../vfs/diskcache";
import type { FileSystem } from "../vfs/vfs";

/**
 * What `analyze` needs beyond the document, per config: its extension sources and, when
 * online, the feature resolver. Built once per config; `failures` collects every
 * registry or source that couldn't be reached, for the CLI to warn about.
 */
export function services(
  env: Record<string, string | undefined>,
  home: string,
  fs: FileSystem,
  fetchFn: Fetch = fetch,
) {
  const cache = new DiskCache(cacheDir(env, home));
  const failures: string[] = [];
  const network: Network = { fetch: fetchFn, cache, env, failures };
  const resolvers = new Map<number, ReturnType<typeof ociResolver>>();
  const built = new Map<Config, Promise<Partial<AnalyzeOptions>>>();

  const forConfig = (config: Config): Promise<Partial<AnalyzeOptions>> => {
    let s = built.get(config);
    if (!s) {
      s = (async () => {
        if (!config.online) return { extensions: await buildSources(config, fs) };
        const ttl = config.cacheTtl ?? 86_400_000;
        let features = resolvers.get(ttl);
        if (!features)
          resolvers.set(ttl, (features = ociResolver({ fetch: fetchFn, cache, ttlMs: ttl })));
        return { features, extensions: await buildSources(config, fs, network) };
      })();
      built.set(config, s);
    }
    return s;
  };

  return {
    forConfig,
    /** Every distinct network problem seen so far. */
    failures: () => [
      ...new Set([...failures, ...[...resolvers.values()].flatMap((r) => r.failures)]),
    ],
  };
}
