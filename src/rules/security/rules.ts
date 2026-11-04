import { rangeOf } from "../../jsonc/jsonc";
import { elements, isString, member, members, type Field } from "../../model/model";
import type { Pass } from "../rule";
import { REFERENCE, rule } from "../util";
import { mountEntries } from "../mount/mounts";
import { parseRunArgs } from "./run-args";
import { looksLikeSecret } from "./secrets";

const DOCS = `${REFERENCE}#image-or-dockerfile-specific-properties`;

const strings = (pass: Pass, name: string): Field<string>[] => {
  const f = pass.model.array(name);
  return f ? elements(f.node).filter(isString) : [];
};

const runArgs = (pass: Pass) => {
  const f = pass.model.array("runArgs");
  if (!f) return [];
  const els = elements(f.node);
  return parseRunArgs(els.map((e) => e.value)).map((a) => ({ ...a, field: els[a.index]! }));
};

const isSysAdmin = (cap: string) => /^(?:CAP_)?SYS_ADMIN$/i.test(cap.trim());
const isUnconfined = (opt: string) => /^seccomp[=:]unconfined$/i.test(opt.trim());

export const privileged = rule({
  id: "security/privileged",
  description: '"privileged": true grants near-host access',
  explain: `A privileged container gets every capability and every host device, and can
undo most of the isolation a container normally gives. Anything that runs inside it
(an extension, a postinstall script) has close to root on the host.

    "privileged": true

Usually what's needed is narrower: one capability through "capAdd", or a device
through "runArgs". If it really is needed (Docker-in-Docker, some debuggers), suppress
this with a reason.`,
  defaultSeverity: "warning",
  check(pass) {
    const f = pass.model.boolean("privileged");
    if (f?.value !== true) return;
    pass.report({
      range: rangeOf(f.key ?? f.node),
      message: "This container runs privileged, with near-host access",
      help: 'grant only what is needed with "capAdd", or suppress with a reason',
      docsUrl: DOCS,
    });
  },
});

export const dockerSocketMount = rule({
  id: "security/docker-socket-mount",
  description: 'Mounting "/var/run/docker.sock" is effectively host root',
  explain: `Whoever can talk to the Docker socket can start a privileged container with
the host's filesystem mounted, so mounting it into the dev container hands everything
inside it root on the host.

    "mounts": ["source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"]

The docker-outside-of-docker feature does this deliberately; if that's the intent,
suppress with a reason. Docker-in-Docker avoids it.`,
  defaultSeverity: "warning",
  check(pass) {
    const isSocket = (s: string | undefined) => !!s && /(?:^|\/)docker\.sock$/.test(s.trim());
    for (const m of mountEntries(pass)) {
      if (!isSocket(m.mount.source)) continue;
      pass.report({
        range: rangeOf(m.field.node),
        message: "Mounting the Docker socket gives the container root on the host",
        help: "use the docker-in-docker feature instead, or suppress with a reason",
        docsUrl: DOCS,
      });
    }
    for (const a of runArgs(pass)) {
      if (
        (a.flag === "-v" || a.flag === "--volume" || a.flag === "--mount") &&
        a.value &&
        /docker\.sock/.test(a.value)
      )
        pass.report({
          range: rangeOf(a.field.node),
          message: "Mounting the Docker socket gives the container root on the host",
          help: "use the docker-in-docker feature instead, or suppress with a reason",
          docsUrl: DOCS,
        });
    }
  },
});

export const capAddSysAdmin = rule({
  id: "security/cap-add-sys-admin",
  description: '"SYS_ADMIN" is close to full privilege',
  explain: `CAP_SYS_ADMIN covers so much (mounting filesystems, namespaces, many ioctls)
that it's close to running privileged; plenty of container escapes start from it.

    "capAdd": ["SYS_ADMIN"]

Find the narrower capability the tool needs (SYS_PTRACE for a debugger, NET_ADMIN for
networking), or suppress with a reason.`,
  defaultSeverity: "warning",
  check(pass) {
    for (const cap of strings(pass, "capAdd")) {
      if (!isSysAdmin(cap.value)) continue;
      pass.report({
        range: rangeOf(cap.node),
        message: "SYS_ADMIN is close to full privilege",
        help: "add the narrowest capability that works",
        docsUrl: DOCS,
      });
    }
  },
});

