import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { sha256sums } from "./release";

const SCRIPT = join(import.meta.dir, "dcx.sh");
const ASSET = `dcx-${process.platform}-${process.arch}`;
const FAKE = new TextEncoder().encode('#!/bin/sh\necho fake "$@"\n');

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dcx-sh-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Serves one fake release; `files` maps a path under the server root to its body. */
function release(files: Record<string, Uint8Array | string>) {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const body = files[new URL(req.url).pathname];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
  cleanup.push(() => server.stop(true));
  return server;
}

function good(version: string) {
  return {
    [`/v${version}/${ASSET}`]: FAKE,
    [`/v${version}/SHA256SUMS`]: sha256sums([{ name: ASSET, bytes: FAKE }]),
  };
}

async function run(env: Record<string, string>) {
  const proc = Bun.spawn(["sh", SCRIPT, "check", "a.json"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// the fake binary is a shell script, which Windows won't run as an .exe
describe.skipIf(process.platform === "win32")("dcx.sh", () => {
  test("downloads, verifies and runs the binary", async () => {
    const server = release(good("9.9.9"));
    const r = await run({
      DCX_VERSION: "9.9.9",
      DCX_RELEASE_BASE: server.url.origin,
      XDG_CACHE_HOME: tmp(),
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("fake check a.json\n");
    expect(r.code).toBe(0);
  });

  test("a cached binary runs without the network", async () => {
    const server = release(good("9.9.9"));
    const env = {
      DCX_VERSION: "9.9.9",
      DCX_RELEASE_BASE: server.url.origin,
      XDG_CACHE_HOME: tmp(),
    };
    expect((await run(env)).code).toBe(0);
    server.stop(true);
    const r = await run(env);
    expect(r.stdout).toBe("fake check a.json\n");
    expect(r.code).toBe(0);
  });

  test("a checksum mismatch exits 2 and caches nothing", async () => {
    const cache = tmp();
    const server = release({
      ...good("9.9.9"),
      "/v9.9.9/SHA256SUMS": `${"0".repeat(64)}  ${ASSET}\n`,
    });
    const r = await run({
      DCX_VERSION: "9.9.9",
      DCX_RELEASE_BASE: server.url.origin,
      XDG_CACHE_HOME: cache,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/checksum/);
    expect(readdirSync(join(cache, "dcx", "bin", "9.9.9"))).not.toContain(ASSET);
  });

  test("a missing release exits 2", async () => {
    const server = release({});
    const r = await run({
      DCX_VERSION: "9.9.9",
      DCX_RELEASE_BASE: server.url.origin,
      XDG_CACHE_HOME: tmp(),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/v9\.9\.9/);
  });

  test("an unknown platform exits 2", async () => {
    const bin = tmp();
    writeFileSync(join(bin, "uname"), '#!/bin/sh\n[ "$1" = -m ] && echo riscv64 || echo Linux\n');
    chmodSync(join(bin, "uname"), 0o755);
    const r = await run({
      PATH: `${bin}:${process.env.PATH}`,
      DCX_VERSION: "9.9.9",
      DCX_RELEASE_BASE: "http://127.0.0.1:9",
      XDG_CACHE_HOME: tmp(),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no dcx binary for linux-riscv64/);
  });

  test("without DCX_VERSION, reads package.json", async () => {
    const server = release(good(pkg.version));
    const r = await run({ DCX_RELEASE_BASE: server.url.origin, XDG_CACHE_HOME: tmp() });
    expect(r.stdout).toBe("fake check a.json\n");
    expect(r.code).toBe(0);
  });
});

// pre-commit clones with git; autocrlf on Windows would turn `set -eu` into `set -eu\r`
test("dcx.sh and the package.json it reads keep LF everywhere", async () => {
  const out = await Bun.$`git check-attr eol scripts/dcx.sh package.json`
    .cwd(join(import.meta.dir, ".."))
    .text();
  expect(out).toBe("scripts/dcx.sh: eol: lf\npackage.json: eol: lf\n");
});
