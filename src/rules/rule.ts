import type { Diagnostic, Severity } from "../diagnostic/diagnostic";
import type { FeatureResolver } from "../features/resolver";
import type { Document } from "../jsonc/jsonc";
import type { DevContainer } from "../model/model";
import type { ExtensionSources } from "../registry/sources";
import type { TranslatedError } from "../schema/translate";
import type { FileSystem } from "../vfs/vfs";

export type Category =
  | "syntax"
  | "schema"
  | "scenario"
  | "semantic"
  | "fs"
  | "deprecation"
  | "feature"
  | "port"
  | "mount"
  | "lifecycle"
  | "security"
  | "vscode"
  | "repro"
  | "style"
  | "meta";

/** What a rule reports; the engine fills in the rule ID and the configured severity. */
export type Finding = Omit<Diagnostic, "ruleId" | "severity" | "suppressed" | "suppressReason">;

/** Settings from `.dcx.yaml` that individual rules read. */
export interface RuleSettings {
  /** Feature references `feature/unpinned-version` lets through. */
  readonly allowUnpinnedFeatures: readonly string[];
}

/** Everything a rule may look at for one document. Rules must not mutate any of it. */
export interface Pass {
  readonly doc: Document;
  readonly model: DevContainer;
  /** The only way to reach the filesystem. */
  readonly fs: FileSystem;
  /** The directory holding the devcontainer.json; relative references resolve against it. */
  readonly dir: string;
  /** The workspace root: the folder the dev container opens. */
  readonly root: string;
  /** Schema errors, translated once per document for the four `schema/*` rules. */
  readonly schema: readonly TranslatedError[];
  readonly settings: RuleSettings;
  /** Undefined when offline. */
  readonly features: FeatureResolver | undefined;
  readonly extensions: ExtensionSources;
  readonly signal: AbortSignal;
  report(finding: Finding): void;
}

export interface Rule {
  /** `category/kebab-name`; stable API, never renamed once shipped. */
  readonly id: string;
  readonly description: string;
  /** Long form for `--explain`: why it matters, an example, and how to fix it. */
  readonly explain: string;
  readonly defaultSeverity: Severity;
  readonly category: Category;
  readonly requiresNetwork: boolean;
  /** Reports findings carrying a `fix`. */
  readonly fixable: boolean;
  /**
   * Why the rule earns its severity, from the corpus review: required for every `error`
   * rule, and for any rule that fires on more than a fifth of real-world configs.
   */
  readonly justification?: string;
  check(pass: Pass): void | Promise<void>;
}