export const seccompUnconfined = rule({
  id: "security/seccomp-unconfined",
  description: '"seccomp=unconfined" disables syscall filtering',
  explain: `Docker's default seccomp profile blocks a few dozen dangerous syscalls.
"seccomp=unconfined" turns that off for everything in the container.

    "securityOpt": ["seccomp=unconfined"]

Debuggers sometimes need it (ptrace on older kernels); "capAdd": ["SYS_PTRACE"] is often
enough on its own. If not, suppress with a reason.`,
  defaultSeverity: "warning",
  check(pass) {
    for (const opt of strings(pass, "securityOpt")) {
      if (!isUnconfined(opt.value)) continue;
      pass.report({
        range: rangeOf(opt.node),
        message: "seccomp=unconfined disables syscall filtering",
        help: 'try "capAdd": ["SYS_PTRACE"] instead',
        docsUrl: DOCS,
      });
    }
  },
});

export const privilegedRunArgs = rule({
  id: "security/privileged-run-args",
  description: 'Privileges passed through "runArgs"',
  explain: `"runArgs" goes straight to "docker run", so it can grant everything the
dedicated properties can, out of sight of anyone reading them:

    "runArgs": ["--privileged"]                         // same as "privileged": true
    "runArgs": ["--cap-add=SYS_ADMIN"]                  // same as "capAdd"
    "runArgs": ["--security-opt", "seccomp=unconfined"]
    "runArgs": ["--pid=host"]                           // sees every host process

Use the dedicated property, where one exists, so the grant is visible; or suppress
with a reason.`,
  defaultSeverity: "warning",
  check(pass) {
    for (const a of runArgs(pass)) {
      const v = a.value ?? "";
      let message: string | undefined;
      if (a.flag === "--privileged")
        message = '"--privileged" in "runArgs" runs the container privileged';
      else if (a.flag === "--cap-add")
        message = `"--cap-add ${v}" in "runArgs" adds a capability out of sight of "capAdd"`;
      else if (a.flag === "--security-opt" && /unconfined/i.test(v))
        message = `"--security-opt ${v}" in "runArgs" turns off a protection`;
      else if (
        (a.flag === "--pid" || a.flag === "--ipc" || a.flag === "--userns" || a.flag === "--uts") &&
        v === "host"
      )
        message = `"${a.flag}=host" in "runArgs" shares the host's namespace`;
      if (!message) continue;
      pass.report({
        range: rangeOf(a.field.node),
        message,
        help: 'use "privileged", "capAdd" or "securityOpt" so it shows, or suppress with a reason',
        docsUrl: DOCS,
      });
    }
  },
});

export const hardcodedSecret = rule({
  id: "security/hardcoded-secret",
  description: 'Credential-shaped literal in "containerEnv", "remoteEnv", or "build.args"',
  explain: `devcontainer.json is committed, so a token written into it is a leaked
token. Pass credentials in from the host environment instead; the value is then read
when the container starts and never lands in the repository.

    "containerEnv": { "GITHUB_TOKEN": "ghp_..." }                       // leaked
    "containerEnv": { "GITHUB_TOKEN": "${"$"}{localEnv:GITHUB_TOKEN}" }      // read from the host

If a value was ever committed, rotate it: removing it from the file doesn't remove it
from history.`,
  defaultSeverity: "error",
  justification:
    "a committed credential is a leak the moment it's pushed; the corpus test holds it to zero findings on real configs",
  check(pass) {
    const scan = (obj: Field<unknown> | undefined, where: string) => {
      if (!obj || obj.node.type !== "object") return;
      for (const { name: key, field } of members(obj.node)) {
        if (typeof field.value !== "string") continue;
        const what = looksLikeSecret(key, field.value);
        if (!what) continue;
        pass.report({
          range: rangeOf(field.node),
          message: `"${where}.${key}" looks like ${what}, committed in plain text`,
          help: `use "${"$"}{localEnv:${key}}" to pass it in from the host, and rotate it if it was ever committed`,
          docsUrl: `${REFERENCE}#variables-in-devcontainerjson`,
        });
      }
    };
    scan(pass.model.get("containerEnv"), "containerEnv");
    scan(pass.model.get("remoteEnv"), "remoteEnv");
    const build = pass.model.get("build");
    scan(build?.node.type === "object" ? member(build.node, "args") : undefined, "build.args");
  },
});
