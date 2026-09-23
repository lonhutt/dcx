import { validate } from "./generated/devContainer.base.validator";
import schemas from "./provenance.json" with { type: "json" };

/**
 * Per-schema provenance: the upstream URL, the `devcontainer-spec` submodule commit
 * it was retrieved at, and the retrieval date (DCL-10).
 *
 * `schemas/` is a symlink into the pinned submodule, not an independent copy, so this
 * data — not a file diff — is what a drift check has to compare against upstream.
 *
 * TODO(DCL-10): read from `./provenance.json` (a JSON import), not implemented yet.
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
  return {
    "devContainer.base.schema.json": schemas["devContainer.base.schema.json"],
    "devContainer.schema.json": schemas["devContainer.schema.json"],
    "devContainerFeature.schema.json": schemas["devContainerFeature.schema.json"],
  };
}
