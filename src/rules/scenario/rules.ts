import { definitionKeys } from "../../schema/generated/devContainer.scenarios.validator.js";
import { readServices } from "../../model/compose";
import { readInside } from "../fs/resolve";
import { keySpan, type Field } from "../../model/model";
import { rangeOf } from "../../jsonc/jsonc";
import { suggest } from "../../schema/suggest";
import { REFERENCE, rule } from "../util";

const COMPOSE_DOCS = `${REFERENCE}#compose-specific`;
const SOURCES = ["image", "build", "dockerFile", "dockerComposeFile"];
const NON_COMPOSE_ONLY = definitionKeys.nonCompose.filter(
  (k) => !definitionKeys.compose.includes(k),
);

/** The source's property name as written: `build` for `build.dockerfile`. */
function sourceName(f: Field<unknown>): string {
  const key = f.key?.value as string;
  return key === "dockerfile" ? "build" : key;
}

const WHY: Record<string, string> = {
  dockerComposeFile: "a Compose configuration takes its image from the Compose file",
  build: "a Dockerfile configuration builds its own image",
  dockerFile: "a Dockerfile configuration builds its own image",
};

export const noContainerSource = rule({
  id: "scenario/no-container-source",
  description: 'None of "image", "build.dockerfile", "dockerComposeFile" present',
  explain: `A dev container needs something to run: an image to pull, a Dockerfile to
build, or a Docker Compose file. This config has none of them, so there's nothing for the
dev container CLI to start.

    { "name": "app", "forwardPorts": [3000] }

Add one of "image", "build": { "dockerfile": ... }, or "dockerComposeFile" (with
"service" and "workspaceFolder").`,
  defaultSeverity: "error",
  justification: "with no image, Dockerfile or Compose file there's nothing for the CLI to start",
  check({ model, doc, report }) {
    if (!doc.root || SOURCES.some((k) => model.properties.has(k))) return;
    report({
      range: { start: doc.root.offset, end: doc.root.offset + 1 },
      message: 'Nothing to run: set "image", "build" or "dockerComposeFile"',
      docsUrl: REFERENCE,
    });
  },
});

export const conflictingSource = rule({
  id: "scenario/conflicting-source",
  description: "More than one container source declared",
  explain: `A config describes one kind of container: an image, a Dockerfile build, or a
Docker Compose service. With more than one set, only one is used and the others are
ignored, so the container isn't the one the config seems to describe.

    {
      "dockerComposeFile": "compose.yml",
      "service": "app",
      "image": "node:22"          // ignored: Compose decides the image
    }

Keep the source you mean and delete the others. With Compose, set the image in the
Compose file.`,
  defaultSeverity: "error",
  justification:
    "the CLI picks one source and ignores the rest, so the config doesn't describe what runs",
  check({ model, report }) {
    if (model.scenario.kind !== "ambiguous") return;
    const keyOf = (f: Field<unknown>) =>
      rangeOf(sourceName(f) === "build" ? model.get("build")!.key! : f.key!);
    // the one that wins, the way the dev container CLI decides: Compose, then build, then image
    const sources = model.scenario.sources;
    const rank = (f: Field<unknown>) =>
      ["dockerComposeFile", "build", "dockerFile", "image"].indexOf(sourceName(f));
    const winner = [...sources].sort((a, b) => rank(a) - rank(b))[0]!;
    const w = sourceName(winner);
    for (const loser of sources) {
      if (loser === winner) continue;
      const l = sourceName(loser);
      report({
        range: keyOf(loser),
        message: `"${l}" and "${w}" cannot both be set: ${WHY[w]}`,
        help: `remove "${l}"`,
        docsUrl: REFERENCE,
        related: [{ range: keyOf(winner), message: `"${w}" is set here` }],
      });
    }
  },
});

export const composeMissingService = rule({
  id: "scenario/compose-missing-service",
  description: '"dockerComposeFile" without "service"',
  explain: `A Compose file can define many services, and the dev container CLI needs to
know which one to attach to. Without "service" it can't start.

    { "dockerComposeFile": "compose.yml", "workspaceFolder": "/workspace" }

Add "service" naming the Compose service your editor should run in.`,
  defaultSeverity: "error",
  justification: "the CLI can't tell which service to attach to and fails",
  check({ model, report }) {
    const file = model.get("dockerComposeFile");
    if (!file || model.properties.has("service")) return;
    report({
      range: keySpan(file),
      message: 'A Compose config needs "service": the Compose service to attach to',
      help: 'add "service" naming one of the services in the Compose file',
      docsUrl: COMPOSE_DOCS,
    });
  },
});

