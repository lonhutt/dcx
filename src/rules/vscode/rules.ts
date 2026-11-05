import { rangeOf } from "../../jsonc/jsonc";
import { member, members } from "../../model/model";
import { rule } from "../util";
import type { Pass } from "../rule";
import { isApplicationScoped } from "./app-scope";
import { extensionEntries } from "./extensions";

const DOCS = "https://containers.dev/supporting#visual-studio-code";
const POLICY_DOCS =
  "https://code.visualstudio.com/docs/setup/enterprise#_configure-allowed-extensions";

const policies = (pass: Pass) => pass.extensions.sources.filter((s) => s.source.kind === "policy");

export const invalidExtensionId = rule({
  id: "vscode/invalid-extension-id",
  description: 'Extension ID is not "publisher.name"',
  explain: `Extensions are listed by their ID, "publisher.name", as shown on the
extension's Marketplace or Open VSX page. A display name, a URL or a missing publisher
isn't an ID, and the extension silently doesn't install.

    "extensions": ["dbaeumer.vscode-eslint"]     // fine
    "extensions": ["ESLint"]                     // display name, not an ID

A leading "-" removes an extension something else added; "@version" pins one.`,
  defaultSeverity: "error",
  justification: "VS Code can't install an ID that isn't publisher.name",
  check(pass) {
    for (const { field, entry } of extensionEntries(pass)) {
      if (entry) continue;
      pass.report({
        range: rangeOf(field.node),
        message: `"${field.value}" isn't an extension ID; IDs look like "publisher.name"`,
        help: "copy the ID from the extension's Marketplace or Open VSX page",
        docsUrl: DOCS,
      });
    }
  },
});

export const extensionNotAllowed = rule({
  id: "vscode/extension-not-allowed",
  description: "Extension is denied by an extensions.allowed policy",
  explain: `Your organisation's "extensions.allowed" policy (configured as a policy
extension source in .dcx.yaml) doesn't allow this extension, so it won't install for
anyone the policy applies to, and the dev container silently comes up without it.

    # .dcx.yaml
    extension-sources:
      - id: org
        kind: policy
        allowed: { "microsoft": true }

    "extensions": ["golang.go"]    // not allowed by "org"

Ask for it to be added to the policy, or drop it.`,
  defaultSeverity: "error",
  justification: "the organisation's policy blocks the install, so the extension never arrives",
  async check(pass) {
    for (const { field, entry } of extensionEntries(pass)) {
      if (!entry || entry.excluded) continue;
      for (const { source } of policies(pass)) {
        if (await source.lookup(entry.publisher, entry.name, pass.signal)) continue;
        pass.report({
          range: rangeOf(field.node),
          message: `"${entry.publisher}.${entry.name}" isn't allowed by the "${source.id}" extension policy, so it won't install`,
          help: "ask for it to be added to the policy, or remove it",
          docsUrl: POLICY_DOCS,
        });
      }
    }
  },
});

export const extensionVersionNotAllowed = rule({
  id: "vscode/extension-version-not-allowed",
  description: "Policy pins versions the requested extension does not satisfy",
  explain: `An "extensions.allowed" policy can allow an extension only at certain
versions. Asking for another version, or for none (which means the latest), gets an
extension the policy blocks.

    allowed: { "ms-python.python": ["2024.1.0"] }

    "extensions": ["ms-python.python"]             // latest, not allowed
    "extensions": ["ms-python.python@2024.1.0"]    // fine`,
  defaultSeverity: "warning",
  async check(pass) {
    for (const { field, entry } of extensionEntries(pass)) {
      if (!entry || entry.excluded) continue;
      for (const { source } of policies(pass)) {
        const ext = await source.lookup(entry.publisher, entry.name, pass.signal);
        const versions = ext?.allowedVersions;
        if (!versions || (entry.version && versions.includes(entry.version))) continue;
        const list = versions.length ? versions.join(", ") : "none";
        pass.report({
          range: rangeOf(field.node),
          message: entry.version
            ? `The "${source.id}" policy doesn't allow version ${entry.version} of "${entry.publisher}.${entry.name}" (allowed: ${list})`
            : `The "${source.id}" policy only allows "${entry.publisher}.${entry.name}" at ${list}, and this asks for the latest`,
          ...(versions.length && {
            help: `pin it, e.g. "${entry.publisher}.${entry.name}@${versions[0]}"`,
          }),
          docsUrl: POLICY_DOCS,
        });
      }
    }
  },
});

