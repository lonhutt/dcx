/** What a path points at, after following symlinks. */
export interface Stats {
  /** `other` covers sockets, FIFOs, and devices. */
  readonly kind: FileType;
}

/** One child of a directory, as listed by {@link FileSystem.readDir}. */
export interface DirEntry extends Stats {
  /** The entry's own name, not its full path. */
  readonly name: string;
}

/**
 * The only way core code touches the filesystem.
 * An editor holds unsaved buffers that do not exist on disk, so rules and
 * discovery read through this interface rather than `Bun.file` or `node:fs`,
 * and the LSP swaps in an `OverlayFS`.
 *
 * All paths are absolute.
 */
export interface FileSystem {
  /**
   * Reads a file as UTF-8 text. Rejects with `code: "ENOENT"` if nothing is there,
   * or another error if it is not a file.
   */
  readFile(path: string): Promise<string>;

  /**
   * Describes the entry at `path`, following symlinks.
   *
   * Resolves `undefined` when nothing is there, including when a parent is a file
   * (ENOTDIR): the `fs/*` rules report missing paths, so absence is a result, not
   * an error. Any other I/O failure rejects.
   */
  stat(path: string): Promise<Stats | undefined>;

  /**
   * Lists a directory's children sorted by name, following symlinks to fill in
   * `kind`. Rejects with `code: "ENOENT"` if nothing is there, or another error if
   * it is not a directory.
   */
  readDir(path: string): Promise<DirEntry[]>;
}

export type FileType = "file" | "directory" | "other";

/**
 * Orders directory entries by codepoint, so a listing does not depend on the
 * host locale or ICU build. `localeCompare` would order `_x a.md a.txt B.txt`
 * under en-US and `B.txt Z.txt _x a.md` under LC_ALL=C, which would leak into
 * diagnostic ordering in CLI output.
 */
export const byName = (a: DirEntry, b: DirEntry): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
