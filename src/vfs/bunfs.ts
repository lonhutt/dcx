import type { DirEntry, FileSystem, FileType, Stats } from "./vfs";
import { byName } from "./vfs";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

/**
 * The on-disk {@link FileSystem} the CLI uses. Bun-only APIs (`Bun.file` etc.) stay in
 * `src/vfs`, `src/cli` and `src/position`; the published package also has to run on
 * Node 22+, so everything else stays runtime-agnostic.
 */
export class BunFS implements FileSystem {
  async readFile(path: string): Promise<string> {
    return Bun.file(path).text();
  }

  async stat(path: string): Promise<Stats | undefined> {
    try {
      return { kind: getFileType(await Bun.file(path).stat()) };
    } catch (err) {
      if (isMissing(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const entries = await Promise.all(
      (await readdir(path, { withFileTypes: true })).map(async (entry) => ({
        name: entry.name,
        // Only a symlink costs a second syscall: a Dirent already knows every other kind.
        kind: entry.isSymbolicLink()
          ? await targetKind(join(path, entry.name))
          : getFileType(entry),
      })),
    );

    return entries.sort(byName);
  }
}

/**
 * Distinguishes absence, which {@link FileSystem.stat} reports as `undefined`,
 * from a real I/O failure such as `EACCES` or `ELOOP`, which it rejects with.
 * `ENOTDIR` counts as absence: nothing is at a path below a file.
 */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolves a symlink's target kind for a directory listing. A dangling or
 * looping symlink is `other` rather than an error: the entry itself exists, so
 * failing the whole listing would be indistinguishable from the directory being
 * missing. This also absorbs the race where an entry is deleted between the
 * `readdir` and its `stat`.
 */
async function targetKind(path: string): Promise<FileType> {
  try {
    return getFileType(await Bun.file(path).stat());
  } catch {
    return "other";
  }
}

/** Accepts both a `Stats` and a `Dirent`, which agree on these two predicates. */
function getFileType(entry: { isFile(): boolean; isDirectory(): boolean }): FileType {
  return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
}
