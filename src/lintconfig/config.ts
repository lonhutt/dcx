import type { Severity } from "../diagnostic/diagnostic";
import type { Category } from "../rules/rule";

/** Where a setting came from, lowest precedence first. */
export type Layer = "default" | "user" | "project" | "env" | "flags";

export interface SourceConfig {
  readonly id: string;
  readonly kind: "openvsx" | "vscode-gallery" | "policy";
  readonly url?: string;
  /** A policy file; absolute, resolved against the config file that named it. */
  readonly path?: string;
  /** An inline `extensions.allowed` policy. */
  readonly allowed?: Readonly<Record<string, unknown>>;
  /** The name of an environment variable holding a token; never the token. */
  readonly tokenEnv?: string;
  readonly required?: boolean;
}

/**
 * A config layer. Every field is optional: `undefined` means this layer said nothing,
 * `false` means it said false. Merging with `??` keeps the two apart.
 */
export interface Config {
  readonly failOn?: Exclude<Severity, "off">;
  /** Caps every finding's severity, e.g. to never fail a build on a warning-level rule. */
  readonly maxSeverity?: Exclude<Severity, "off">;
  readonly online?: boolean;
  readonly rules?: Readonly<Record<string, Severity>>;
  readonly categories?: Readonly<Partial<Record<Category, Severity>>>;
  /** gitignore-style patterns, relative to `base`, or to the directory being checked when only the user config sets them. */
  readonly exclude?: readonly string[];
  readonly allowUnpinned?: readonly string[];
  /** Milliseconds. */
  readonly cacheTtl?: number;
  readonly extensionSources?: readonly SourceConfig[];
  readonly satisfy?: "all" | "any";
  /** The directory relative paths in this config resolve against. */
  readonly base?: string;
}

export const DEFAULTS: Config = {
  failOn: "error",
  online: false,
  cacheTtl: 24 * 60 * 60 * 1000,
  satisfy: "all",
};

/**
 * The sources `--online` checks when the config names none: Open VSX, not required. Never
 * the Microsoft Marketplace by default; its terms limit it to Microsoft's own products.
 */
export const DEFAULT_SOURCES: readonly SourceConfig[] = [
  { id: "open-vsx", kind: "openvsx", url: "https://open-vsx.org" },
];
