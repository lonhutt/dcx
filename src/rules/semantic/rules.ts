import { readInside } from "../fs/resolve";
import { rangeOf, textOf, type Document, type Node } from "../../jsonc/jsonc";
import { keySpan, members } from "../../model/model";
import {
  parseSubstitutions,
  PLAIN_VARIABLES,
  SCOPED_VARIABLES,
  type Substitution,
} from "../../model/subst";
import { LIFECYCLE } from "../../model/lifecycle";
import { suggest } from "../../schema/suggest";
import { REFERENCE, rule } from "../util";

const VARIABLES_DOCS = `${REFERENCE}#variables-in-devcontainerjson`;
const LIFECYCLE_PROPERTIES: readonly string[] = LIFECYCLE;

/** Every substitution in every string value, with the top-level property it sits under. */
function substitutions(doc: Document): { top: string; s: Substitution }[] {
  const out: { top: string; s: Substitution }[] = [];
  const walk = (node: Node, top: string) => {
    if (node.type === "string") {
      for (const s of parseSubstitutions(textOf(doc, node), node.offset)) out.push({ top, s });
    }
    if (node.type === "property") {
      // keys can carry substitutions too ("${localEnv:X}": ...), but their values matter more
      const value = node.children?.[1];
      if (value) walk(value, top);
    } else node.children?.forEach((c) => walk(c, top));
  };
  if (doc.root?.type === "object") {
    for (const property of doc.root.children ?? []) {
      const [key, value] = property.children ?? [];
      if (value && typeof key?.value === "string") walk(value, key.value);
    }
  }
  return out;
}

const KNOWN = [...PLAIN_VARIABLES, ...SCOPED_VARIABLES];

/**
 * Whether `s` is meant as a dev container variable. `${HOME}` in a command is shell
 * syntax the CLI leaves alone; a scope prefix, or a name close to a real variable, isn't.
 */
function looksLikeVariable(s: Substitution): boolean {
  // ${PATH:-/usr/bin} is the shell's; the spec's variables are all camelCase
  if (/^[A-Z_][A-Z0-9_]*$/.test(s.scope)) return false;
  if (s.name || s.default !== undefined) return true;
  return /^(local|container|devcontainer)/.test(s.scope) || suggest(s.scope, KNOWN) !== undefined;
}

export const invalidSubstitution = rule({
  id: "semantic/invalid-substitution",
  description: "Unknown ${…} variable name",
  explain: `devcontainer.json supports a fixed set of variables: \${localEnv:NAME},
\${containerEnv:NAME}, \${localWorkspaceFolder}, \${containerWorkspaceFolder}, their
"Basename" forms, and \${devcontainerId}. Anything else that looks like one is left in
the string unchanged, so the container sees the literal text.

    { "workspaceFolder": "/workspaces/\${localWorkspaceFolderName}" }   // not a variable

Use one of the supported variables. Shell-style references like \${HOME} in a command
are left to the shell and aren't reported.`,
  defaultSeverity: "error",
  justification:
    "the CLI leaves an unknown ${...} unexpanded, so the literal text ends up in the container",
  check({ doc, report }) {
    for (const { s } of substitutions(doc)) {
      const scoped = SCOPED_VARIABLES.includes(s.scope);
      if (scoped ? s.name !== "" : PLAIN_VARIABLES.includes(s.scope) && s.name === "") continue;
      if (!looksLikeVariable(s)) continue;
      let message: string;
      if (scoped) message = `\${${s.scope}:...} needs a variable name`;
      else if (PLAIN_VARIABLES.includes(s.scope)) message = `\${${s.scope}} takes no argument`;
      else {
        const guess = suggest(s.scope, KNOWN);
        message = `Unknown variable "${s.scope}"${guess ? `; did you mean "${guess}"?` : ""}`;
      }
      report({ range: s.range, message, docsUrl: VARIABLES_DOCS });
    }
  },
});

