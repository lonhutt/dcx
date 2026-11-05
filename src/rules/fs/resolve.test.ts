import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskFS } from "../../vfs/diskfs";
import { MemFS } from "../../vfs/memfs";
import { inside, readInside, resolveRef } from "./resolve";

describe("inside", () => {
  test.each<[string, string, boolean]>([
    ["/work", "/work", true],
    ["/work", "/work/a/b", true],
    ["/work", "/workspace", false],
    ["/work", "/", false],
    ["/work", "/work/../etc", false],
  ])("%s contains %s: %s", (root, child, want) => {
    expect(inside(root, child)).toBe(want);
  });
});

test("readInside reads a file in the workspace and nothing outside it", async () => {
  const fs = new MemFS({ "/w/Dockerfile": "ARG A", "/etc/secret": "ARG LEAKED" });
  expect(await readInside(fs, "/w", "/w/.devcontainer", "../Dockerfile")).toBe("ARG A");
  expect(await readInside(fs, "/w", "/w/.devcontainer", "../../etc/secret")).toBeUndefined();
  expect(await readInside(fs, "/w", "/w", "nope")).toBeUndefined();
  expect(fs.calls.map((p) => p.replace(/\\/g, "/").replace(/^[A-Z]:/, ""))).not.toContain(
    "/etc/secret",
  );
});

describe("resolveRef over an in-memory workspace", () => {
  const fs = new MemFS({
    "/w/.devcontainer/devcontainer.json": "",
    "/w/Dockerfile": "",
    "/w/shared/Dockerfile": "",
  });

  test("a .devcontainer/ config and a root-level one resolve the same file", async () => {
    const nested = await resolveRef(fs, "/w", "/w/.devcontainer", "../Dockerfile");
    const root = await resolveRef(fs, "/w", "/w", "Dockerfile");
    expect(nested).toEqual(root);
    expect(nested.kind).toBe("file");
  });

  test("../../etc/passwd escapes and is never read; ../shared/Dockerfile doesn't", async () => {
    fs.calls.length = 0;
    expect((await resolveRef(fs, "/w", "/w/.devcontainer", "../../etc/passwd")).escapes).toBe(true);
    expect(fs.calls).toEqual([]);
    expect(await resolveRef(fs, "/w", "/w/.devcontainer", "../shared/Dockerfile")).toMatchObject({
      escapes: false,
      kind: "file",
    });
  });

  test("backslashes are treated as separators, as written by hand on Windows", async () => {
    expect((await resolveRef(fs, "/w", "/w/.devcontainer", "..\\Dockerfile")).kind).toBe("file");
  });
});

// real symlinks; skipped where the OS won't let an unprivileged process make them
describe("resolveRef with real symlinks", () => {
  let root: string;
  let outside: string;
  let canLink = true;
  beforeAll(() => {
    // native: the JS realpath keeps Windows 8.3 names (RUNNER~1), DiskFS.realpath expands them
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "dcx-resolve-")));
    root = join(base, "repo");
    outside = join(base, "outside");
    mkdirSync(join(root, ".devcontainer"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "Dockerfile"), "FROM x");
    writeFileSync(join(root, "Dockerfile"), "FROM x");
    try {
      symlinkSync(join(outside, "Dockerfile"), join(root, "escape"));
      symlinkSync(join(root, "Dockerfile"), join(root, "fine"));
      symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
      symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
    } catch {
      canLink = false;
    }
  });
  afterAll(() => rmSync(join(root, ".."), { recursive: true, force: true }));

  test("a symlink pointing outside the workspace is caught", async () => {
    if (!canLink) return;
    expect(
      (await resolveRef(new DiskFS(), root, join(root, ".devcontainer"), "../escape")).escapes,
    ).toBe(true);
  });

  test("a symlink inside the workspace is followed", async () => {
    if (!canLink) return;
    expect(
      await resolveRef(new DiskFS(), root, join(root, ".devcontainer"), "../fine"),
    ).toMatchObject({
      escapes: false,
      kind: "file",
      path: join(root, "Dockerfile"),
    });
  });

  test("a symlink loop is an error, not a hang", async () => {
    if (!canLink) return;
    const r = await resolveRef(new DiskFS(), root, join(root, ".devcontainer"), "../loop-a");
    expect(r.escapes).toBe(false);
    expect(r.error).toBeDefined();
  });
});
