import { isObject, keySpan, member } from "../../model/model";
import { REFERENCE, rule } from "../util";
import { rangeOf } from "../../jsonc/jsonc";
import { featureEntries, isLegacyId } from "../feature/features";
import { fixWith, moveProperty, rewrite } from "./edits";

const VSCODE_DOCS = "https://containers.dev/supporting#visual-studio-code";

export const topLevelDockerfile = rule({
  id: "deprecation/top-level-dockerfile",
  description: 'Legacy "dockerFile"/"context" at root; use "build.*"',
  explain: `Top-level "dockerFile" and "context" are the original way to build from a
Dockerfile, and still work, but the spec has moved them under "build", which is also
where "args", "target" and "cacheFrom" live. Tools and docs assume the new form.

    { "dockerFile": "Dockerfile", "context": ".." }
    // becomes
    { "build": { "dockerfile": "Dockerfile", "context": ".." } }

The fix moves both properties under "build", merging into one that's already there
unless it sets the same keys. Note the lowercase "f" in "dockerfile".`,
  defaultSeverity: "warning",
  fixable: true,
  check({ model, doc, report }) {
    const legacy = model.get("dockerFile");
    if (!legacy) return;
    const context = model.get("context");
    const build = model.get("build");
    const into = isObject(build) ? build.node : undefined;
    // with "build" there, its own keys win and nothing's moved over them
    const conflicts =
      !!build && (!into || member(into, "dockerfile") || (context && member(into, "context")));
    const changes = conflicts
      ? undefined
      : into
        ? [
            { path: ["dockerFile"], value: undefined },
            ...(context ? [{ path: ["context"], value: undefined }] : []),
            { path: ["build", "dockerfile"], value: legacy.value },
            ...(context ? [{ path: ["build", "context"], value: context.value }] : []),
          ]
        : [
            { path: ["dockerFile"], value: undefined },
            ...(context ? [{ path: ["context"], value: undefined }] : []),
            {
              path: ["build"],
              value: { dockerfile: legacy.value, ...(context && { context: context.value }) },
            },
          ];
    report({
      range: keySpan(legacy),
      message: `Top-level "dockerFile"${context ? ' and "context" are' : " is"} deprecated; use "build.dockerfile"${context ? ' and "build.context"' : ""}`,
      help: 'move it under "build"',
      docsUrl: `${REFERENCE}#image-specific`,
      ...(changes && fixWith('Move to "build"', rewrite(doc, changes))),
    });
  },
});

export const appPort = rule({
  id: "deprecation/app-port",
  description: '"appPort" superseded by "forwardPorts"',
  explain: `"appPort" publishes a port the way "docker run -p" does: fixed at creation,
and only for a local Docker host. "forwardPorts" forwards the port through the editor,
which also works over a remote connection and in Codespaces, and can be changed without
rebuilding.

    { "image": "node:22", "appPort": [3000] }
    // becomes
    { "image": "node:22", "forwardPorts": [3000] }

There's no automatic fix: "appPort" also accepts "host:container" mappings that
"forwardPorts" doesn't, so check each entry by hand.`,
  defaultSeverity: "warning",
  check({ model, report }) {
    const port = model.get("appPort");
    if (!port) return;
    report({
      range: keySpan(port),
      message: '"appPort" is superseded by "forwardPorts"',
      help: 'move the ports to "forwardPorts"',
      docsUrl: `${REFERENCE}#image-specific`,
    });
  },
});

export const rootExtensions = rule({
  id: "deprecation/root-extensions",
  description: 'Root "extensions" moved to "customizations.vscode.extensions"',
  explain: `Early devcontainer.json files listed VS Code extensions at the top level. The
spec now keeps each tool's settings under "customizations", so other editors don't have
to know VS Code's keys. Current tooling reads "customizations.vscode.extensions".

    { "image": "node:22", "extensions": ["dbaeumer.vscode-eslint"] }
    // becomes
    { "image": "node:22", "customizations": { "vscode": { "extensions": ["dbaeumer.vscode-eslint"] } } }

The fix moves the list, merging it with any extensions already listed there.`,
  defaultSeverity: "warning",
  fixable: true,
  check({ model, doc, report }) {
    const extensions = model.get("extensions");
    if (!extensions) return;
    const vscode = member(member(model.get("customizations")?.node, "vscode")?.node, "extensions");
    const existing = Array.isArray(vscode?.value) ? vscode.value : [];
    const merged = Array.isArray(extensions.value)
      ? [...existing, ...extensions.value.filter((e) => !existing.includes(e))]
      : extensions.value;
    report({
      range: keySpan(extensions),
      message: 'Top-level "extensions" is deprecated; use "customizations.vscode.extensions"',
      help: 'move it to "customizations.vscode.extensions"',
      docsUrl: VSCODE_DOCS,
      ...fixWith(
        'Move to "customizations.vscode.extensions"',
        moveProperty(doc, "extensions", ["customizations", "vscode", "extensions"], merged),
      ),
    });
  },
});

export const rootSettings = rule({
  id: "deprecation/root-settings",
  description: 'Root "settings" moved to "customizations.vscode.settings"',
  explain: `Early devcontainer.json files put VS Code settings at the top level. The
spec now keeps each tool's settings under "customizations"; current tooling reads
"customizations.vscode.settings".

    { "image": "node:22", "settings": { "editor.tabSize": 2 } }
    // becomes
    { "image": "node:22", "customizations": { "vscode": { "settings": { "editor.tabSize": 2 } } } }

The fix moves the settings, keeping any already under "customizations.vscode.settings"
when the same setting is in both.`,
  defaultSeverity: "warning",
  fixable: true,
  check({ model, doc, report }) {
    const settings = model.get("settings");
    if (!settings) return;
    const existing = member(member(model.get("customizations")?.node, "vscode")?.node, "settings");
    const isObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const merged =
      isObject(settings.value) && isObject(existing?.value)
        ? { ...settings.value, ...existing.value }
        : settings.value;
    report({
      range: keySpan(settings),
      message: 'Top-level "settings" is deprecated; use "customizations.vscode.settings"',
      help: 'move it to "customizations.vscode.settings"',
      docsUrl: VSCODE_DOCS,
      ...fixWith(
        'Move to "customizations.vscode.settings"',
        moveProperty(doc, "settings", ["customizations", "vscode", "settings"], merged),
      ),
    });
  },
});

export const legacyFeatureId = rule({
  id: "deprecation/legacy-feature-id",
  description: 'Feature uses a pre-registry short ID like "docker-in-docker"',
  explain: `Before features were published to OCI registries, they were referenced by a
bare short ID. The dev container CLI still maps the ones it knows to a published feature,
but that mapping is deprecated, picks the version for you, and unknown IDs fail.

    "features": { "docker-in-docker": {} }
    // becomes
    "features": { "ghcr.io/devcontainers/features/docker-in-docker:2": {} }

Some were renamed on the way ("docker-from-docker" is now "docker-outside-of-docker"),
so look the full reference up on containers.dev/features rather than guessing it.`,
  defaultSeverity: "warning",
  check(pass) {
    for (const e of featureEntries(pass)) {
      if (e.ref || !isLegacyId(e.key)) continue;
      pass.report({
        range: rangeOf(e.field.node),
        message: `"${e.key}" is a legacy short feature ID`,
        help: 'use the full reference from containers.dev/features, e.g. "ghcr.io/devcontainers/features/<name>:<major>"',
        docsUrl: "https://containers.dev/features",
      });
    }
  },
});
