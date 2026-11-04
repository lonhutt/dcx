# dcx rules

Generated from the rule registry by `bun scripts/rules-doc.ts`; don't edit by hand.

72 rules. Rules marked 🌐 only run with `--online`; ✎ means `--fix` can fix it.
Change a rule's severity in `.dcx.yaml` (`rules: { <id>: off }`), or for one line with
`// dcx-disable-next-line <id> -- <reason>`.

## syntax

| Rule | Default | Description |
| --- | --- | --- |
| [`syntax/duplicate-key`](#syntaxduplicate-key) | error | Key appears twice; later value silently wins |
| [`syntax/parse-error`](#syntaxparse-error) | error | Malformed JSONC |
| [`syntax/trailing-comma`](#syntaxtrailing-comma) | off | Legal per spec, but some third-party parsers reject it |

### syntax/duplicate-key

A key that appears twice in the same object is legal JSON, but only the last
value counts; the first is silently thrown away. That's almost always a merge accident or
a copy-paste, and the value someone is editing may be the one that's ignored.

    {
      "image": "node:20",
      "image": "node:22"   // this one wins
    }

Delete one of the two, keeping the value you meant. Keys are compared after decoding
escapes, so "a\u0062" and "ab" are the same key.

### syntax/parse-error

The file isn't valid JSONC (JSON with comments and trailing commas), so nothing
reading it can be sure what it says. The dev container CLI refuses to start, and every
other dcx rule is skipped until this is fixed, since checking a tree the parser had to
guess at mostly produces noise.

    { "image": "node:22" "name": "app" }   // missing comma

Fix the syntax at the reported spot. Comments and trailing commas are fine; a missing
comma, an unquoted key, or an unclosed brace isn't. A config must also be a JSON object
at the top level.

### syntax/trailing-comma

The dev container spec allows trailing commas, and VS Code and the dev
container CLI accept them. Some other tools that read devcontainer.json (a strict JSON
parser in a script, an older CI action) don't. Off by default; turn it on if a tool in
your pipeline chokes on them.

    { "forwardPorts": [3000, 8080,], }   // two trailing commas

Delete the comma before the closing bracket or brace.

## schema

| Rule | Default | Description |
| --- | --- | --- |
| [`schema/invalid-enum-value`](#schemainvalid-enum-value) | error | Value outside the allowed set; lists valid values |
| [`schema/missing-required`](#schemamissing-required) | error | A required property for the detected scenario is absent |
| [`schema/type-mismatch`](#schematype-mismatch) | error | Wrong JSON type for a known property |
| [`schema/unknown-property`](#schemaunknown-property) | warning | Property not in the spec; includes a spelling suggestion |

### schema/invalid-enum-value

The value isn't one the spec allows for this property: not one of a fixed
set of choices, or outside an allowed range. The message lists what's accepted.

    { "image": "node:22", "userEnvProbe": "bash" }

Pick one of the listed values.

### schema/missing-required

Something the spec requires is missing: a mount with no "target", a
"build" with no "dockerfile". The container can't be created from the config as written.

    { "build": { "context": ".." } }   // build needs a dockerfile

Add the property the message names.

### schema/type-mismatch

The property exists, but its value is the wrong JSON type: a string where
the spec wants an array, a number where it wants a string. Tools reject the config or
ignore the property.

    { "image": "node:22", "forwardPorts": "3000" }   // must be an array

Change the value to the type the message names.

### schema/unknown-property

The property isn't part of the dev container spec, or doesn't apply to this
kind of config, so whatever it was meant to do won't happen. Usually it's a typo, and
dcx suggests the property you probably meant.

    { "image": "node:22", "postCreateComand": "npm ci" }   // never runs

Rename it to the property you meant, or delete it. Settings for a particular editor or
tool belong under "customizations".

## scenario

| Rule | Default | Description |
| --- | --- | --- |
| [`scenario/compose-missing-service`](#scenariocompose-missing-service) | error | "dockerComposeFile" without "service" |
| [`scenario/compose-missing-workspace-folder`](#scenariocompose-missing-workspace-folder) | warning | Compose config without "workspaceFolder" opens at "/" |
| [`scenario/compose-service-not-found`](#scenariocompose-service-not-found) | error | "service" names a service absent from the Compose file |
| [`scenario/conflicting-source`](#scenarioconflicting-source) | error | More than one container source declared |
| [`scenario/no-container-source`](#scenariono-container-source) | error | None of "image", "build.dockerfile", "dockerComposeFile" present |
| [`scenario/non-compose-property`](#scenarionon-compose-property) | warning | "runArgs", "appPort" and "workspaceMount" are ignored under Compose |
| [`scenario/shutdown-action-mismatch`](#scenarioshutdown-action-mismatch) | error | "stopCompose" without Compose, or "stopContainer" with it |

### scenario/compose-missing-service

A Compose file can define many services, and the dev container CLI needs to
know which one to attach to. Without "service" it can't start.

    { "dockerComposeFile": "compose.yml", "workspaceFolder": "/workspace" }

Add "service" naming the Compose service your editor should run in.

### scenario/compose-missing-workspace-folder

With a single container, the dev container CLI mounts the workspace and
knows where it is. With Compose, the mount is the Compose file's business, so the config
has to say where in the container the source code ends up; without it, the editor
opens at "/".

    { "dockerComposeFile": "compose.yml", "service": "app" }

Add "workspaceFolder" with the path your Compose file mounts the workspace at, for
example "/workspace".

### scenario/compose-service-not-found

"service" has to name a service one of the Compose files defines. If it
doesn't, the dev container CLI fails when it tries to attach. dcx reads only the service
names from the Compose files (no interpolation, no "extends"), and skips the check when
a file can't be read reliably.

    // compose.yml defines "web" and "db"
    { "dockerComposeFile": "compose.yml", "service": "api", "workspaceFolder": "/w" }

Change "service" to one of the defined services, or add the service to the Compose file.

### scenario/conflicting-source

A config describes one kind of container: an image, a Dockerfile build, or a
Docker Compose service. With more than one set, only one is used and the others are
ignored, so the container isn't the one the config seems to describe.

    {
      "dockerComposeFile": "compose.yml",
      "service": "app",
      "image": "node:22"          // ignored: Compose decides the image
    }

Keep the source you mean and delete the others. With Compose, set the image in the
Compose file.

### scenario/no-container-source

A dev container needs something to run: an image to pull, a Dockerfile to
build, or a Docker Compose file. This config has none of them, so there's nothing for the
dev container CLI to start.

    { "name": "app", "forwardPorts": [3000] }

Add one of "image", "build": { "dockerfile": ... }, or "dockerComposeFile" (with
"service" and "workspaceFolder").

### scenario/non-compose-property

Some properties only apply when the dev container CLI runs the container
itself. Under Compose, the Compose file decides how the container runs, so these are
silently ignored.

    {
      "dockerComposeFile": "compose.yml", "service": "app", "workspaceFolder": "/w",
      "runArgs": ["--cap-add=SYS_PTRACE"]   // ignored
    }

Move the setting into the Compose file (cap_add, ports, volumes), or delete it.

### scenario/shutdown-action-mismatch

"shutdownAction" takes different values depending on the kind of config:
"none" or "stopContainer" for a single container, "none" or "stopCompose" for Compose.
The other kind's value isn't valid here.

    { "image": "node:22", "shutdownAction": "stopCompose" }

Use "stopContainer" for a single container and "stopCompose" with Compose.

## semantic

| Rule | Default | Description |
| --- | --- | --- |
| [`semantic/build-arg-not-declared`](#semanticbuild-arg-not-declared) | warning | A "build.args" key has no matching ARG in the referenced Dockerfile |
| [`semantic/invalid-substitution`](#semanticinvalid-substitution) | error | Unknown ${…} variable name |
| [`semantic/local-env-no-default`](#semanticlocal-env-no-default) | info | ${localEnv:X} with no default silently becomes empty |
| [`semantic/remote-user-not-container-user`](#semanticremote-user-not-container-user) | info | "remoteUser" differs from "containerUser"; often intended, sometimes not |
| [`semantic/substitution-scope`](#semanticsubstitution-scope) | warning | ${containerEnv:…} used outside remoteEnv |
| [`semantic/update-remote-user-uid-noop`](#semanticupdate-remote-user-uid-noop) | info | "updateRemoteUserUID" set on a config where it cannot apply |
| [`semantic/wait-for-unreachable`](#semanticwait-for-unreachable) | warning | "waitFor" names a lifecycle command that is not defined |
| [`semantic/workspace-mount-without-folder`](#semanticworkspace-mount-without-folder) | error | "workspaceMount" requires "workspaceFolder" |

### semantic/build-arg-not-declared

Docker only passes a build argument into the build if the Dockerfile declares
it with ARG. Otherwise the value is silently discarded (Docker prints a warning nobody
reads), and the build runs with the Dockerfile's default.

    // Dockerfile: ARG NODE_VERSION=20
    { "build": { "dockerfile": "Dockerfile", "args": { "NODE_VERISON": "22" } } }

Fix the name, or add an ARG for it to the Dockerfile. This is the only check dcx makes
against a Dockerfile, and it's skipped if the Dockerfile can't be read.

### semantic/invalid-substitution

devcontainer.json supports a fixed set of variables: ${localEnv:NAME},
${containerEnv:NAME}, ${localWorkspaceFolder}, ${containerWorkspaceFolder}, their
"Basename" forms, and ${devcontainerId}. Anything else that looks like one is left in
the string unchanged, so the container sees the literal text.

    { "workspaceFolder": "/workspaces/${localWorkspaceFolderName}" }   // not a variable

Use one of the supported variables. Shell-style references like ${HOME} in a command
are left to the shell and aren't reported.

### semantic/local-env-no-default

If the host doesn't have the variable set, ${localEnv:NAME} becomes an empty
string with no warning. A path or a token built from it quietly turns into something
else on a teammate's machine, or in CI.

    { "containerEnv": { "API_URL": "${localEnv:API_URL}" } }

Add a default after a second colon, ${localEnv:API_URL:http://localhost:8080}, if an
empty value would be wrong.

### semantic/remote-user-not-container-user

"containerUser" is the user the container's processes run as; "remoteUser"
is the user your editor's terminals and tools run as. Setting them differently is
sometimes deliberate (a root service with a non-root developer), but often one was
changed and the other forgotten, which leaves files owned by the wrong user.

    { "image": "node:22", "containerUser": "root", "remoteUser": "node" }

If it's deliberate, suppress this or turn the rule off. Otherwise make them match.

### semantic/substitution-scope

${containerEnv:NAME} reads an environment variable from the running
container, so it can only be resolved after the container starts. That makes it
meaningful in "remoteEnv", which is applied to processes your editor starts inside the
container, but not in properties used to create the container.

    { "containerEnv": { "PATH": "${containerEnv:PATH}:/opt/bin" } }   // not yet known

Move the setting to "remoteEnv", or use ${localEnv:NAME} if you meant the host's value.

### semantic/update-remote-user-uid-noop

"updateRemoteUserUID" changes the container user's UID to match yours on the
host, so bind-mounted files have the right owner. It does nothing when that user is
root, which always has UID 0.

    { "image": "node:22", "remoteUser": "root", "updateRemoteUserUID": true }

Remove the setting, or run as a non-root user.

### semantic/wait-for-unreachable

"waitFor" tells the editor which lifecycle command to wait for before it
connects. Naming one the config doesn't define means waiting on nothing, which usually
isn't what was intended. (A feature or the image's metadata can define lifecycle
commands too; if one does, this is a false positive you can suppress.)

    { "image": "node:22", "waitFor": "postCreateCommand", "onCreateCommand": "npm ci" }

Point "waitFor" at a command the config defines, or define the command.

### semantic/workspace-mount-without-folder

"workspaceMount" replaces the default mount of your source code, which
means the dev container CLI no longer knows where in the container the code is. Without
"workspaceFolder" saying so, the editor opens the wrong folder.

    { "image": "node:22", "workspaceMount": "source=${localWorkspaceFolder},target=/src,type=bind" }

Add "workspaceFolder" matching the mount's target, here "/src".

## fs

| Rule | Default | Description |
| --- | --- | --- |
| [`fs/compose-file-not-found`](#fscompose-file-not-found) | error | A "dockerComposeFile" entry does not resolve |
| [`fs/context-not-found`](#fscontext-not-found) | error | "build.context" does not resolve |
| [`fs/dockerfile-not-found`](#fsdockerfile-not-found) | error | "build.dockerfile" does not resolve |
| [`fs/local-feature-not-found`](#fslocal-feature-not-found) | error | A ./-relative feature path does not resolve |
| [`fs/path-escapes-workspace`](#fspath-escapes-workspace) | warning | A referenced path traverses above the project root |

### fs/compose-file-not-found

One of the Compose files the config lists doesn't exist, and docker compose fails
when given a missing file. Paths are relative to the folder holding devcontainer.json.

    { "dockerComposeFile": ["../compose.yml", "compose.dev.yml"], "service": "app" }

Fix the path, or remove the entry.

### fs/context-not-found

The build context is the folder Docker sends to the build; COPY and ADD read from
it. If it doesn't exist, the build fails. Like the Dockerfile path, it's relative to the
folder holding devcontainer.json.

    { "build": { "dockerfile": "Dockerfile", "context": "../app" } }

Fix the path. ".." is the usual context for a config in .devcontainer/.

### fs/dockerfile-not-found

The Dockerfile the config names doesn't exist, so the build fails before it starts.
The path is relative to the folder holding devcontainer.json, not the workspace root;
for a config in .devcontainer/, a Dockerfile at the root is "../Dockerfile".

    { "build": { "dockerfile": "Dockerfile" } }   // looks in .devcontainer/

Fix the path, or create the file.

### fs/local-feature-not-found

A feature given as a relative path ("./my-feature") is a folder holding
devcontainer-feature.json and install.sh, next to devcontainer.json. If the folder isn't
there, the build fails when it tries to install the feature.

    { "image": "node:22", "features": { "./tools": {} } }

Fix the path, or add the feature's folder.

### fs/path-escapes-workspace

A path in the config leads outside the workspace: through "../.." or an
absolute path, or through a symlink that points elsewhere. The build then depends on
files that aren't in the repository, so it works on one machine and not another; in a
repository you didn't write, it can also be a way to read files you didn't expect.

    { "build": { "dockerfile": "../../shared/Dockerfile" } }

Keep everything the container needs inside the repository. dcx doesn't read anything
outside the workspace, so the other fs rules skip these paths.

## deprecation

| Rule | Default | Description |
| --- | --- | --- |
| [`deprecation/app-port`](#deprecationapp-port) | warning | "appPort" superseded by "forwardPorts" |
| [`deprecation/legacy-feature-id`](#deprecationlegacy-feature-id) | warning | Feature uses a pre-registry short ID like "docker-in-docker" |
| [`deprecation/root-extensions`](#deprecationroot-extensions) ✎ | warning | Root "extensions" moved to "customizations.vscode.extensions" |
| [`deprecation/root-settings`](#deprecationroot-settings) ✎ | warning | Root "settings" moved to "customizations.vscode.settings" |
| [`deprecation/top-level-dockerfile`](#deprecationtop-level-dockerfile) ✎ | warning | Legacy "dockerFile"/"context" at root; use "build.*" |

### deprecation/app-port

"appPort" publishes a port the way "docker run -p" does: fixed at creation,
and only for a local Docker host. "forwardPorts" forwards the port through the editor,
which also works over a remote connection and in Codespaces, and can be changed without
rebuilding.

    { "image": "node:22", "appPort": [3000] }
    // becomes
    { "image": "node:22", "forwardPorts": [3000] }

There's no automatic fix: "appPort" also accepts "host:container" mappings that
"forwardPorts" doesn't, so check each entry by hand.

### deprecation/legacy-feature-id

Before features were published to OCI registries, they were referenced by a
bare short ID. The dev container CLI still maps the ones it knows to a published feature,
but that mapping is deprecated, picks the version for you, and unknown IDs fail.

    "features": { "docker-in-docker": {} }
    // becomes
    "features": { "ghcr.io/devcontainers/features/docker-in-docker:2": {} }

Some were renamed on the way ("docker-from-docker" is now "docker-outside-of-docker"),
so look the full reference up on containers.dev/features rather than guessing it.

### deprecation/root-extensions

Early devcontainer.json files listed VS Code extensions at the top level. The
spec now keeps each tool's settings under "customizations", so other editors don't have
to know VS Code's keys. Current tooling reads "customizations.vscode.extensions".

    { "image": "node:22", "extensions": ["dbaeumer.vscode-eslint"] }
    // becomes
    { "image": "node:22", "customizations": { "vscode": { "extensions": ["dbaeumer.vscode-eslint"] } } }

The fix moves the list, merging it with any extensions already listed there.

### deprecation/root-settings

Early devcontainer.json files put VS Code settings at the top level. The
spec now keeps each tool's settings under "customizations"; current tooling reads
"customizations.vscode.settings".

    { "image": "node:22", "settings": { "editor.tabSize": 2 } }
    // becomes
    { "image": "node:22", "customizations": { "vscode": { "settings": { "editor.tabSize": 2 } } } }

The fix moves the settings, keeping any already under "customizations.vscode.settings"
when the same setting is in both.

### deprecation/top-level-dockerfile

Top-level "dockerFile" and "context" are the original way to build from a
Dockerfile, and still work, but the spec has moved them under "build", which is also
where "args", "target" and "cacheFrom" live. Tools and docs assume the new form.

    { "dockerFile": "Dockerfile", "context": ".." }
    // becomes
    { "build": { "dockerfile": "Dockerfile", "context": ".." } }

The fix moves both properties under "build", merging into one that's already there
unless it sets the same keys. Note the lowercase "f" in "dockerfile".

## feature

| Rule | Default | Description |
| --- | --- | --- |
| [`feature/deprecated`](#featuredeprecated) 🌐 | warning | Feature is marked deprecated upstream |
| [`feature/duplicate`](#featureduplicate) | error | Same feature declared twice |
| [`feature/invalid-option-value`](#featureinvalid-option-value) 🌐 | error | Value outside the option's "enum", or of the wrong type |
| [`feature/invalid-reference`](#featureinvalid-reference) | error | Feature reference matches none of the three legal forms |
| [`feature/missing-dependency`](#featuremissing-dependency) 🌐 | warning | A "dependsOn" requirement can't be satisfied |
| [`feature/override-order-unknown`](#featureoverride-order-unknown) | warning | "overrideFeatureInstallOrder" lists a feature not in "features" |
| [`feature/unknown-option`](#featureunknown-option) 🌐 | error | Option not declared by the feature |
| [`feature/unpinned-version`](#featureunpinned-version) | warning | Feature reference has no tag, or uses ":latest" |

### feature/deprecated

The feature's authors have marked it deprecated: it may stop getting fixes,
or be removed from the registry, at which point builds fail. Its documentation usually
names the replacement.

Needs --online.

### feature/duplicate

The same feature listed twice, usually at two different versions, installs
once; which version and options win isn't obvious from the file.

    "features": {
      "ghcr.io/devcontainers/features/node:1": {},
      "ghcr.io/devcontainers/features/node:2": { "version": "20" }
    }

Keep one entry.

### feature/invalid-option-value

A feature option can restrict its value: a boolean option takes true or false,
and a string option with an "enum" takes only those strings. Anything else fails the
feature's install script, or gets silently replaced with the default.

    "ghcr.io/devcontainers/features/python:1": { "installTools": "yes" }   // a boolean option

Needs --online. "proposals" are only suggestions, so values outside them are fine.

### feature/invalid-reference

A "features" key has to be one of three things: an OCI reference
(registry/namespace/name, with an optional tag or digest), an https:// URL to a .tgz,
or a path starting "./" or "../" to a feature folder next to devcontainer.json.

    "features": {
      "ghcr.io/devcontainers/features/go:1": {},       // OCI
      "https://example.com/features/tool.tgz": {},     // tarball
      "./local-feature": {}                            // local
    }

Bare names like "docker-in-docker" are the pre-registry short IDs, which
deprecation/legacy-feature-id reports instead.

### feature/missing-dependency

A feature can depend on other features ("dependsOn"), which the dev
container CLI installs first. If a dependency doesn't exist in its registry (renamed,
removed, or a private registry this machine can't see), the build fails partway.

Needs --online. A dependency dcx couldn't reach is only reported as a warning on stderr,
since a flaky registry isn't the config's fault.

### feature/override-order-unknown

"overrideFeatureInstallOrder" names features, without their version, in the
order they should install. An entry that matches nothing in "features" does nothing,
and usually means a typo or a feature that was since removed.

    "features": { "ghcr.io/devcontainers/features/node:1": {} },
    "overrideFeatureInstallOrder": ["ghcr.io/devcontainers/features/nodejs"]   // no such feature

Fix the entry, or remove it.

### feature/unknown-option

Each feature declares the options it takes in its devcontainer-feature.json.
An option it doesn't declare is ignored, usually because of a typo or an option from
another version of the feature.

    "ghcr.io/devcontainers/features/node:1": { "verison": "20" }   // "version"

Needs --online: dcx fetches the feature's metadata to know its options.

### feature/unpinned-version

A feature referenced with no tag, or ":latest", installs whatever was
published most recently. A rebuild next month can get a different major version, and
two teammates can end up with different tools from the same config.

    "ghcr.io/devcontainers/features/node": {}      // unpinned
    "ghcr.io/devcontainers/features/node:1": {}    // pinned to major version 1

A major-version tag is usually enough; a digest pins exactly. Features you've decided to
track at latest can be listed under "features.allow-unpinned" in .dcx.yaml.

## port

| Rule | Default | Description |
| --- | --- | --- |
| [`port/attributes-orphan`](#portattributes-orphan) | info | "portsAttributes" entry for a port that is never forwarded |
| [`port/duplicate-forward`](#portduplicate-forward) | warning | Port listed twice in "forwardPorts" |
| [`port/invalid-attribute-key`](#portinvalid-attribute-key) | error | "portsAttributes" key is not a port, "host:port", range, or pattern |
| [`port/out-of-range`](#portout-of-range) | error | Port is not in 1–65535 |
| [`port/privileged-without-elevate`](#portprivileged-without-elevate) | info | Port below 1024 without "elevateIfNeeded" |

### port/attributes-orphan

Attributes for a port only matter once that port is forwarded. With an
explicit "forwardPorts" list, an attribute for a port missing from it applies only if
the editor happens to detect and auto-forward that port.

    "forwardPorts": [3000],
    "portsAttributes": { "8080": { "label": "admin" } }    // 8080 isn't forwarded

Add the port to "forwardPorts", or drop the attributes. This is informational: relying
on auto-forwarding is sometimes the intent.

### port/duplicate-forward

Each port only forwards once; listing it twice (3000 and "localhost:3000"
are the same port) does nothing extra, and usually means the list was edited in two
places.

    "forwardPorts": [3000, 5432, 3000]

Remove the repeat.

### port/invalid-attribute-key

Each "portsAttributes" key says which ports its settings apply to: a port
("3000"), a host and port ("db:5432"), a range ("40000-55000"), or a regular expression
matched against the port. A key that's none of those matches nothing, so its settings
never apply.

    "portsAttributes": {
      "3000": { "label": "app" },
      "web": { "label": "web" }      // not a port
    }

### port/out-of-range

TCP ports run from 1 to 65535; 0 means "any free port" to the OS, and nothing
above 65535 exists. A port outside that range can't be forwarded or published.

    "forwardPorts": [3000, 70000]          // 70000 isn't a port
    "portsAttributes": { "0": { ... } }    // nor is 0

Usually a typo; check the number.

### port/privileged-without-elevate

Ports below 1024 are privileged: on Linux and macOS, binding one on the host
side of a forward needs root. Without "elevateIfNeeded", the editor forwards it to a
different local port instead, and a URL hard-coded to the original port won't work.

    "forwardPorts": [80],
    "portsAttributes": { "80": { "elevateIfNeeded": true } }

## mount

| Rule | Default | Description |
| --- | --- | --- |
| [`mount/absolute-host-path`](#mountabsolute-host-path) | warning | Bind source is a machine-specific absolute path |
| [`mount/duplicate-target`](#mountduplicate-target) | error | Two mounts target the same path |
| [`mount/invalid-string-syntax`](#mountinvalid-string-syntax) | error | String-form mount is not valid "key=value,…" |
| [`mount/missing-target`](#mountmissing-target) | error | Mount has no target |

### mount/absolute-host-path

A bind mount from an absolute host path like /home/alice/src only exists on
one machine; for everyone else the container fails to start or mounts an empty folder.
Use a path relative to the workspace through a variable instead.

    "mounts": ["type=bind,source=/home/alice/.aws,target=/root/.aws"]                 // only Alice
    "mounts": ["type=bind,source=${localEnv:HOME}/.aws,target=/root/.aws"]        // anyone

System paths that are the same everywhere (/var/run, /dev, /tmp, ...) are fine.

### mount/duplicate-target

Two mounts at the same container path can't both be there; Docker refuses
"Duplicate mount point" and the container doesn't start. Paths are compared normalised,
so "/data/" and "/data" collide.

    "mounts": [
      "type=volume,source=a,target=/data",
      "type=volume,source=b,target=/data/"
    ]

### mount/invalid-string-syntax

A string mount uses Docker's --mount syntax: comma-separated key=value
pairs, with "type", "source" (or "src") and "target" (or "destination", "dst"). Docker
rejects an unknown key or a key with no value, and the container fails to start.

    "mounts": ["type=bind,src=${localWorkspaceFolder}/.cache,dst=/cache"]   // fine
    "mounts": ["type=bind,source:/tmp,target=/tmp"]                         // ":" isn't "="

A comma inside a value needs quotes or a backslash.

### mount/missing-target

Every mount needs to know where in the container it goes: "target" (or
"destination", "dst"). Without one, Docker refuses to create the container.

    "mounts": [{ "type": "volume", "source": "cache" }]                       // no target
    "mounts": [{ "type": "volume", "source": "cache", "target": "/cache" }]

## lifecycle

| Rule | Default | Description |
| --- | --- | --- |
| [`lifecycle/empty-command`](#lifecycleempty-command) | warning | Empty command |
| [`lifecycle/initialize-runs-on-host`](#lifecycleinitialize-runs-on-host) | info | "initializeCommand" executes on the host, not in the container |
| [`lifecycle/parallel-non-string-value`](#lifecycleparallel-non-string-value) | error | Object (parallel) form requires string or array values |
| [`lifecycle/shell-syntax-in-array-form`](#lifecycleshell-syntax-in-array-form) | warning | Array form bypasses the shell; "&&", "\|", ">" become literal arguments |

### lifecycle/empty-command

An empty lifecycle command does nothing; usually it's a placeholder left
behind, or a value that got deleted by mistake.

    "postCreateCommand": ""
    "postStartCommand": []

Remove the property, or put the command back.

### lifecycle/initialize-runs-on-host

"initializeCommand" is the one lifecycle command that runs on the host
machine, before the container exists. Container paths, container variables and the
container's package manager aren't available to it.

    "initializeCommand": "apt-get install -y jq"          // runs on your laptop
    "postCreateCommand": "apt-get install -y jq"          // runs in the container

Move container setup to "onCreateCommand" or "postCreateCommand".

### lifecycle/parallel-non-string-value

The object form runs several commands in parallel, one per key. Each value
is a command: a string, or an array of strings. Anything else (a number, a nested
object) isn't run.

    "postCreateCommand": {
      "deps": "npm install",
      "db": ["./scripts/db.sh", "--seed"],
      "bad": { "cmd": "make" }     // not a command
    }

### lifecycle/shell-syntax-in-array-form

The array form of a lifecycle command runs the program directly, with no
shell, so shell syntax in it isn't interpreted: "&&" is just an argument passed to the
first program.

    "postCreateCommand": ["npm", "install", "&&", "npm", "test"]   // runs npm with "&&" as an arg
    "postCreateCommand": "npm install && npm test"                 // the string form uses a shell
    "postCreateCommand": ["sh", "-c", "npm install && npm test"]   // or ask for one

An argument that only contains an operator inside quotes is fine.

## security

| Rule | Default | Description |
| --- | --- | --- |
| [`security/cap-add-sys-admin`](#securitycap-add-sys-admin) | warning | "SYS_ADMIN" is close to full privilege |
| [`security/docker-socket-mount`](#securitydocker-socket-mount) | warning | Mounting "/var/run/docker.sock" is effectively host root |
| [`security/hardcoded-secret`](#securityhardcoded-secret) | error | Credential-shaped literal in "containerEnv", "remoteEnv", or "build.args" |
| [`security/privileged`](#securityprivileged) | warning | "privileged": true grants near-host access |
| [`security/privileged-run-args`](#securityprivileged-run-args) | warning | Privileges passed through "runArgs" |
| [`security/seccomp-unconfined`](#securityseccomp-unconfined) | warning | "seccomp=unconfined" disables syscall filtering |

### security/cap-add-sys-admin

CAP_SYS_ADMIN covers so much (mounting filesystems, namespaces, many ioctls)
that it's close to running privileged; plenty of container escapes start from it.

    "capAdd": ["SYS_ADMIN"]

Find the narrower capability the tool needs (SYS_PTRACE for a debugger, NET_ADMIN for
networking), or suppress with a reason.

### security/docker-socket-mount

Whoever can talk to the Docker socket can start a privileged container with
the host's filesystem mounted, so mounting it into the dev container hands everything
inside it root on the host.

    "mounts": ["source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"]

The docker-outside-of-docker feature does this deliberately; if that's the intent,
suppress with a reason. Docker-in-Docker avoids it.

### security/hardcoded-secret

devcontainer.json is committed, so a token written into it is a leaked
token. Pass credentials in from the host environment instead; the value is then read
when the container starts and never lands in the repository.

    "containerEnv": { "GITHUB_TOKEN": "ghp_..." }                       // leaked
    "containerEnv": { "GITHUB_TOKEN": "${localEnv:GITHUB_TOKEN}" }      // read from the host

If a value was ever committed, rotate it: removing it from the file doesn't remove it
from history.

### security/privileged

A privileged container gets every capability and every host device, and can
undo most of the isolation a container normally gives. Anything that runs inside it
(an extension, a postinstall script) has close to root on the host.

    "privileged": true

Usually what's needed is narrower: one capability through "capAdd", or a device
through "runArgs". If it really is needed (Docker-in-Docker, some debuggers), suppress
this with a reason.

### security/privileged-run-args

"runArgs" goes straight to "docker run", so it can grant everything the
dedicated properties can, out of sight of anyone reading them:

    "runArgs": ["--privileged"]                         // same as "privileged": true
    "runArgs": ["--cap-add=SYS_ADMIN"]                  // same as "capAdd"
    "runArgs": ["--security-opt", "seccomp=unconfined"]
    "runArgs": ["--pid=host"]                           // sees every host process

Use the dedicated property, where one exists, so the grant is visible; or suppress
with a reason.

### security/seccomp-unconfined

Docker's default seccomp profile blocks a few dozen dangerous syscalls.
"seccomp=unconfined" turns that off for everything in the container.

    "securityOpt": ["seccomp=unconfined"]

Debuggers sometimes need it (ptrace on older kernels); "capAdd": ["SYS_PTRACE"] is often
enough on its own. If not, suppress with a reason.

## vscode

| Rule | Default | Description |
| --- | --- | --- |
| [`vscode/extension-deprecated`](#vscodeextension-deprecated) 🌐 | warning | A source reports the extension deprecated, or no longer downloadable |
| [`vscode/extension-not-allowed`](#vscodeextension-not-allowed) | error | Extension is denied by an extensions.allowed policy |
| [`vscode/extension-not-found`](#vscodeextension-not-found) 🌐 | error | Extension is absent from every required source |
| [`vscode/extension-not-portable`](#vscodeextension-not-portable) 🌐 | warning | Extension is in some required sources but not all |
| [`vscode/extension-version-not-allowed`](#vscodeextension-version-not-allowed) | warning | Policy pins versions the requested extension does not satisfy |
| [`vscode/ineffective-application-setting`](#vscodeineffective-application-setting) | warning | Application-scoped setting in customizations.vscode.settings, where VS Code discards it |
| [`vscode/invalid-extension-id`](#vscodeinvalid-extension-id) | error | Extension ID is not "publisher.name" |

### vscode/extension-deprecated

The marketplace marks this extension deprecated, or has stopped serving it
(unpublished or removed). It may already fail to install, and won't get fixes. The
marketplace page usually names the replacement.

Needs --online.

### vscode/extension-not-allowed

Your organisation's "extensions.allowed" policy (configured as a policy
extension source in .dcx.yaml) doesn't allow this extension, so it won't install for
anyone the policy applies to, and the dev container silently comes up without it.

    # .dcx.yaml
    extension-sources:
      - id: org
        kind: policy
        allowed: { "microsoft": true }

    "extensions": ["golang.go"]    // not allowed by "org"

Ask for it to be added to the policy, or drop it.

### vscode/extension-not-found

None of the extension sources marked "required" in .dcx.yaml has this
extension, so it won't install for anyone: usually a typo in the ID, or an extension
that was unpublished.

Needs --online and at least one required source. A source dcx couldn't reach doesn't
count either way.

### vscode/extension-not-portable

Open VSX isn't a mirror of the Microsoft Marketplace; Microsoft's
proprietary extensions (Pylance, the C# Dev Kit, Live Share, ...) aren't on it. A config
that works in VS Code then silently comes up without them in VSCodium, Cursor, Gitpod or
anything else that uses Open VSX.

This fires when an extension is in some required sources and not others. With
"extensions.satisfy: any" in .dcx.yaml, one source is enough and it doesn't fire.

### vscode/extension-version-not-allowed

An "extensions.allowed" policy can allow an extension only at certain
versions. Asking for another version, or for none (which means the latest), gets an
extension the policy blocks.

    allowed: { "ms-python.python": ["2024.1.0"] }

    "extensions": ["ms-python.python"]             // latest, not allowed
    "extensions": ["ms-python.python@2024.1.0"]    // fine

### vscode/ineffective-application-setting

Some VS Code settings only apply application-wide: "extensions.allowed",
"extensions.gallery.*", "update.mode", "telemetry.telemetryLevel" and others. VS Code
ignores them in workspace and remote settings, which is where
"customizations.vscode.settings" goes, so setting one there has no effect.

That's deliberate for "extensions.allowed": if a repository could set it, any
repository could allow-list arbitrary extensions for whoever opens it. Org policy has to
come from user settings or group policy instead.

    "customizations": { "vscode": { "settings": { "extensions.allowed": { ... } } } }   // ignored

### vscode/invalid-extension-id

Extensions are listed by their ID, "publisher.name", as shown on the
extension's Marketplace or Open VSX page. A display name, a URL or a missing publisher
isn't an ID, and the extension silently doesn't install.

    "extensions": ["dbaeumer.vscode-eslint"]     // fine
    "extensions": ["ESLint"]                     // display name, not an ID

A leading "-" removes an extension something else added; "@version" pins one.

## repro

| Rule | Default | Description |
| --- | --- | --- |
| [`repro/image-no-digest`](#reproimage-no-digest) | off | Require "@sha256:" digest pinning for "image" |
| [`repro/mutable-build-arg`](#repromutable-build-arg) | info | "build.args" value interpolates a host env var |
| [`repro/unpinned-image`](#reprounpinned-image) | warning | "image" has no tag, or uses ":latest" |

### repro/image-no-digest

A tag can be re-pushed; a digest can't. Pinning "image" by digest means every
build uses exactly the same bytes, which some teams require for supply-chain reasons.

    "image": "node:22@sha256:<64 hex digits>"

Off by default: digests have to be bumped by hand (or by a bot), and most teams find a
version tag enough.

### repro/mutable-build-arg

A build arg taken from the host's environment builds differently on each
machine: whatever that variable holds there, or nothing. Sometimes that's the point
(a proxy setting, a user ID); often it's an accident that makes images differ.

    "build": { "args": { "NODE_VERSION": "${localEnv:NODE_VERSION}" } }   // differs per machine
    "build": { "args": { "NODE_VERSION": "22" } }

### repro/unpinned-image

An image with no tag means ":latest", which is whatever was pushed most
recently. Two people building the same config a week apart can get different base
images, and a rebuild can break with nothing in the repo having changed.

    "image": "mcr.microsoft.com/devcontainers/typescript-node"        // latest
    "image": "mcr.microsoft.com/devcontainers/typescript-node:1-22"   // pinned

A version tag is usually enough; repro/image-no-digest (off by default) asks for a
digest too.

## style

| Rule | Default | Description |
| --- | --- | --- |
| [`style/missing-name`](#stylemissing-name) | info | No "name"; tools will display a generated label |
| [`style/missing-schema`](#stylemissing-schema) ✎ | off | No "$schema"; adding it enables editor completion |

### style/missing-name

"name" is what the editor shows for the container (in the status bar, the
remote explorer, Codespaces). Without one you get a label made from the folder or image,
which gets confusing with more than one config.

    { "name": "api (Node 22)", "image": "node:22" }

### style/missing-schema

A "$schema" property points editors without built-in dev container support
at the schema, so they offer completion and validation as you type.

    { "$schema": "https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainer.schema.json", ... }

Off by default; VS Code already knows the schema for devcontainer.json. The fix adds it
as the first property.

## meta

| Rule | Default | Description |
| --- | --- | --- |
| [`meta/unused-suppression`](#metaunused-suppression) | warning | A dcx-disable-* directive suppressed nothing |

### meta/unused-suppression

A dcx-disable-line, dcx-disable-next-line or dcx-disable-file comment that
doesn't silence anything: the problem it was added for has been fixed, the rule ID is
misspelt, or it sits on the wrong line. Left alone, stale suppressions pile up and start
hiding new problems on the lines they cover.

    {
      // dcx-disable-next-line security/privliged   <- typo, suppresses nothing
      "privileged": true
    }

Delete the directive, or fix the rule ID or position.
