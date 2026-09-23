import { validate } from "./generated/devContainer.base.validator";

/**
 * Per-schema provenance: where each vendored file in `schemas/` came from and when it
 * was last checked against the `devcontainer-spec` submodule (DCL-10).
 *
 * TODO(DCL-10): read from `schemas/provenance.json`, not written yet.
 */
export interface Provenance {
  readonly url: string;
  readonly commit: string;
  readonly retrieved: string;
}

/**
 * TODO(DCL-10): not implemented. One entry per vendored schema, keyed by filename.
 */
export function provenance(): Record<string, Provenance> {
  throw new Error("not implemented");
}
