import { join, resolve } from "node:path";
import type { FileSystem } from "../vfs/vfs";

/**
 * Resolves a `dcx check` target to the devcontainer.json file(s) to lint, in the
 * spec's discovery order (DESIGN §3.1, §7.2).
 *
 * A file target is returned as-is. A directory is searched for
 * `.devcontainer/devcontainer.json`, then `.devcontainer.json`, and the first
 * that exists wins. Failing both, every `.devcontainer/<folder>/devcontainer.json`
 * exactly one level deep is returned.
 *
 * Absence is a normal result, not an exception: the CLI turns an empty array
 * into exit 2 (DESIGN §7.4). I/O errors other than a missing path still throw.
 *
 * @param fs Injected rather than constructed, so the LSP discovers through its
 *   own `OverlayFS` and sees unsaved buffers (DESIGN §4.2 invariant 2, §5.3).
 * @param target File or directory, absolute or relative to the working directory.
 * @returns Absolute paths, sorted; empty when no config is found.
 */
export async function discoverDevcontainer(
  fs: FileSystem,
  target = process.cwd(),
): Promise<string[]> {
  const root = resolve(target);
  const stats = await fs.stat(root);
  if (!stats) return [];
  if (stats.kind === "file") return [root];

  // Sequential, not Promise.all: the first hit wins, so the second lookup is wasted work.
  for (const candidate of [
    join(root, ".devcontainer", "devcontainer.json"),
    join(root, ".devcontainer.json"),
  ]) {
    if (await isFile(fs, candidate)) return [candidate];
  }

  const dir = join(root, ".devcontainer");
  if ((await fs.stat(dir))?.kind !== "directory") return [];

  // readDir lists in codepoint order and neither step below reorders, so the result is sorted.
  const found = await Promise.all(
    (await fs.readDir(dir))
      .filter((entry) => entry.kind === "directory")
      .map(async (entry) => {
        const candidate = join(dir, entry.name, "devcontainer.json");
        return (await isFile(fs, candidate)) ? candidate : undefined;
      }),
  );

  return found.filter((candidate) => candidate !== undefined);
}

/**
 * True only for a regular file (following symlinks); a directory named
 * `devcontainer.json`, or a path whose parent is a file, is not one.
 *
 * Needs no error handling of its own: `stat` already reports both absence and
 * ENOTDIR as `undefined`, and anything it does reject with is a real I/O
 * failure this function has no business swallowing.
 */
async function isFile(fs: FileSystem, path: string): Promise<boolean> {
  return (await fs.stat(path))?.kind === "file";
}