export const ineffectiveApplicationSetting = rule({
  id: "vscode/ineffective-application-setting",
  description:
    "Application-scoped setting in customizations.vscode.settings, where VS Code discards it",
  explain: `Some VS Code settings only apply application-wide: "extensions.allowed",
"extensions.gallery.*", "update.mode", "telemetry.telemetryLevel" and others. VS Code
ignores them in workspace and remote settings, which is where
"customizations.vscode.settings" goes, so setting one there has no effect.

That's deliberate for "extensions.allowed": if a repository could set it, any
repository could allow-list arbitrary extensions for whoever opens it. Org policy has to
come from user settings or group policy instead.

    "customizations": { "vscode": { "settings": { "extensions.allowed": { ... } } } }   // ignored`,
  defaultSeverity: "warning",
  check(pass) {
    const settings = member(
      member(pass.model.get("customizations")?.node, "vscode")?.node,
      "settings",
    );
    if (!settings || settings.node.type !== "object") return;
    for (const { name, field } of members(settings.node)) {
      if (!isApplicationScoped(name)) continue;
      pass.report({
        range: rangeOf(field.key ?? field.node),
        message: `"${name}" is an application-wide setting; VS Code ignores it here`,
        help:
          name === "extensions.allowed"
            ? "set it through user settings or group policy; for dcx, add it as a policy source in .dcx.yaml"
            : "set it in user settings instead",
        docsUrl: "https://code.visualstudio.com/docs/getstarted/settings#_settings-precedence",
      });
    }
  },
});

// the three network rules share one round of lookups per document
const looked = new WeakMap<Pass["model"], ReturnType<typeof lookupAll>>();
const lookups = (pass: Pass) => {
  let found = looked.get(pass.model);
  if (!found) looked.set(pass.model, (found = lookupAll(pass)));
  return found;
};

/** Each extension, with what every network source said: found, absent, or unreachable. */
async function lookupAll(pass: Pass) {
  const remote = pass.extensions.sources.filter((s) => s.source.requiresNetwork);
  if (!remote.length) return [];
  const wanted = extensionEntries(pass).flatMap(({ field, entry }) =>
    entry && !entry.excluded ? [{ field, entry }] : [],
  );
  return Promise.all(
    wanted.map(async ({ field, entry }) => ({
      field,
      id: `${entry.publisher}.${entry.name}`,
      results: await Promise.all(
        remote.map(async (s) => {
          try {
            return {
              ...s,
              ext: await s.source.lookup(entry.publisher, entry.name, pass.signal),
              reached: true,
            };
          } catch {
            return { ...s, ext: undefined, reached: false };
          }
        }),
      ),
    })),
  );
}

const names = (xs: readonly { source: { id: string } }[]) =>
  xs.map((x) => `"${x.source.id}"`).join(", ");

export const extensionNotFound = rule({
  id: "vscode/extension-not-found",
  description: "Extension is absent from every required source",
  explain: `None of the extension sources marked "required" in .dcx.yaml has this
extension, so it won't install for anyone: usually a typo in the ID, or an extension
that was unpublished.

Needs --online and at least one required source. A source dcx couldn't reach doesn't
count either way.`,
  defaultSeverity: "error",
  justification: "a required marketplace doesn't have it, so the install fails there",
  requiresNetwork: true,
  async check(pass) {
    for (const { field, id, results } of await lookups(pass)) {
      const required = results.filter((r) => r.required && r.reached);
      if (!required.length || required.some((r) => r.ext)) continue;
      pass.report({
        range: rangeOf(field.node),
        message: `"${id}" isn't in ${required.length === 1 ? "the required source" : "any required source"} (${names(required)})`,
        help: "check the ID on the extension's marketplace page",
        docsUrl: DOCS,
      });
    }
  },
});

export const extensionNotPortable = rule({
  id: "vscode/extension-not-portable",
  description: "Extension is in some required sources but not all",
  explain: `Open VSX isn't a mirror of the Microsoft Marketplace; Microsoft's
proprietary extensions (Pylance, the C# Dev Kit, Live Share, ...) aren't on it. A config
that works in VS Code then silently comes up without them in VSCodium, Cursor, Gitpod or
anything else that uses Open VSX.

This fires when an extension is in some required sources and not others. With
"extensions.satisfy: any" in .dcx.yaml, one source is enough and it doesn't fire.`,
  defaultSeverity: "warning",
  requiresNetwork: true,
  async check(pass) {
    if (pass.extensions.satisfy === "any") return;
    for (const { field, id, results } of await lookups(pass)) {
      const required = results.filter((r) => r.required && r.reached);
      const missing = required.filter((r) => !r.ext);
      if (!missing.length || missing.length === required.length) continue;
      pass.report({
        range: rangeOf(field.node),
        message: `"${id}" isn't available from ${names(missing)}, so it won't install for anyone using it`,
        help: "find an alternative available everywhere, or accept the gap with satisfy: any",
        docsUrl: DOCS,
      });
    }
  },
});

export const extensionDeprecated = rule({
  id: "vscode/extension-deprecated",
  description: "A source reports the extension deprecated, or no longer downloadable",
  explain: `The marketplace marks this extension deprecated, or has stopped serving it
(unpublished or removed). It may already fail to install, and won't get fixes. The
marketplace page usually names the replacement.

Needs --online.`,
  defaultSeverity: "warning",
  requiresNetwork: true,
  async check(pass) {
    for (const { field, id, results } of await lookups(pass)) {
      const hit = results.find((r) => r.ext && (r.ext.deprecated || !r.ext.downloadable));
      if (!hit) continue;
      pass.report({
        range: rangeOf(field.node),
        message: hit.ext!.downloadable
          ? `"${id}" is deprecated on "${hit.source.id}"`
          : `"${id}" can no longer be downloaded from "${hit.source.id}"`,
        help: "check its marketplace page for the replacement",
        docsUrl: DOCS,
      });
    }
  },
});
