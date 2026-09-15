import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunFS } from "../vfs/bunfs";
import { OverlayFS } from "../vfs/overlayfs";
import { discoverDevcontainer } from "./discovery";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Creates a temp project containing `files` (paths relative to its root) and returns the root. */
function project(...files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "dcx-discovery-"));
  roots.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "{}");
  }
  return root;
}

const disk = new BunFS();

test.each([
  [
    "prefers .devcontainer/devcontainer.json over every other location",
    ".devcontainer/devcontainer.json",
  ],
  ["falls back to .devcontainer.json before subfolders", ".devcontainer.json"],
])("%s", async (_, winner) => {
  const all = [
    ".devcontainer/devcontainer.json",
    ".devcontainer.json",
    ".devcontainer/a/devcontainer.json",
  ];
  const root = project(...all.slice(all.indexOf(winner)));
  expect(await discoverDevcontainer(disk, root)).toEqual([join(root, winner)]);
});

test("returns every one-level subfolder config, sorted, and ignores deeper ones", async () => {
  const root = project(
    ".devcontainer/b/devcontainer.json",
    ".devcontainer/a/devcontainer.json",
    ".devcontainer/c/deep/devcontainer.json",
  );
  expect(await discoverDevcontainer(disk, root)).toEqual([
    join(root, ".devcontainer/a/devcontainer.json"),
    join(root, ".devcontainer/b/devcontainer.json"),
  ]);
});

test("skips a directory named devcontainer.json", async () => {
  const root = project(".devcontainer/devcontainer.json/placeholder", ".devcontainer.json");
  expect(await discoverDevcontainer(disk, root)).toEqual([join(root, ".devcontainer.json")]);
});

test("returns a file target as-is", async () => {
  const root = project("configs/custom.json");
  expect(await discoverDevcontainer(disk, join(root, "configs/custom.json"))).toEqual([
    join(root, "configs/custom.json"),
  ]);
});

test("returns an empty array when nothing is found", async () => {
  const root = project("README.md");
  expect(await discoverDevcontainer(disk, root)).toEqual([]);
  expect(await discoverDevcontainer(disk, join(root, "missing"))).toEqual([]);
});

test("treats a .devcontainer file as absent rather than throwing", async () => {
  const root = project(".devcontainer");
  expect(await discoverDevcontainer(disk, root)).toEqual([]);
});

// The reason discovery takes a FileSystem at all: in the LSP a config can exist
// only as an unsaved buffer, and discovery still has to find it.
test("finds a config that exists only as an overlay buffer", async () => {
  const root = project(".devcontainer/placeholder");
  const overlay = new OverlayFS(disk);
  const path = join(root, ".devcontainer", "devcontainer.json");
  overlay.set(path, "{}");
  expect(await discoverDevcontainer(overlay, root)).toEqual([path]);
});

test("a buffer does not resurrect a config deleted from disk", async () => {
  const root = project(".devcontainer/devcontainer.json");
  const overlay = new OverlayFS(disk);
  await overlay.readFile(join(root, ".devcontainer", "devcontainer.json"));
  rmSync(join(root, ".devcontainer", "devcontainer.json"));
  expect(await discoverDevcontainer(overlay, root)).toEqual([]);
});
