import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FileSystem, FileType } from "../../vfs/vfs";

export interface Resolution {
  /** Absolute; canonical (symlinks followed) when it exists and stays inside. */
  readonly path: string;
  readonly kind: FileType | undefined;
  /** Leaves the workspace, lexically or through a symlink. Nothing was read when true. */
  readonly escapes: boolean;
  /** Set when the path couldn't be resolved, e.g. a symlink loop. */
  readonly error?: string;
}

/** `child` is `root` or below it, compared by path segment: `/work` isn't inside `/workspace`. */
export function inside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The text of `ref`, resolved as {@link resolveRef} does: `undefined` when it leaves the
 * workspace or isn't a readable file. Every rule that reads a referenced file uses this.
 */
export async function readInside(
  fs: FileSystem,
  root: string,
  dir: string,
  ref: string,
): Promise<string | undefined> {
  const r = await resolveRef(fs, root, dir, ref);
  if (r.escapes || r.kind !== "file") return undefined;
  return fs.readFile(r.path).catch(() => undefined);
}

/**
 * Resolves `ref` (as written in devcontainer.json, forward slashes) against `dir`, and
 * checks it stays inside `root`. A lexical escape is rejected before anything outside
 * is touched; otherwise the path is canonicalised and checked again, which is what
 * catches a symlink pointing out. Check-then-read, so racy against a symlink changing
 * in between; acceptable for a linter that only ever reads.
 */
export async function resolveRef(
  fs: FileSystem,
  root: string,
  dir: string,
  ref: string,
): Promise<Resolution> {
  const path = resolve(dir, ref.replace(/\\/g, "/"));
  if (!inside(root, path)) return { path, kind: undefined, escapes: true };
  let canonical: string | undefined;
  let canonicalRoot: string;
  try {
    canonicalRoot = (await fs.realpath(root)) ?? root;
    canonical = await fs.realpath(path);
  } catch (err) {
    return { path, kind: undefined, escapes: false, error: (err as Error).message };
  }
  if (canonical === undefined) return { path, kind: undefined, escapes: false };
  if (!inside(canonicalRoot, canonical)) return { path: canonical, kind: undefined, escapes: true };
  return { path: canonical, kind: (await fs.stat(canonical))?.kind, escapes: false };
}
