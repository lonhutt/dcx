import { readFile, stat } from "node:fs/promises";
import { BunFS, getFileType, isMissing } from "./bunfs";
import type { Stats } from "./vfs";

/** {@link BunFS} without the `Bun` global, for hosts that run on Node: the VS Code extension. */
export class NodeFS extends BunFS {
  override async readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  override async stat(path: string): Promise<Stats | undefined> {
    try {
      return { kind: getFileType(await stat(path)) };
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  }
}
