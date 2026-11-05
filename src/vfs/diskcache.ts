import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A JSON cache in namespaces; a miss, an expired entry and a corrupt file all read as undefined. */
export interface Cache {
  get<T>(namespace: string, key: string, ttlMs?: number): Promise<T | undefined>;
  set(namespace: string, key: string, value: unknown): Promise<void>;
}

interface Entry {
  readonly stored: number;
  readonly value: unknown;
}

/** Under `$XDG_CACHE_HOME/dcx`, falling back to `~/.cache/dcx`. */
export function cacheDir(env: Record<string, string | undefined>, home: string): string {
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "dcx");
}

/**
 * A cache on disk, one file per key. Writes go to a temp file in the same directory and
 * are renamed into place, so a reader (or a second dcx) never sees half a file.
 */
export class DiskCache implements Cache {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private path(namespace: string, key: string) {
    return join(
      this.dir,
      namespace,
      createHash("sha256").update(key).digest("hex").slice(0, 32) + ".json",
    );
  }

  async get<T>(namespace: string, key: string, ttlMs?: number): Promise<T | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.path(namespace, key), "utf8")) as Entry;
      if (ttlMs !== undefined && this.now() - entry.stored >= ttlMs) return undefined;
      return entry.value as T;
    } catch {
      return undefined;
    }
  }

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    const path = this.path(namespace, key);
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await mkdir(join(this.dir, namespace), { recursive: true });
      await writeFile(tmp, JSON.stringify({ stored: this.now(), value } satisfies Entry));
      await rename(tmp, path);
    } catch {
      // a cache that can't be written is just a slower run
    }
  }
}

/** An in-memory {@link Cache}, for tests and the LSP's warm process. */
export class MemoryCache implements Cache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(namespace: string, key: string, ttlMs?: number): Promise<T | undefined> {
    const e = this.entries.get(`${namespace}\0${key}`);
    if (!e || (ttlMs !== undefined && this.now() - e.stored >= ttlMs)) return undefined;
    return e.value as T;
  }

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    this.entries.set(`${namespace}\0${key}`, {
      stored: this.now(),
      value: JSON.parse(JSON.stringify(value)),
    });
  }
}
