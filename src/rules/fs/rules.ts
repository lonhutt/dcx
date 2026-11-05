import { relative } from "node:path";
import { rangeOf } from "../../jsonc/jsonc";
import { members, type Field } from "../../model/model";
import type { Pass } from "../rule";
import { REFERENCE, rule } from "../util";
import { resolveRef } from "./resolve";

type Ref = { field: Field<string>; what: string; want: "file" | "directory" };

/** Every path the config refers to, and what kind of thing should be there. */
function references(pass: Pass): Ref[] {
  const out: Ref[] = [];
  const build = pass.model.build;
  if (build?.dockerfile) out.push({ field: build.dockerfile, what: "Dockerfile", want: "file" });
  if (build?.context) out.push({ field: build.context, what: "build context", want: "directory" });
  for (const f of pass.model.composeFiles)
    out.push({ field: f, what: "Compose file", want: "file" });
  for (const f of localFeatures(pass))
    out.push({ field: f, what: "local feature", want: "directory" });
  return out;
}

/** Feature keys that are relative paths: `./feature` or `../feature`. */
function localFeatures(pass: Pass): Field<string>[] {
  const features = pass.model.object("features");
  if (!features) return [];
  return members(features.node).flatMap(({ name, field }) => {
    const key = field.key!;
    return name.startsWith("./") || name.startsWith("../")
      ? [{ value: name, node: key, key } satisfies Field<string>]
      : [];
  });
}

/** A rule that reports references of `what` which don't resolve to the right kind of thing. */
function notFound(id: string, what: string, description: string, explain: string) {
  return rule({
    id,
    description,
    explain,
    defaultSeverity: "error",
    justification: "the build fails on a path that isn't there, before anything runs",
    async check(pass) {
      for (const ref of references(pass).filter((r) => r.what === what)) {
        const r = await resolveRef(pass.fs, pass.root, pass.dir, ref.field.value);
        if (r.escapes) continue; // fs/path-escapes-workspace's finding, and nothing was read
        const shown = relative(pass.dir, r.path) || ".";
        let message: string | undefined;
        if (r.error) message = `Can't resolve ${what} "${ref.field.value}": ${r.error}`;
        else if (!r.kind) message = `${cap(what)} "${ref.field.value}" doesn't exist`;
        else if (r.kind !== ref.want)
          message = `${cap(what)} "${ref.field.value}" is a ${r.kind === "directory" ? "directory" : "file"}, not a ${ref.want}`;
        if (!message) continue;
        report(
          pass,
          ref,
          message,
          `paths are relative to the folder holding devcontainer.json (resolved to ${shown})`,
        );
      }
    },
  });
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function report(pass: Pass, ref: Ref, message: string, help: string) {
  pass.report({ range: rangeOf(ref.field.node), message, help, docsUrl: REFERENCE });
}

export const dockerfileNotFound = notFound(
  "fs/dockerfile-not-found",
  "Dockerfile",
  '"build.dockerfile" does not resolve',
  `The Dockerfile the config names doesn't exist, so the build fails before it starts.
The path is relative to the folder holding devcontainer.json, not the workspace root;
for a config in .devcontainer/, a Dockerfile at the root is "../Dockerfile".

    { "build": { "dockerfile": "Dockerfile" } }   // looks in .devcontainer/

Fix the path, or create the file.`,
);

export const contextNotFound = notFound(
  "fs/context-not-found",
  "build context",
  '"build.context" does not resolve',
  `The build context is the folder Docker sends to the build; COPY and ADD read from
it. If it doesn't exist, the build fails. Like the Dockerfile path, it's relative to the
folder holding devcontainer.json.

    { "build": { "dockerfile": "Dockerfile", "context": "../app" } }

Fix the path. ".." is the usual context for a config in .devcontainer/.`,
);

export const composeFileNotFound = notFound(
  "fs/compose-file-not-found",
  "Compose file",
  'A "dockerComposeFile" entry does not resolve',
  `One of the Compose files the config lists doesn't exist, and docker compose fails
when given a missing file. Paths are relative to the folder holding devcontainer.json.

    { "dockerComposeFile": ["../compose.yml", "compose.dev.yml"], "service": "app" }

Fix the path, or remove the entry.`,
);

export const localFeatureNotFound = notFound(
  "fs/local-feature-not-found",
  "local feature",
  "A ./-relative feature path does not resolve",
  `A feature given as a relative path ("./my-feature") is a folder holding
devcontainer-feature.json and install.sh, next to devcontainer.json. If the folder isn't
there, the build fails when it tries to install the feature.

    { "image": "node:22", "features": { "./tools": {} } }

Fix the path, or add the feature's folder.`,
);

export const pathEscapesWorkspace = rule({
  id: "fs/path-escapes-workspace",
  description: "A referenced path traverses above the project root",
  explain: `A path in the config leads outside the workspace: through "../.." or an
absolute path, or through a symlink that points elsewhere. The build then depends on
files that aren't in the repository, so it works on one machine and not another; in a
repository you didn't write, it can also be a way to read files you didn't expect.

    { "build": { "dockerfile": "../../shared/Dockerfile" } }

Keep everything the container needs inside the repository. dcx doesn't read anything
outside the workspace, so the other fs rules skip these paths.`,
  defaultSeverity: "warning",
  async check(pass) {
    for (const ref of references(pass)) {
      const r = await resolveRef(pass.fs, pass.root, pass.dir, ref.field.value);
      if (!r.escapes) continue;
      report(
        pass,
        ref,
        `${cap(ref.what)} "${ref.field.value}" is outside the workspace`,
        "keep everything the container needs inside the repository",
      );
    }
  },
});
