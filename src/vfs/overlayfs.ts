import type { DirEntry, FileSystem, Stats } from "./vfs";
import { byName } from "./vfs";
import { resolve, parse } from "node:path";

/**
 * A {@link FileSystem} that serves in-memory buffers in place of the files
 * beneath them (DESIGN §5.3, §9.2). The LSP keeps one buffer per open document,
 * updated from `textDocument/didChange`, so analysis sees what the user is typing
 * rather than what was last saved.
 *
 * Only files are overlaid. Directories always come from the base, so a buffer
 * whose parent directory does not exist there is unsupported, and the base wins
 * when a buffer's name collides with a directory.
 *
 * Buffers are the only thing held in memory: reads that fall through are never
 * cached, so a file edited outside the editor is picked up on the next read.
 */
export class OverlayFS implements FileSystem {
  private readonly base: FileSystem;
  private readonly buffers: Map<string, string>;

  /** @param base Serves every path that has no buffer, usually a `BunFS`. */
  constructor(base: FileSystem) {
    this.base = base;
    this.buffers = new Map();
  }

  /**
   * Sets the buffer for `path`, shadowing whatever the base holds there. Any
   * spelling of the same absolute path (`a/../b`, `./b`) refers to one buffer.
   */
  set(path: string, text: string): void {
    this.buffers.set(resolve(path), text);
  }

  /** Drops the buffer for `path`, so reads fall through to the base again. */
  delete(path: string): void {
    this.buffers.delete(resolve(path));
  }

  async readFile(path: string): Promise<string> {
    // `??`, not `||`: an empty buffer is a buffer, not a miss.
    return this.buffers.get(resolve(path)) ?? this.base.readFile(path);
  }

  async stat(path: string): Promise<Stats | undefined> {
    const canonPath = resolve(path);
    return (
      (await this.base.stat(canonPath)) ??
      (this.buffers.has(canonPath) ? { kind: "file" } : undefined)
    );
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const canonPath = resolve(path);
    const entries = new Map<string, DirEntry>();

    // Base first, so it wins a name collision the way stat() does.
    for (const entry of await this.base.readDir(canonPath)) {
      entries.set(entry.name, entry);
    }

    for (const bufferPath of this.buffers.keys()) {
      const { dir, base } = parse(bufferPath);
      if (dir === canonPath && !entries.has(base)) {
        entries.set(base, { kind: "file", name: base });
      }
    }

    return [...entries.values()].sort(byName);
  }
}
