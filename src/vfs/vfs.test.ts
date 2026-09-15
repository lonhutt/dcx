import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFS } from "./bunfs";
import { OverlayFS } from "./overlayfs";
import type { FileSystem } from "./vfs";

// <root>/hello.txt, <root>/B.txt, <root>/_under.txt, <root>/sub/nested.txt,
// <root>/link -> sub, <root>/dangling -> (nothing), <root>/locked/ (mode 000).
// The mixed-case names pin codepoint ordering; the dangling symlink and the
// unreadable directory pin the difference between absence and a real failure.
let root: string;
// chmod cannot lock a directory against root, so the EACCES cases cannot run there.
const canDenyAccess = process.getuid?.() !== 0;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dcx-vfs-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "hello.txt"), "café ☕\n");
  writeFileSync(join(root, "B.txt"), "B\n");
  writeFileSync(join(root, "_under.txt"), "_\n");
  writeFileSync(join(root, "sub", "nested.txt"), "nested\n");
  symlinkSync(join(root, "sub"), join(root, "link"));
  symlinkSync(join(root, "nowhere"), join(root, "dangling"));
  mkdirSync(join(root, "locked"));
  writeFileSync(join(root, "locked", "secret.txt"), "secret\n");
  chmodSync(join(root, "locked"), 0o000);
});
afterAll(() => {
  chmodSync(join(root, "locked"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

// The FileSystem contract. An OverlayFS with no buffers must be indistinguishable from its base.
describe.each<[string, () => FileSystem]>([
  ["BunFS", () => new BunFS()],
  ["OverlayFS with no buffers", () => new OverlayFS(new BunFS())],
])("%s", (_, create) => {
  const fs = create();

  test("readFile decodes UTF-8", async () => {
    expect(await fs.readFile(join(root, "hello.txt"))).toBe("café ☕\n");
  });

  test("readFile rejects for a missing file", async () => {
    await expect(fs.readFile(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("stat reports files and directories, following symlinks", async () => {
    expect((await fs.stat(join(root, "hello.txt")))?.kind).toBe("file");
    expect((await fs.stat(join(root, "sub")))?.kind).toBe("directory");
    expect((await fs.stat(join(root, "link")))?.kind).toBe("directory");
  });

  test("stat resolves undefined for a missing path, even beneath a file", async () => {
    expect(await fs.stat(join(root, "missing"))).toBeUndefined();
    expect(await fs.stat(join(root, "hello.txt", "child"))).toBeUndefined();
    expect(await fs.stat(join(root, "dangling"))).toBeUndefined();
  });

  test.if(canDenyAccess)("stat rejects when the path exists but cannot be read", async () => {
    // Absence is a result; a permission failure is not, or fs/* rules report
    // "does not exist" for a path that does.
    await expect(fs.stat(join(root, "locked", "secret.txt"))).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  test("readDir lists entries in codepoint order, following symlinks", async () => {
    expect(await fs.readDir(root)).toEqual([
      { name: "B.txt", kind: "file" },
      { name: "_under.txt", kind: "file" },
      { name: "dangling", kind: "other" },
      { name: "hello.txt", kind: "file" },
      { name: "link", kind: "directory" },
      { name: "locked", kind: "directory" },
      { name: "sub", kind: "directory" },
    ]);
  });

  test("readDir rejects for a missing directory", async () => {
    await expect(fs.readDir(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.if(canDenyAccess)("readDir rejects for an unreadable directory", async () => {
    await expect(fs.readDir(join(root, "locked"))).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("OverlayFS", () => {
  let fs: OverlayFS;
  beforeEach(() => {
    fs = new OverlayFS(new BunFS());
  });

  test("a buffer shadows the file on disk", async () => {
    fs.set(join(root, "hello.txt"), "unsaved");
    expect(await fs.readFile(join(root, "hello.txt"))).toBe("unsaved");
  });

  test("a buffer with no file on disk reads and stats as a file", async () => {
    const path = join(root, "sub", "new.json");
    fs.set(path, "{}");
    expect(await fs.readFile(path)).toBe("{}");
    expect((await fs.stat(path))?.kind).toBe("file");
  });

  test("an empty buffer shadows the file on disk", async () => {
    // "" is falsy: a truthiness check here serves the stale disk contents instead.
    fs.set(join(root, "hello.txt"), "");
    expect(await fs.readFile(join(root, "hello.txt"))).toBe("");
  });

  test("an empty buffer with no file on disk reads as empty", async () => {
    const path = join(root, "sub", "blank.json");
    fs.set(path, "");
    expect(await fs.readFile(path)).toBe("");
    expect((await fs.stat(path))?.kind).toBe("file");
  });

  test("readDir merges buffers into their own directory only, once each", async () => {
    fs.set(join(root, "sub", "new.json"), "{}");
    fs.set(join(root, "sub", "nested.txt"), "changed");
    expect(await fs.readDir(join(root, "sub"))).toEqual([
      { name: "nested.txt", kind: "file" },
      { name: "new.json", kind: "file" },
    ]);
    expect((await fs.readDir(root)).map((entry) => entry.name)).toEqual([
      "B.txt",
      "_under.txt",
      "dangling",
      "hello.txt",
      "link",
      "locked",
      "sub",
    ]);
  });

  test("a buffer never shadows or duplicates a directory in readDir", async () => {
    // Only files are overlaid, so the base wins the name and stat() agrees.
    fs.set(join(root, "sub"), "not a directory");
    const entries = (await fs.readDir(root)).filter((entry) => entry.name === "sub");
    expect(entries).toEqual([{ name: "sub", kind: "directory" }]);
    expect((await fs.stat(join(root, "sub")))?.kind).toBe("directory");
  });

  test("delete falls back to the file on disk", async () => {
    const path = join(root, "hello.txt");
    fs.set(path, "unsaved");
    fs.delete(path);
    expect(await fs.readFile(path)).toBe("café ☕\n");
  });

  test("a buffer is found under any spelling of its path", async () => {
    // Template string, not join(): join() would normalise the `..` before OverlayFS saw it.
    fs.set(`${root}/sub/../hello.txt`, "unsaved");
    expect(await fs.readFile(join(root, "hello.txt"))).toBe("unsaved");
  });

  // Reads must not be cached as buffers: the LSP outlives any number of
  // external writes (a git checkout, a formatter, a sibling process).
  describe("a read is not a buffer", () => {
    let mutRoot: string;
    let path: string;
    beforeEach(() => {
      mutRoot = mkdtempSync(join(tmpdir(), "dcx-vfs-mut-"));
      path = join(mutRoot, "changing.txt");
      writeFileSync(path, "first\n");
    });
    afterEach(() => rmSync(mutRoot, { recursive: true, force: true }));

    test("a file rewritten on disk reads as its new contents", async () => {
      expect(await fs.readFile(path)).toBe("first\n");
      writeFileSync(path, "second\n");
      expect(await fs.readFile(path)).toBe("second\n");
    });

    test("a file removed from disk after a read stats as absent", async () => {
      await fs.readFile(path);
      rmSync(path);
      expect(await fs.stat(path)).toBeUndefined();
      expect(await fs.readDir(mutRoot)).toEqual([]);
    });
  });
});
