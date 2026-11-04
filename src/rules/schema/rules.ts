import type { ErrorClass } from "../../schema/translate";
import type { Rule } from "../rule";
import { rule } from "../util";

/** A rule reporting the translated schema errors of `classes`. */
function fromSchema(
  r: Omit<Rule, "requiresNetwork" | "fixable" | "category" | "check">,
  classes: readonly ErrorClass[],
): Rule {
  return rule({
    ...r,
    check({ schema, report }) {
      for (const e of schema) {
        if (!classes.includes(e.class)) continue;
        report({
          range: e.range,
          message: e.message,
          docsUrl: e.docsUrl,
          ...(e.help && { help: e.help }),
        });
      }
    },
  });
}

export const unknownProperty = fromSchema(
  {
    id: "schema/unknown-property",
    description: "Property not in the spec; includes a spelling suggestion",
    explain: `The property isn't part of the dev container spec, or doesn't apply to this
kind of config, so whatever it was meant to do won't happen. Usually it's a typo, and
dcx suggests the property you probably meant.

    { "image": "node:22", "postCreateComand": "npm ci" }   // never runs

Rename it to the property you meant, or delete it. Settings for a particular editor or
tool belong under "customizations".`,
    defaultSeverity: "warning",
  },
  ["unknown-property"],
);

export const typeMismatch = fromSchema(
  {
    id: "schema/type-mismatch",
    description: "Wrong JSON type for a known property",
    explain: `The property exists, but its value is the wrong JSON type: a string where
the spec wants an array, a number where it wants a string. Tools reject the config or
ignore the property.

    { "image": "node:22", "forwardPorts": "3000" }   // must be an array

Change the value to the type the message names.`,
    defaultSeverity: "error",
    justification: "the CLI rejects or misreads a value of the wrong type",
  },
  ["type-mismatch"],
);

export const invalidEnumValue = fromSchema(
  {
    id: "schema/invalid-enum-value",
    description: "Value outside the allowed set; lists valid values",
    explain: `The value isn't one the spec allows for this property: not one of a fixed
set of choices, or outside an allowed range. The message lists what's accepted.

    { "image": "node:22", "userEnvProbe": "bash" }

Pick one of the listed values.`,
    defaultSeverity: "error",
    justification:
      "the spec allows only the listed values; the CLI rejects or ignores anything else",
  },
  ["invalid-enum", "other"],
);

export const missingRequired = fromSchema(
  {
    id: "schema/missing-required",
    description: "A required property for the detected scenario is absent",
    explain: `Something the spec requires is missing: a mount with no "target", a
"build" with no "dockerfile". The container can't be created from the config as written.

    { "build": { "context": ".." } }   // build needs a dockerfile

Add the property the message names.`,
    defaultSeverity: "error",
    justification: "the spec requires it for this kind of config, and the CLI fails without it",
  },
  ["missing-required"],
);