export const substitutionScope = rule({
  id: "semantic/substitution-scope",
  description: "${containerEnv:…} used outside remoteEnv",
  explain: `\${containerEnv:NAME} reads an environment variable from the running
container, so it can only be resolved after the container starts. That makes it
meaningful in "remoteEnv", which is applied to processes your editor starts inside the
container, but not in properties used to create the container.

    { "containerEnv": { "PATH": "\${containerEnv:PATH}:/opt/bin" } }   // not yet known

Move the setting to "remoteEnv", or use \${localEnv:NAME} if you meant the host's value.`,
  defaultSeverity: "warning",
  check({ doc, report }) {
    for (const { top, s } of substitutions(doc)) {
      if (s.scope !== "containerEnv" || top === "remoteEnv") continue;
      report({
        range: s.range,
        message: `\${containerEnv:${s.name}} is only resolved in "remoteEnv", not in "${top}"`,
        help: 'move it to "remoteEnv", or use ${localEnv:...} for a host value',
        docsUrl: VARIABLES_DOCS,
      });
    }
  },
});

export const localEnvNoDefault = rule({
  id: "semantic/local-env-no-default",
  description: "${localEnv:X} with no default silently becomes empty",
  explain: `If the host doesn't have the variable set, \${localEnv:NAME} becomes an empty
string with no warning. A path or a token built from it quietly turns into something
else on a teammate's machine, or in CI.

    { "containerEnv": { "API_URL": "\${localEnv:API_URL}" } }

Add a default after a second colon, \${localEnv:API_URL:http://localhost:8080}, if an
empty value would be wrong.`,
  defaultSeverity: "info",
  check({ doc, report }) {
    for (const { s } of substitutions(doc)) {
      if ((s.scope !== "localEnv" && s.scope !== "env") || !s.name || s.default !== undefined)
        continue;
      report({
        range: s.range,
        message: `\${${s.scope}:${s.name}} is empty when ${s.name} isn't set on the host`,
        help: `add a default: \${${s.scope}:${s.name}:value}`,
        docsUrl: VARIABLES_DOCS,
      });
    }
  },
});

export const workspaceMountWithoutFolder = rule({
  id: "semantic/workspace-mount-without-folder",
  description: '"workspaceMount" requires "workspaceFolder"',
  explain: `"workspaceMount" replaces the default mount of your source code, which
means the dev container CLI no longer knows where in the container the code is. Without
"workspaceFolder" saying so, the editor opens the wrong folder.

    { "image": "node:22", "workspaceMount": "source=\${localWorkspaceFolder},target=/src,type=bind" }

Add "workspaceFolder" matching the mount's target, here "/src".`,
  defaultSeverity: "error",
  justification:
    "the spec requires workspaceFolder alongside workspaceMount; without it the editor doesn't know where the workspace is",
  check({ model, report }) {
    const mount = model.get("workspaceMount");
    if (!mount || model.properties.has("workspaceFolder")) return;
    report({
      range: keySpan(mount),
      message: '"workspaceMount" needs "workspaceFolder" to say where the workspace is mounted',
      help: 'add "workspaceFolder" with the mount\'s target path',
      docsUrl: `${REFERENCE}#image-specific`,
    });
  },
});

export const waitForUnreachable = rule({
  id: "semantic/wait-for-unreachable",
  description: '"waitFor" names a lifecycle command that is not defined',
  explain: `"waitFor" tells the editor which lifecycle command to wait for before it
connects. Naming one the config doesn't define means waiting on nothing, which usually
isn't what was intended. (A feature or the image's metadata can define lifecycle
commands too; if one does, this is a false positive you can suppress.)

    { "image": "node:22", "waitFor": "postCreateCommand", "onCreateCommand": "npm ci" }

Point "waitFor" at a command the config defines, or define the command.`,
  defaultSeverity: "warning",
  check({ model, report }) {
    const waitFor = model.string("waitFor");
    if (
      !waitFor ||
      !LIFECYCLE_PROPERTIES.includes(waitFor.value) ||
      model.properties.has(waitFor.value)
    )
      return;
    report({
      range: rangeOf(waitFor.node),
      message: `"waitFor" is "${waitFor.value}", which this config doesn't define`,
      help: `define "${waitFor.value}", or wait for one of the commands that is defined`,
      docsUrl: `${REFERENCE}#lifecycle-scripts`,
    });
  },
});

