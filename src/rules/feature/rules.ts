import { rangeOf } from "../../jsonc/jsonc";
import { parseFeatureRef } from "../../features/ref";
import { identity, isPinned } from "../../model/ref";
import { members } from "../../model/model";
import { suggest } from "../../schema/suggest";
import { rule } from "../util";
import { featureEntries, featureIdentity, installOrder, isLegacyId } from "./features";

const DOCS = "https://containers.dev/implementors/features/#referencing-a-feature";

export const invalidReference = rule({
  id: "feature/invalid-reference",
  description: "Feature reference matches none of the three legal forms",
  explain: `A "features" key has to be one of three things: an OCI reference
(registry/namespace/name, with an optional tag or digest), an https:// URL to a .tgz,
or a path starting "./" or "../" to a feature folder next to devcontainer.json.

    "features": {
      "ghcr.io/devcontainers/features/go:1": {},       // OCI
      "https://example.com/features/tool.tgz": {},     // tarball
      "./local-feature": {}                            // local
    }

Bare names like "docker-in-docker" are the pre-registry short IDs, which
deprecation/legacy-feature-id reports instead.`,
  defaultSeverity: "error",
  check(pass) {
    for (const e of featureEntries(pass)) {
      if (e.ref || isLegacyId(e.key)) continue;
      pass.report({
        range: rangeOf(e.field.node),
        message: `"${e.key}" isn't an OCI reference, an https:// .tgz URL, or a ./ path`,
        help: "check the reference against the feature's documentation",
        docsUrl: DOCS,
      });
    }
  },
  justification:
    "a reference in none of the three forms fails the build; legacy short IDs, which the CLI still maps, are deprecation/legacy-feature-id instead",
});

export const unpinnedVersion = rule({
  id: "feature/unpinned-version",
  description: 'Feature reference has no tag, or uses ":latest"',
  explain: `A feature referenced with no tag, or ":latest", installs whatever was
published most recently. A rebuild next month can get a different major version, and
two teammates can end up with different tools from the same config.

    "ghcr.io/devcontainers/features/node": {}      // unpinned
    "ghcr.io/devcontainers/features/node:1": {}    // pinned to major version 1

A major-version tag is usually enough; a digest pins exactly. Features you've decided to
track at latest can be listed under "features.allow-unpinned" in .dcx.yaml.`,
  defaultSeverity: "warning",
  check(pass) {
    const allowed = new Set(
      pass.settings.allowUnpinnedFeatures.map((a) =>
        featureIdentity({ key: a, ref: parseFeatureRef(a) }),
      ),
    );
    for (const e of featureEntries(pass)) {
      if (e.ref?.kind !== "oci" || isPinned(e.ref)) continue;
      if (allowed.has(identity(e.ref))) continue;
      pass.report({
        range: rangeOf(e.field.node),
        message: e.ref.tag
          ? `Feature "${e.key}" is pinned to ":latest", which moves`
          : `Feature "${e.key}" has no version tag`,
        help: 'add a version tag, e.g. ":1", or list it under features.allow-unpinned in .dcx.yaml',
        docsUrl: DOCS,
      });
    }
  },
});

export const duplicate = rule({
  id: "feature/duplicate",
  description: "Same feature declared twice",
  explain: `The same feature listed twice, usually at two different versions, installs
once; which version and options win isn't obvious from the file.

    "features": {
      "ghcr.io/devcontainers/features/node:1": {},
      "ghcr.io/devcontainers/features/node:2": { "version": "20" }
    }

Keep one entry.`,
  defaultSeverity: "error",
  justification:
    "the CLI installs one of the two and drops the other's options without saying which",
  check(pass) {
    const seen = new Map<string, ReturnType<typeof featureEntries>[number]>();
    for (const e of featureEntries(pass)) {
      const id = featureIdentity(e);
      const first = seen.get(id);
      if (!first) {
        seen.set(id, e);
        continue;
      }
      // the same key twice is syntax/duplicate-key's
      if (first.key === e.key) continue;
      pass.report({
        range: rangeOf(e.field.node),
        message: `"${e.key}" is the same feature as "${first.key}"`,
        help: "keep one of them",
        related: [{ range: rangeOf(first.field.node), message: "first declared here" }],
        docsUrl: DOCS,
      });
    }
  },
});

export const overrideOrderUnknown = rule({
  id: "feature/override-order-unknown",
  description: '"overrideFeatureInstallOrder" lists a feature not in "features"',
  explain: `"overrideFeatureInstallOrder" names features, without their version, in the
order they should install. An entry that matches nothing in "features" does nothing,
and usually means a typo or a feature that was since removed.

    "features": { "ghcr.io/devcontainers/features/node:1": {} },
    "overrideFeatureInstallOrder": ["ghcr.io/devcontainers/features/nodejs"]   // no such feature

Fix the entry, or remove it.`,
  defaultSeverity: "warning",
  check(pass) {
    const declared = new Set(featureEntries(pass).map(featureIdentity));
    for (const entry of installOrder(pass)) {
      const id = featureIdentity({ key: entry.value, ref: parseFeatureRef(entry.value) });
      if (declared.has(id)) continue;
      pass.report({
        range: rangeOf(entry.node),
        message: `"${entry.value}" isn't one of the features in "features"`,
        help: "list features by their reference, without a version",
        docsUrl: "https://containers.dev/implementors/features/#overrideFeatureInstallOrder",
      });
    }
  },
});

