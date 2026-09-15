import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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
 * @param target File or directory, absolute or relative to the working directory.
 * @returns Absolute paths, sorted; empty when no config is found.
 */
export function discoverDevcontainer(target = process.cwd()): string[] {
  const root = resolve(target);
  const stats = statSync(root, { throwIfNoEntry: false });
  if (!stats) return [];
  if (stats.isFile()) return [root];

  const primary = [
    join(root, ".devcontainer", "devcontainer.json"),
    join(root, ".devcontainer.json"),
  ].find(isFile);
  if (primary) return [primary];

  const dir = join(root, ".devcontainer");
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name, "devcontainer.json"))
    .filter(isFile)
    .sort();
}

/**
 * True only for a regular file (following symlinks); a directory named
 * `devcontainer.json`, or a path whose parent is a file, is not one.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch (err) {
    // throwIfNoEntry only covers ENOENT; a file where a parent directory should be raises ENOTDIR.
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw err;
  }
}
