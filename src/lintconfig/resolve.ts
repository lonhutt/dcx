import { dirname, resolve } from "node:path";
import type { FileSystem } from "../vfs/vfs";
import { DEFAULTS, type Config } from "./config";
import { discoverConfig, userConfigPath } from "./discover";
import { load } from "./load";
import { fromEnv, merge } from "./merge";

export interface ResolveOptions {
  readonly fs: FileSystem;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  /** An explicit project config; skips discovery. Absolute. */
  readonly configPath?: string;
  /** Ignore project configs; the user config still applies. */
  readonly noConfig?: boolean;
  /** The last, highest-precedence layer: CLI flags, or editor settings. */
  readonly overrides?: Config;
}

/**
 * Each directory's merged config: defaults, then the user config, the project config,
 * the environment and `overrides`. Each file is read once. Throws `ConfigError` for a
 * config file that's broken, and the I/O error for one that can't be read.
 */
export class ConfigResolver {
  private user?: Promise<Config>;
  private readonly files = new Map<string, Promise<Config>>();
  // one object per project config: callers cache on Config identity
  private readonly merged = new Map<string | undefined, Promise<Config>>();

  constructor(private readonly options: ResolveOptions) {}

  async for(dir: string): Promise<Config> {
    const { fs, configPath, noConfig } = this.options;
    const path = configPath ?? (noConfig ? undefined : await discoverConfig(fs, dir));
    let config = this.merged.get(path);
    if (!config) this.merged.set(path, (config = this.layer(path)));
    return config;
  }

  private async layer(path: string | undefined): Promise<Config> {
    const { env, overrides = {} } = this.options;
    const user = await (this.user ??= this.loadUser());
    const project = path ? await this.read(path, "project") : {};
    return [user, project, fromEnv(env), overrides].reduce(merge, DEFAULTS);
  }

  private async loadUser(): Promise<Config> {
    const path = userConfigPath(this.options.env, this.options.home);
    return (await this.options.fs.stat(path))?.kind === "file" ? this.read(path, "user") : {};
  }

  private read(path: string, layer: "user" | "project"): Promise<Config> {
    let config = this.files.get(path);
    if (!config) {
      // a user config's excludes are relative to the project being checked, not ~/.config/dcx
      config = load(this.options.fs, resolve(path), layer).then((c) =>
        layer === "project" ? { ...c, base: c.base ?? dirname(path) } : { ...c, base: undefined },
      );
      this.files.set(path, config);
    }
    return config;
  }
}
