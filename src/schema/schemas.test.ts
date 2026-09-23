import { test } from "bun:test";

// Nothing to assert yet — provenance() throws until DCL-10 lands, and the generated
// validators under src/schema/generated/ don't exist until scripts/build-validators.ts
// has actually run. test.todo marks intent without running or failing these.

test.todo("every generated validator compiles and validates a known-good fixture", () => {});
test.todo(
  "provenance() has one entry per vendored schema, each with a url, commit and date",
  () => {},
);
test.todo(
  "vendored files match the submodule's copies (skipped when the submodule is absent)",
  () => {},
);
test.todo("offline determinism — same input, identical output, no network reachable", () => {});
test.todo(
  "unevaluatedProperties is genuinely enforced by the generated validator " +
    "(catches importing the wrong Ajv entrypoint — see DCL-10's implementation notes)",
  () => {},
);