export const composeMissingWorkspaceFolder = rule({
  id: "scenario/compose-missing-workspace-folder",
  description: 'Compose config without "workspaceFolder" opens at "/"',
  explain: `With a single container, the dev container CLI mounts the workspace and
knows where it is. With Compose, the mount is the Compose file's business, so the config
has to say where in the container the source code ends up; without it, the editor
opens at "/".

    { "dockerComposeFile": "compose.yml", "service": "app" }

Add "workspaceFolder" with the path your Compose file mounts the workspace at, for
example "/workspace".`,
  defaultSeverity: "warning",
  check({ model, report }) {
    const file = model.get("dockerComposeFile");
    if (!file || model.properties.has("workspaceFolder")) return;
    report({
      range: keySpan(file),
      message: 'Without "workspaceFolder", a Compose config opens at "/"',
      help: 'add "workspaceFolder", e.g. "/workspace"',
      docsUrl: COMPOSE_DOCS,
    });
  },
});

export const composeServiceNotFound = rule({
  id: "scenario/compose-service-not-found",
  description: '"service" names a service absent from the Compose file',
  explain: `"service" has to name a service one of the Compose files defines. If it
doesn't, the dev container CLI fails when it tries to attach. dcx reads only the service
names from the Compose files (no interpolation, no "extends"), and skips the check when
a file can't be read reliably.

    // compose.yml defines "web" and "db"
    { "dockerComposeFile": "compose.yml", "service": "api", "workspaceFolder": "/w" }

Change "service" to one of the defined services, or add the service to the Compose file.`,
  defaultSeverity: "error",
  justification: "the CLI fails when it tries to attach to the service",
  async check({ model, fs, root, dir, report }) {
    const service = model.string("service");
    if (!service || !model.composeFiles.length) return;
    const names = await readServices(
      (f) => readInside(fs, root, dir, f),
      model.composeFiles.map((f) => f.value),
    );
    // undefined: a file couldn't be read or parsed reliably, so skip rather than guess
    if (!names || names.includes(service.value)) return;
    const guess = suggest(service.value, names);
    report({
      range: rangeOf(service.node),
      message: `No service "${service.value}" in ${model.composeFiles.map((f) => f.value).join(", ")}${guess ? `; did you mean "${guess}"?` : ""}`,
      help: names.length
        ? `defined services: ${names.join(", ")}`
        : "the Compose file defines no services",
      docsUrl: COMPOSE_DOCS,
    });
  },
});

export const nonComposeProperty = rule({
  id: "scenario/non-compose-property",
  description: '"runArgs", "appPort" and "workspaceMount" are ignored under Compose',
  explain: `Some properties only apply when the dev container CLI runs the container
itself. Under Compose, the Compose file decides how the container runs, so these are
silently ignored.

    {
      "dockerComposeFile": "compose.yml", "service": "app", "workspaceFolder": "/w",
      "runArgs": ["--cap-add=SYS_PTRACE"]   // ignored
    }

Move the setting into the Compose file (cap_add, ports, volumes), or delete it.`,
  defaultSeverity: "warning",
  check({ model, report }) {
    if (!model.properties.has("dockerComposeFile")) return;
    for (const name of NON_COMPOSE_ONLY) {
      const f = model.get(name);
      if (!f) continue;
      report({
        range: keySpan(f),
        message: `"${name}" is ignored in a Compose config`,
        help: "set it in the Compose file instead",
        docsUrl: COMPOSE_DOCS,
      });
    }
  },
});

export const shutdownActionMismatch = rule({
  id: "scenario/shutdown-action-mismatch",
  description: '"stopCompose" without Compose, or "stopContainer" with it',
  explain: `"shutdownAction" takes different values depending on the kind of config:
"none" or "stopContainer" for a single container, "none" or "stopCompose" for Compose.
The other kind's value isn't valid here.

    { "image": "node:22", "shutdownAction": "stopCompose" }

Use "stopContainer" for a single container and "stopCompose" with Compose.`,
  defaultSeverity: "error",
  justification: "the CLI rejects a shutdownAction that doesn't apply to the config's kind",
  check({ model, report }) {
    const action = model.string("shutdownAction");
    if (!action) return;
    const compose = model.properties.has("dockerComposeFile");
    const wrong = compose ? "stopContainer" : "stopCompose";
    if (action.value !== wrong) return;
    const right = compose ? "stopCompose" : "stopContainer";
    report({
      range: rangeOf(action.node),
      message: `"${wrong}" only applies to ${compose ? "a single-container" : "a Compose"} config; use "${right}"`,
      help: `change it to "${right}" or "none"`,
      docsUrl: REFERENCE,
    });
  },
});
