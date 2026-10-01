import { validate } from "./generated/devContainer.base.validator";
import schemas from "./provenance.json" with { type: "json" };

/**
 * Where a vendored schema came from: upstream URL, the `devcontainer-spec` submodule
 * commit, and the date it was retrieved.
 *
 * `schemas/` is a symlink into the pinned submodule, not a copy; so this data (not a
 * file diff) is what a drift check compares against upstream.
 */
export interface Provenance {
  readonly url: string;
  readonly commit: string;
  readonly retrieved: string;
}

/** One entry per vendored schema, keyed by filename. */
export function provenance(): Record<string, Provenance> {
  return {
    "devContainer.base.schema.json": schemas["devContainer.base.schema.json"],
    "devContainer.schema.json": schemas["devContainer.schema.json"],
    "devContainerFeature.schema.json": schemas["devContainerFeature.schema.json"],
  };
}
