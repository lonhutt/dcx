import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test.each([
  [
    "prefers .devcontainer/devcontainer.json over every other location",
    ".devcontainer/devcontainer.json",
  ],
  ["falls back to .devcontainer.json before subfolders", ".devcontainer.json"],
])("%s", (_, winner) => {
  const all = [
    ".devcontainer/devcontainer.json",
    ".devcontainer.json",
    ".devcontainer/a/devcontainer.json",
  ];
  const root = project(...all.slice(all.indexOf(winner)));
  expect(discoverDevcontainer(root)).toEqual([join(root, winner)]);
});

test("returns every one-level subfolder config, sorted, and ignores deeper ones", () => {
  const root = project(
    ".devcontainer/b/devcontainer.json",
    ".devcontainer/a/devcontainer.json",
    ".devcontainer/c/deep/devcontainer.json",
  );
  expect(discoverDevcontainer(root)).toEqual([
    join(root, ".devcontainer/a/devcontainer.json"),
    join(root, ".devcontainer/b/devcontainer.json"),
  ]);
});

test("skips a directory named devcontainer.json", () => {
  const root = project(".devcontainer/devcontainer.json/placeholder", ".devcontainer.json");
  expect(discoverDevcontainer(root)).toEqual([join(root, ".devcontainer.json")]);
});

test("returns a file target as-is", () => {
  const root = project("configs/custom.json");
  expect(discoverDevcontainer(join(root, "configs/custom.json"))).toEqual([
    join(root, "configs/custom.json"),
  ]);
});

test("returns an empty array when nothing is found", () => {
  const root = project("README.md");
  expect(discoverDevcontainer(root)).toEqual([]);
  expect(discoverDevcontainer(join(root, "missing"))).toEqual([]);
});

test("treats a .devcontainer file as absent rather than throwing", () => {
  const root = project(".devcontainer");
  expect(discoverDevcontainer(root)).toEqual([]);
});