export const remoteUserNotContainerUser = rule({
  id: "semantic/remote-user-not-container-user",
  description: '"remoteUser" differs from "containerUser"; often intended, sometimes not',
  explain: `"containerUser" is the user the container's processes run as; "remoteUser"
is the user your editor's terminals and tools run as. Setting them differently is
sometimes deliberate (a root service with a non-root developer), but often one was
changed and the other forgotten, which leaves files owned by the wrong user.

    { "image": "node:22", "containerUser": "root", "remoteUser": "node" }

If it's deliberate, suppress this or turn the rule off. Otherwise make them match.`,
  defaultSeverity: "info",
  check({ model, report }) {
    const remote = model.string("remoteUser");
    const container = model.string("containerUser");
    if (!remote || !container || remote.value === container.value) return;
    report({
      range: keySpan(remote),
      message: `"remoteUser" is "${remote.value}" but "containerUser" is "${container.value}"`,
      help: "if that's deliberate, suppress this; otherwise make them match",
      related: [{ range: keySpan(container), message: `"containerUser" is set here` }],
    });
  },
});

export const updateRemoteUserUidNoop = rule({
  id: "semantic/update-remote-user-uid-noop",
  description: '"updateRemoteUserUID" set on a config where it cannot apply',
  explain: `"updateRemoteUserUID" changes the container user's UID to match yours on the
host, so bind-mounted files have the right owner. It does nothing when that user is
root, which always has UID 0.

    { "image": "node:22", "remoteUser": "root", "updateRemoteUserUID": true }

Remove the setting, or run as a non-root user.`,
  defaultSeverity: "info",
  check({ model, report }) {
    const update = model.boolean("updateRemoteUserUID");
    if (!update?.value) return;
    const user = model.string("remoteUser") ?? model.string("containerUser");
    if (user?.value !== "root" && user?.value !== "0") return;
    report({
      range: keySpan(update),
      message: `"updateRemoteUserUID" has no effect when the user is root`,
      help: "remove it, or run as a non-root user",
    });
  },
});

/** The names a Dockerfile declares with `ARG`, global or per stage. */
function declaredArgs(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*ARG\s+(.*)$/i.exec(line);
    if (!m) continue;
    for (const token of m[1]!.trim().split(/\s+/)) {
      const name = token.split("=", 1)[0]!;
      if (name && !name.startsWith("#")) names.add(name);
      if (token.startsWith("#")) break;
    }
  }
  return names;
}

export const buildArgNotDeclared = rule({
  id: "semantic/build-arg-not-declared",
  description: 'A "build.args" key has no matching ARG in the referenced Dockerfile',
  explain: `Docker only passes a build argument into the build if the Dockerfile declares
it with ARG. Otherwise the value is silently discarded (Docker prints a warning nobody
reads), and the build runs with the Dockerfile's default.

    // Dockerfile: ARG NODE_VERSION=20
    { "build": { "dockerfile": "Dockerfile", "args": { "NODE_VERISON": "22" } } }

Fix the name, or add an ARG for it to the Dockerfile. This is the only check dcx makes
against a Dockerfile, and it's skipped if the Dockerfile can't be read.`,
  defaultSeverity: "warning",
  async check({ model, fs, root, dir, report }) {
    const build = model.build;
    if (!build?.args || !build.dockerfile) return;
    const text = await readInside(fs, root, dir, build.dockerfile.value);
    // the fs/* rules say why; nothing to compare against here
    if (text === undefined) return;
    const declared = declaredArgs(text);
    for (const { name, field } of members(build.args.node)) {
      if (declared.has(name)) continue;
      const guess = suggest(name, declared);
      report({
        range: keySpan(field),
        message: `Build arg "${name}" isn't declared with ARG in ${build.dockerfile.value}, so it's ignored${guess ? `; did you mean "${guess}"?` : ""}`,
        help: `add "ARG ${name}" to the Dockerfile, or fix the name`,
      });
    }
  },
});
