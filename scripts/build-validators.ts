#!/usr/bin/env bun

import Ajv2019 from "ajv/dist/2019";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import path from "path";
import baseSchema from "../schemas/devContainer.base.schema.json" with { type: "json" };
import devcontainerFeatureSchema from "../schemas/devContainerFeature.schema.json" with { type: "json" };

/**
 * Compiles standalone Ajv validator modules from `schemas/*.schema.json` into
 * `src/schema/generated/`, at build time rather than via `new Function` at startup
 * (DCL-10). Output is committed — it's a build-time input, not a runtime artefact.
 *
 * Two Ajv instances, not one: `devContainer.base.schema.json` declares
 * `$schema: .../draft/2019-09/schema` and `devContainerFeature.schema.json` declares
 * draft-07 — they're genuinely different dialects, not a case where either entrypoint
 * happens to work. Using the default `ajv` entrypoint (draft-07) for the base schema
 * doesn't silently ignore `unevaluatedProperties` the way the naive version of this
 * mistake usually does — it fails to even recognize the 2019-09 `$schema` URI and
 * throws immediately (`no schema with key or ref ".../2019-09/schema"`).
 *
 * `strict: false` on both: the schemas use `allowComments`/`allowTrailingCommas`,
 * which Ajv's strict mode rejects as unknown keywords otherwise.
 *
 * `devContainer.schema.json` (the wrapper) is deliberately NOT compiled here. It's an
 * `allOf` of a local relative `$ref` to the base schema (which Ajv won't resolve
 * without `addSchema`-registering the base schema under a matching key first) plus two
 * `https://raw.githubusercontent.com/...` refs to VS Code's own schemas, which were
 * never vendored into `schemas/` at all. Making it compile means either vendoring those
 * two files or deciding to drop them from the wrapper — a real scope decision, not
 * something to paper over here with a permissive ref loader.
 */
export async function buildValidators(): Promise<void> {
  const ajv2019 = new Ajv2019({
    code: { source: true, esm: true },
    allErrors: true,
    strict: false,
  });
  const ajv07 = new Ajv({ code: { source: true, esm: true }, allErrors: true, strict: false });

  const base = ajv2019.compile(baseSchema);
  const feature = ajv07.compile(devcontainerFeatureSchema);

  // TODO(DCL-10): both schemas use `format: "uri"` — confirmed by the
  // `unknown format "uri" ignored` warning Ajv prints at compile time, since
  // `ajv-formats` isn't installed. Format keywords are currently no-ops. Decide
  // whether to add `ajv-formats` (see the work item's implementation notes) before
  // relying on format validation.

  const outDir = path.join(import.meta.dir, "..", "src", "schema", "generated");
  await Bun.write(
    path.join(outDir, "devContainer.base.validator.js"),
    standaloneCode(ajv2019, base),
  );
  await Bun.write(
    path.join(outDir, "devContainerFeature.validator.js"),
    standaloneCode(ajv07, feature),
  );
}

if (import.meta.main) {
  await buildValidators();
}
