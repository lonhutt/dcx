import { dirname, join } from "node:path";
import type { FileSystem } from "../vfs/vfs";

const NAMES = [".dcx.yaml", ".dcx.yml", ".dcx.json"];

/**
 * The nearest project config above `start`: the first `.dcx.yaml`, `.dcx.yml` or
 * `.dcx.json` walking upward, stopping after the repository root (the directory holding
 * `.git`) or the filesystem root.
 */
export async function discoverConfig(fs: FileSystem, start: string): Promise<string | undefined> {
  for (let dir = start; ; dir = dirname(dir)) {
    for (const name of NAMES) {
      if ((await fs.stat(join(dir, name)))?.kind === "file") return join(dir, name);
    }
    if ((await fs.stat(join(dir, ".git"))) || dirname(dir) === dir) return undefined;
  }
}

/** `$XDG_CONFIG_HOME/dcx/config.yaml`, falling back to `~/.config`. */
export function userConfigPath(env: Record<string, string | undefined>, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "dcx", "config.yaml");
}
