import { join, resolve } from "node:path";
import type { FileSystem } from "../vfs/vfs";

/**
 * The result of resolving a `dcx check` target.
 *
 * `searched` lists every devcontainer.json candidate path discovery actually checked,
 * in the order tried, so the exit-2 message ([[DCL-26 CLI flags, wiring and exit codes]])
 * can name what it looked at when `targets` comes back empty.
 */
export interface DiscoveryResult {
  readonly targets: readonly string[];
  readonly searched: readonly string[];
}

/**
 * Resolves a `dcx check` target to the devcontainer.json file(s) to lint, in the
 * spec's discovery order (DESIGN §3.1, §7.2).
 *
 * A file target is returned as-is. A directory is searched for
 * `.devcontainer/devcontainer.json`, then `.devcontainer.json`, and the first
 * that exists wins. Failing both, every `.devcontainer/<folder>/devcontainer.json`
 * exactly one level deep is returned.
 *
 * Absence is a normal result, not an exception: the CLI turns an empty `targets`
 * into exit 2, using `searched` to name what it looked at (DESIGN §7.4). I/O errors
 * other than a missing path still throw.
 *
 * @param fs Injected rather than constructed, so the LSP discovers through its
 *   own `OverlayFS` and sees unsaved buffers (DESIGN §4.2 invariant 2, §5.3).
 * @param target File or directory, absolute or relative to the working directory.
 * @returns `targets` sorted, empty when no config is found; `searched` is every
 *   candidate path checked along the way.
 */
export async function discoverDevcontainer(
  fs: FileSystem,
  target = process.cwd(),
): Promise<DiscoveryResult> {
  const root = resolve(target);
  const stats = await fs.stat(root);
  if (!stats) return { targets: [], searched: [root] };
  if (stats.kind === "file") return { targets: [root], searched: [root] };

  const searched: string[] = [];

  // Sequential, not Promise.all: the first hit wins, so the second lookup is wasted work.
  for (const candidate of [
    join(root, ".devcontainer", "devcontainer.json"),
    join(root, ".devcontainer.json"),
  ]) {
    searched.push(candidate);
    if (await isFile(fs, candidate)) return { targets: [candidate], searched };
  }

  const dir = join(root, ".devcontainer");
  if ((await fs.stat(dir))?.kind !== "directory") return { targets: [], searched };

  // readDir lists in codepoint order and neither step below reorders, so the result is sorted.
  // searched.push happens synchronously before the await in each map callback, and .map
  // invokes every callback synchronously in order, so push order matches entry order
  // regardless of which isFile call settles first.
  const found = await Promise.all(
    (await fs.readDir(dir))
      .filter((entry) => entry.kind === "directory")
      .map(async (entry) => {
        const candidate = join(dir, entry.name, "devcontainer.json");
        searched.push(candidate);
        return (await isFile(fs, candidate)) ? candidate : undefined;
      }),
  );

  return { targets: found.filter((candidate) => candidate !== undefined), searched };
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
