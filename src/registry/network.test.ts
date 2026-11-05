import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Fetch } from "../net/http";
import { MemoryCache } from "../vfs/diskcache";
import { gallery, galleryQuery } from "./gallery";
import { openVsx } from "./openvsx";
import { Secret } from "./secret";

const signal = () => new AbortController().signal;
const opts = (fetch: Fetch) => ({ fetch, cache: new MemoryCache(), ttlMs: 60_000, timeoutMs: 200 });

// a self-hosted Open VSX, for real: only the URL differs from open-vsx.org
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname.toLowerCase();
      if (path === "/api/golang/go")
        return Response.json({ namespace: "golang", name: "Go", version: "0.46.1" });
      if (path === "/api/old/thing") return Response.json({ version: "1.0.0", deprecated: true });
      if (path === "/api/broken/server") return new Response("", { status: 500 });
      return new Response("", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

describe("openVsx", () => {
  const source = () => openVsx("ovsx", `http://localhost:${server.port}/`, opts(fetch));
  test("found, case-insensitively", async () => {
    expect(await source().lookup("GoLang", "go", signal())).toMatchObject({
      version: "0.46.1",
      deprecated: false,
      downloadable: true,
    });
  });
  test("a 404 is absent", async () => {
    expect(await source().lookup("ms-python", "vscode-pylance", signal())).toBeUndefined();
  });
  test("deprecated is passed through", async () => {
    expect(await source().lookup("old", "thing", signal())).toMatchObject({ deprecated: true });
  });
  test("a 500, a refused connection and a timeout reject, for the caller to warn about", async () => {
    await expect(source().lookup("broken", "server", signal())).rejects.toThrow("500");
    await expect(
      openVsx("x", "http://127.0.0.1:1", opts(fetch)).lookup("a", "b", signal()),
    ).rejects.toThrow();
    const hung: Fetch = (_u, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    await expect(
      openVsx("x", "https://example.com", opts(hung)).lookup("a", "b", signal()),
    ).rejects.toThrow();
  });
  test("a warm lookup makes no request", async () => {
    let calls = 0;
    const counting: Fetch = (u, i) => (calls++, fetch(u, i));
    const s = openVsx("ovsx", `http://localhost:${server.port}`, opts(counting));
    await s.lookup("golang", "go", signal());
    await s.lookup("golang", "go", signal());
    await s.lookup("ms-python", "vscode-pylance", signal());
    await s.lookup("ms-python", "vscode-pylance", signal());
    expect(calls).toBe(2);
  });
});

describe("gallery", () => {
  test("posts VS Code's query, with the token as a bearer", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fake: Fetch = async (url, init) => {
      seen = { url, init };
      return Response.json({
        results: [
          {
            extensions: [
              {
                extensionName: "vscode-pylance",
                publisher: { publisherName: "ms-python" },
                flags: "validated, public",
                versions: [{ version: "2024.1.1" }],
              },
            ],
          },
        ],
      });
    };
    const token = new Secret("hunter2-token");
    const found = await gallery(
      "ms",
      "https://marketplace.example/_apis/public/gallery",
      token,
      opts(fake),
    ).lookup("ms-python", "vscode-pylance", signal());
    expect(found).toMatchObject({ version: "2024.1.1", deprecated: false });
    expect(seen!.url).toBe("https://marketplace.example/_apis/public/gallery/extensionquery");
    expect(JSON.parse(String(seen!.init!.body))).toEqual(
      galleryQuery("ms-python", "vscode-pylance"),
    );
    expect(new Headers(seen!.init!.headers).get("authorization")).toBe("Bearer hunter2-token");
  });
  test("an empty result is absent", async () => {
    const fake: Fetch = async () => Response.json({ results: [{ extensions: [] }] });
    expect(
      await gallery("ms", "https://g.example", undefined, opts(fake)).lookup("a", "b", signal()),
    ).toBeUndefined();
  });
});

test("a Secret never prints its value", () => {
  const s = new Secret("hunter2-token");
  const outputs = [`${s}`, String(s), JSON.stringify({ s }), Bun.inspect(s), Bun.inspect({ s })];
  for (const o of outputs) expect(o).not.toContain("hunter2");
  expect(s.reveal()).toBe("hunter2-token");
});

test("nothing in the registry module does a sign-in flow", async () => {
  for (const f of ["gallery.ts", "openvsx.ts", "build.ts"]) {
    const text = await Bun.file(`${import.meta.dir}/${f}`).text();
    expect(text).not.toMatch(/oauth|device_code|authorization_code|msal/i);
  }
});
