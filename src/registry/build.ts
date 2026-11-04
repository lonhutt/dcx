import { DEFAULT_SOURCES, type Config, type SourceConfig } from "../lintconfig/config";
import type { Fetch } from "../net/http";
import type { Cache } from "../vfs/diskcache";
import type { FileSystem } from "../vfs/vfs";
import { gallery } from "./gallery";
import { OPEN_VSX, openVsx } from "./openvsx";
import { parsePolicyFile, Policy, PolicyError, policySource } from "./policy";
import { Secret } from "./secret";
import { NO_SOURCES, type ConfiguredSource, type ExtensionSources, type Source } from "./sources";

/** What the network sources need; absent when offline. */
export interface Network {
  readonly fetch: Fetch;
  readonly cache: Cache;
  readonly env: Record<string, string | undefined>;
  /** Unreachable sources land here, for the caller to warn about. */
  readonly failures: string[];
}

/** A configured source dcx can't use: an unreadable policy file, a bad policy. Exit 2. */
export class SourceError extends Error {}

/**
 * The extension sources `config` declares. Policy sources are always built; network
 * ones only with `network`, and default to Open VSX when the config names none.
 */
export async function buildSources(
  config: Config,
  fs: FileSystem,
  network?: Network,
): Promise<ExtensionSources> {
  const declared = config.extensionSources?.length
    ? config.extensionSources
    : network
      ? DEFAULT_SOURCES
      : [];
  if (!declared.length) return NO_SOURCES;
  const sources: ConfiguredSource[] = [];
  for (const s of declared) {
    const source =
      s.kind === "policy" ? await policy(s, fs) : network && remote(s, config, network);
    if (source) sources.push({ source, required: s.required ?? false });
  }
  return { sources, satisfy: config.satisfy ?? "all" };
}

async function policy(s: SourceConfig, fs: FileSystem): Promise<Source> {
  try {
    if (s.allowed) return policySource(s.id, new Policy(Object.entries(s.allowed)));
    if (!s.path) throw new PolicyError('needs "allowed" or "path"');
    const text = await fs.readFile(s.path).catch((err: Error) => {
      throw new PolicyError(`can't read ${s.path}: ${err.message}`);
    });
    return policySource(s.id, parsePolicyFile(text));
  } catch (err) {
    if (err instanceof PolicyError)
      throw new SourceError(`extension source "${s.id}": ${err.message}`);
    throw err;
  }
}

function remote(s: SourceConfig, config: Config, network: Network): Source {
  const options = {
    fetch: network.fetch,
    cache: network.cache,
    ttlMs: config.cacheTtl ?? 86_400_000,
  };
  if (s.kind === "vscode-gallery" && !s.url)
    throw new SourceError(`extension source "${s.id}": a vscode-gallery source needs "url"`);
  const raw = s.tokenEnv ? network.env[s.tokenEnv] : undefined;
  const token = raw ? new Secret(raw) : undefined;
  const source =
    s.kind === "openvsx"
      ? openVsx(s.id, s.url ?? OPEN_VSX, options)
      : gallery(s.id, s.url ?? "", token, options);
  return {
    ...source,
    // an unreachable source (often a VPN-only gallery) is a warning, never a failed run
    async lookup(publisher, name, signal) {
      try {
        return await source.lookup(publisher, name, signal);
      } catch (err) {
        if (!signal.aborted)
          network.failures.push(
            `extension source "${s.id}" is unreachable: ${(err as Error).message}`,
          );
        throw err;
      }
    },
  };
}
