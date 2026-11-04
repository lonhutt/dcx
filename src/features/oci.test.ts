import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Fetch } from "../net/http";
import { DiskCache, MemoryCache } from "../vfs/diskcache";
import { ociResolver } from "./oci";
import { tarFile } from "./tar";

const NODE = {
  id: "node",
  version: "1.6.1",
  options: { version: { type: "string", proposals: ["lts", "20"] }, nvm: { type: "boolean" } },
};
const REF = "ghcr.io/devcontainers/features/node:1";

/** A one-file ustar archive, enough for a feature layer. */
function tar(name: string, body: string): Uint8Array {
  const data = new TextEncoder().encode(body);
  const header = new Uint8Array(512);
  const put = (s: string, at: number) => header.set(new TextEncoder().encode(s), at);
  put(name, 0);
  put("0000644\0", 100);
  put(data.length.toString(8).padStart(11, "0") + "\0", 124);
  put("0", 156);
  put("ustar\0", 257);
  const padded = new Uint8Array(512 + Math.ceil(data.length / 512) * 512 + 1024);
  padded.set(header);
  padded.set(data, 512);
  return padded;
}

/** A registry that wants an anonymous token, serving one feature; counts every request. */
function registry(opts: { annotate?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const layer = tar("./devcontainer-feature.json", JSON.stringify(NODE));
  const fetch: Fetch = async (url, init) => {
    calls.push(url);
    if (opts.status) return new Response("", { status: opts.status });
    const auth = new Headers(init?.headers).get("authorization");
    if (url.startsWith("https://ghcr.io/token")) return Response.json({ token: "t" });
    if (auth !== "Bearer t")
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:devcontainers/features/node:pull"',
        },
      });
    if (url.includes("/manifests/")) {
      if (!url.includes("/features/node/")) return new Response("", { status: 404 });
      return Response.json(
        {
          layers: [{ digest: "sha256:layer" }],
          ...(opts.annotate && {
            annotations: { "dev.containers.metadata": JSON.stringify(NODE) },
          }),
        },
        { headers: { "docker-content-digest": "sha256:manifest" } },
      );
    }
    if (url.endsWith("/blobs/sha256:layer")) return new Response(layer);
    return new Response("", { status: 404 });
  };
  return { fetch, calls };
}

const signal = () => new AbortController().signal;

test("tarFile finds a file by name, ./ or not", () => {
  const t = tar("./a.json", "{}");
  expect(new TextDecoder().decode(tarFile(t, "a.json"))).toBe("{}");
  expect(tarFile(t, "b.json")).toBeUndefined();
});

describe("ociResolver", () => {
  test("token, manifest, layer: metadata out", async () => {
    const r = registry();
    const res = await ociResolver({
      fetch: r.fetch,
      cache: new MemoryCache(),
      ttlMs: 60_000,
    }).resolve(REF, signal());
    expect(res).toEqual({ kind: "found", metadata: NODE as never });
  });

  test("the manifest annotation saves the blob fetch", async () => {
    const r = registry({ annotate: true });
    await ociResolver({ fetch: r.fetch, cache: new MemoryCache(), ttlMs: 60_000 }).resolve(
      REF,
      signal(),
    );
    expect(r.calls.some((c) => c.includes("/blobs/"))).toBe(false);
  });

  test("a cold fetch fills the cache; a warm one makes no requests", async () => {
    const cache = new MemoryCache();
    const cold = registry();
    await ociResolver({ fetch: cold.fetch, cache, ttlMs: 60_000 }).resolve(REF, signal());
    expect(cold.calls.length).toBeGreaterThan(0);
    const warm = registry();
    expect(
      await ociResolver({ fetch: warm.fetch, cache, ttlMs: 60_000 }).resolve(REF, signal()),
    ).toMatchObject({ kind: "found" });
    expect(warm.calls).toEqual([]);
  });

  test("with a TTL of 0 the tag is looked up again", async () => {
    const cache = new MemoryCache();
    await ociResolver({ fetch: registry().fetch, cache, ttlMs: 0 }).resolve(REF, signal());
    const again = registry();
    await ociResolver({ fetch: again.fetch, cache, ttlMs: 0 }).resolve(REF, signal());
    expect(again.calls.some((c) => c.includes("/manifests/1"))).toBe(true);
  });

  test("50 concurrent lookups of one feature make one set of requests", async () => {
    const r = registry();
    const resolver = ociResolver({ fetch: r.fetch, cache: new MemoryCache(), ttlMs: 60_000 });
    await Promise.all(Array.from({ length: 50 }, () => resolver.resolve(REF, signal())));
    expect(r.calls.filter((c) => c.includes("/manifests/"))).toHaveLength(2); // 401, then the real one
  });

  test("a feature the registry doesn't have is not-found", async () => {
    const r = registry();
    const res = await ociResolver({
      fetch: r.fetch,
      cache: new MemoryCache(),
      ttlMs: 60_000,
    }).resolve("ghcr.io/devcontainers/features/nope:1", signal());
    expect(res).toEqual({ kind: "not-found" });
  });

  test.each<[string, Fetch]>([
    ["a 500", async () => new Response("", { status: 500 })],
    [
      "a refused connection",
      async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    ],
    [
      "a hung request",
      (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    ],
  ])("%s is unavailable, with a reason recorded, never a throw", async (_, fetch) => {
    const resolver = ociResolver({ fetch, cache: new MemoryCache(), ttlMs: 60_000, timeoutMs: 50 });
    const res = await resolver.resolve(REF, signal());
    expect(res.kind).toBe("unavailable");
    expect(resolver.failures).toHaveLength(1);
  });

  test("aborting mid-fetch returns promptly", async () => {
    const ac = new AbortController();
    const hung: Fetch = (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    const started = performance.now();
    setTimeout(() => ac.abort(), 20);
    const res = await ociResolver({ fetch: hung, cache: new MemoryCache(), ttlMs: 60_000 }).resolve(
      REF,
      ac.signal,
    );
    expect(res.kind).toBe("unavailable");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a tarball feature, gzipped", async () => {
    const body = gzipSync(tar("devcontainer-feature.json", JSON.stringify(NODE)));
    const fetch: Fetch = async () => new Response(body);
    const res = await ociResolver({ fetch, cache: new MemoryCache(), ttlMs: 60_000 }).resolve(
      "https://example.com/f.tgz",
      signal(),
    );
    expect(res).toMatchObject({ kind: "found", metadata: { id: "node" } });
  });
});

describe("DiskCache", () => {
  const dir = mkdtempSync(join(tmpdir(), "dcx-cache-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("round-trips, expires, and keeps namespaces apart", async () => {
    let now = 1000;
    const cache = new DiskCache(dir, () => now);
    await cache.set("a", "k", { v: 1 });
    await cache.set("b", "k", { v: 2 });
    expect(await cache.get<unknown>("a", "k", 100)).toEqual({ v: 1 });
    expect(await cache.get<unknown>("b", "k")).toEqual({ v: 2 });
    now += 100;
    expect(await cache.get("a", "k", 100)).toBeUndefined();
  });

  test("concurrent writers never leave a partial file for a reader", async () => {
    const cache = new DiskCache(dir);
    const big = { blob: "x".repeat(200_000) };
    const reads: unknown[] = [];
    await Promise.all([
      ...Array.from({ length: 20 }, () => cache.set("race", "k", big)),
      ...Array.from({ length: 20 }, async () => reads.push(await cache.get("race", "k"))),
    ]);
    for (const r of reads) if (r !== undefined) expect(r).toEqual(big);
    expect(await cache.get<unknown>("race", "k")).toEqual(big);
  });
});
