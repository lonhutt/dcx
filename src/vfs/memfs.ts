import { basename, dirname, resolve } from "node:path";
import type { DirEntry, FileSystem, Stats } from "./vfs";
import { byName } from "./vfs";

const missing = (path: string) =>
  Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" });

/**
 * A {@link FileSystem} over an in-memory map of file paths to contents, for tests.
 * Directories exist wherever a file implies them; there are no symlinks, so every
 * existing path is its own realpath.
 */
export class MemFS implements FileSystem {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  /** Every path asked about, in order; lets a test assert what was read. */
  readonly calls: string[] = [];

  constructor(files: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(files)) this.write(path, text);
  }

  write(path: string, text: string): void {
    const p = resolve(path);
    this.files.set(p, text);
    for (let d = dirname(p); !this.dirs.has(d); d = dirname(d)) {
      this.dirs.add(d);
      if (dirname(d) === d) break;
    }
  }

  async readFile(path: string): Promise<string> {
    const p = resolve(path);
    this.calls.push(p);
    const text = this.files.get(p);
    if (text === undefined) throw missing(p);
    return text;
  }

  async stat(path: string): Promise<Stats | undefined> {
    const p = resolve(path);
    this.calls.push(p);
    if (this.files.has(p)) return { kind: "file" };
    return this.dirs.has(p) ? { kind: "directory" } : undefined;
  }

  async realpath(path: string): Promise<string | undefined> {
    const p = resolve(path);
    this.calls.push(p);
    return this.files.has(p) || this.dirs.has(p) ? p : undefined;
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const p = resolve(path);
    this.calls.push(p);
    if (!this.dirs.has(p)) throw missing(p);
    const out: DirEntry[] = [];
    for (const f of this.files.keys())
      if (dirname(f) === p) out.push({ name: basename(f), kind: "file" });
    for (const d of this.dirs)
      if (d !== p && dirname(d) === p) out.push({ name: basename(d), kind: "directory" });
    return out.sort(byName);
  }
}