const resolved = async (pass: Parameters<typeof invalidReference.check>[0], key: string) => {
  const r = await pass.features!.resolve(key, pass.signal);
  return r.kind === "found" ? r.metadata : undefined;
};

/** Remote features that resolved, with their options; offline, nothing. */
async function remote(pass: Parameters<typeof invalidReference.check>[0]) {
  if (!pass.features) return [];
  const out = [];
  for (const e of featureEntries(pass)) {
    if (!e.ref || e.ref.kind === "local") continue;
    const metadata = await resolved(pass, e.key);
    if (metadata) out.push({ ...e, metadata });
  }
  return out;
}

const FEATURE_OPTIONS =
  "https://containers.dev/implementors/features/#devcontainer-feature-json-properties";

export const unknownOption = rule({
  id: "feature/unknown-option",
  description: "Option not declared by the feature",
  explain: `Each feature declares the options it takes in its devcontainer-feature.json.
An option it doesn't declare is ignored, usually because of a typo or an option from
another version of the feature.

    "ghcr.io/devcontainers/features/node:1": { "verison": "20" }   // "version"

Needs --online: dcx fetches the feature's metadata to know its options.`,
  defaultSeverity: "error",
  justification: "the CLI ignores the option, so whatever it was meant to set never happens",
  requiresNetwork: true,
  async check(pass) {
    for (const f of await remote(pass)) {
      if (f.options.node.type !== "object") continue;
      const declared = Object.keys(f.metadata.options ?? {});
      for (const { name, field } of members(f.options.node)) {
        if (declared.includes(name)) continue;
        const guess = suggest(name, declared);
        pass.report({
          range: rangeOf(field.key ?? field.node),
          message: `"${f.metadata.id}" has no option "${name}"${guess ? `; did you mean "${guess}"?` : ""}`,
          help: declared.length
            ? `its options are ${declared.map((d) => `"${d}"`).join(", ")}`
            : "this feature takes no options",
          docsUrl: FEATURE_OPTIONS,
        });
      }
    }
  },
});

export const invalidOptionValue = rule({
  id: "feature/invalid-option-value",
  description: 'Value outside the option\'s "enum", or of the wrong type',
  explain: `A feature option can restrict its value: a boolean option takes true or false,
and a string option with an "enum" takes only those strings. Anything else fails the
feature's install script, or gets silently replaced with the default.

    "ghcr.io/devcontainers/features/python:1": { "installTools": "yes" }   // a boolean option

Needs --online. "proposals" are only suggestions, so values outside them are fine.`,
  defaultSeverity: "error",
  justification: "the CLI rejects the value, or the feature's install script fails on it",
  requiresNetwork: true,
  async check(pass) {
    for (const f of await remote(pass)) {
      if (f.options.node.type !== "object") continue;
      for (const { name, field } of members(f.options.node)) {
        const option = f.metadata.options?.[name];
        if (!option) continue;
        let message: string | undefined;
        if (option.type === "boolean" && typeof field.value !== "boolean")
          message = `"${name}" is a boolean option; use true or false`;
        else if (option.type === "string" && typeof field.value !== "string")
          message = `"${name}" is a string option`;
        else if (
          option.enum &&
          typeof field.value === "string" &&
          !option.enum.includes(field.value)
        )
          message = `"${name}" must be one of ${option.enum.map((v) => JSON.stringify(v)).join(", ")}`;
        if (!message) continue;
        pass.report({ range: rangeOf(field.node), message, docsUrl: FEATURE_OPTIONS });
      }
    }
  },
});

export const deprecated = rule({
  id: "feature/deprecated",
  description: "Feature is marked deprecated upstream",
  explain: `The feature's authors have marked it deprecated: it may stop getting fixes,
or be removed from the registry, at which point builds fail. Its documentation usually
names the replacement.

Needs --online.`,
  defaultSeverity: "warning",
  requiresNetwork: true,
  async check(pass) {
    for (const f of await remote(pass)) {
      if (!f.metadata.deprecated) continue;
      pass.report({
        range: rangeOf(f.field.node),
        message: `Feature "${f.key}" is deprecated upstream`,
        help: "check its documentation for the replacement",
        docsUrl: FEATURE_OPTIONS,
      });
    }
  },
});

export const missingDependency = rule({
  id: "feature/missing-dependency",
  description: 'A "dependsOn" requirement can\'t be satisfied',
  explain: `A feature can depend on other features ("dependsOn"), which the dev
container CLI installs first. If a dependency doesn't exist in its registry (renamed,
removed, or a private registry this machine can't see), the build fails partway.

Needs --online. A dependency dcx couldn't reach is only reported as a warning on stderr,
since a flaky registry isn't the config's fault.`,
  defaultSeverity: "warning",
  requiresNetwork: true,
  async check(pass) {
    for (const f of await remote(pass)) {
      for (const dep of Object.keys(f.metadata.dependsOn ?? {})) {
        const r = await pass.features!.resolve(dep, pass.signal);
        if (r.kind !== "not-found") continue;
        pass.report({
          range: rangeOf(f.field.node),
          message: `"${f.metadata.id}" depends on "${dep}", which doesn't exist`,
          help: "check for a newer version of the feature, or replace it",
          docsUrl: "https://containers.dev/implementors/features/#dependsOn",
        });
      }
    }
  },
});
