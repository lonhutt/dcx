/** An extension as one source knows it. */
export interface Extension {
  readonly version: string | undefined;
  readonly deprecated: boolean;
  /** False when unpublished or removed. */
  readonly downloadable: boolean;
  /** Versions a policy source permits; undefined means unconstrained. */
  readonly allowedVersions: readonly string[] | undefined;
  readonly targetPlatforms: readonly string[];
}

/** Where extensions come from: Open VSX, a VS Code gallery, or an `extensions.allowed` policy. */
export interface Source {
  readonly id: string;
  readonly kind: "openvsx" | "vscode-gallery" | "policy";
  readonly requiresNetwork: boolean;
  /**
   * Looks an extension up, case-insensitively. Resolves `undefined` when the source
   * doesn't have it (or a policy denies it); rejects when the source can't be reached.
   */
  lookup(publisher: string, name: string, signal: AbortSignal): Promise<Extension | undefined>;
}

export interface ConfiguredSource {
  readonly source: Source;
  /** Every extension must be available here (or in any required one, under `satisfy: any`). */
  readonly required: boolean;
}

/** The extension sources `.dcx.yaml` configures, and how many of them must agree. */
export interface ExtensionSources {
  readonly sources: readonly ConfiguredSource[];
  readonly satisfy: "all" | "any";
}

export const NO_SOURCES: ExtensionSources = { sources: [], satisfy: "all" };
