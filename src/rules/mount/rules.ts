import { rangeOf } from "../../jsonc/jsonc";
import { normalisedTarget } from "../../model/mount";
import { REFERENCE, rule } from "../util";
import { mountEntries, substituted } from "./mounts";

const DOCS = `${REFERENCE}#general-properties`;

export const invalidStringSyntax = rule({
  id: "mount/invalid-string-syntax",
  description: 'String-form mount is not valid "key=value,…"',
  explain: `A string mount uses Docker's --mount syntax: comma-separated key=value
pairs, with "type", "source" (or "src") and "target" (or "destination", "dst"). Docker
rejects an unknown key or a key with no value, and the container fails to start.

    "mounts": ["type=bind,src=${"$"}{localWorkspaceFolder}/.cache,dst=/cache"]   // fine
    "mounts": ["type=bind,source:/tmp,target=/tmp"]                         // ":" isn't "="

A comma inside a value needs quotes or a backslash.`,
  defaultSeverity: "error",
  justification: "Docker rejects the --mount argument and the container doesn't start",
  check(pass) {
    for (const m of mountEntries(pass)) {
      if (!m.problems.length) continue;
      const p = m.problems[0]!;
      pass.report({
        range: rangeOf(m.field.node),
        message: `Mount part "${p.part.trim()}" ${p.reason}${m.problems.length > 1 ? ` (and ${m.problems.length - 1} more)` : ""}`,
        help: 'write it as "type=…,source=…,target=…"',
        docsUrl: "https://docs.docker.com/engine/storage/bind-mounts/#options-for---mount",
      });
    }
  },
});

export const missingTarget = rule({
  id: "mount/missing-target",
  description: "Mount has no target",
  explain: `Every mount needs to know where in the container it goes: "target" (or
"destination", "dst"). Without one, Docker refuses to create the container.

    "mounts": [{ "type": "volume", "source": "cache" }]                       // no target
    "mounts": [{ "type": "volume", "source": "cache", "target": "/cache" }]`,
  defaultSeverity: "error",
  justification: "Docker rejects a mount with no target and the container doesn't start",
  check(pass) {
    for (const m of mountEntries(pass)) {
      if (m.mount.target?.trim()) continue;
      pass.report({
        range: rangeOf(m.field.node),
        message: "This mount has no target in the container",
        help: 'add "target", the path inside the container',
        docsUrl: DOCS,
      });
    }
  },
});

export const duplicateTarget = rule({
  id: "mount/duplicate-target",
  description: "Two mounts target the same path",
  explain: `Two mounts at the same container path can't both be there; Docker refuses
"Duplicate mount point" and the container doesn't start. Paths are compared normalised,
so "/data/" and "/data" collide.

    "mounts": [
      "type=volume,source=a,target=/data",
      "type=volume,source=b,target=/data/"
    ]`,
  defaultSeverity: "error",
  justification: "Docker refuses to create the container with two mounts on one path",
  check(pass) {
    const seen = new Map<string, ReturnType<typeof mountEntries>[number]>();
    for (const m of mountEntries(pass)) {
      const target = m.mount.target?.trim();
      if (!target || substituted(target)) continue;
      const key = normalisedTarget(target);
      const first = seen.get(key);
      if (!first) {
        seen.set(key, m);
        continue;
      }
      pass.report({
        range: rangeOf(m.field.node),
        message: `Another mount already targets "${key}"`,
        help: "give each mount its own target",
        related: [{ range: rangeOf(first.field.node), message: "first mounted here" }],
        docsUrl: DOCS,
      });
    }
  },
});

/** Host paths that are the same on every machine, so not machine-specific. */
const SYSTEM = [
  "/var/run/",
  "/run/",
  "/dev/",
  "/tmp/",
  "/etc/",
  "/sys/",
  "/proc/",
  "/usr/share/",
  "/var/lib/docker",
];

export const absoluteHostPath = rule({
  id: "mount/absolute-host-path",
  description: "Bind source is a machine-specific absolute path",
  explain: `A bind mount from an absolute host path like /home/alice/src only exists on
one machine; for everyone else the container fails to start or mounts an empty folder.
Use a path relative to the workspace through a variable instead.

    "mounts": ["type=bind,source=/home/alice/.aws,target=/root/.aws"]                 // only Alice
    "mounts": ["type=bind,source=${"$"}{localEnv:HOME}/.aws,target=/root/.aws"]        // anyone

System paths that are the same everywhere (/var/run, /dev, /tmp, ...) are fine.`,
  defaultSeverity: "warning",
  check(pass) {
    for (const m of mountEntries(pass)) {
      const source = m.mount.source;
      if (m.mount.type !== "bind" || !source || substituted(source)) continue;
      const absolute =
        source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("~");
      if (!absolute || SYSTEM.some((p) => source === p.replace(/\/$/, "") || source.startsWith(p)))
        continue;
      pass.report({
        range: rangeOf(m.field.node),
        message: `Bind source "${source}" is a path on one particular machine`,
        help: "use ${localWorkspaceFolder} or ${localEnv:HOME} instead of a fixed path",
        docsUrl: `${REFERENCE}#variables-in-devcontainerjson`,
      });
    }
  },
});
