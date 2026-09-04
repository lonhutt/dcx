# dcx — Design Document

**Status:** Draft for review
**Date:** 2026-09-04
**Language:** Go (see [Language Decision](#2-language-decision))

---

## 1. Overview

`dcx` is a standalone, dependency-free static analyser for `devcontainer.json`,
built against the
[Development Container Specification](https://containers.dev/implementors/spec/).

It is the first component of a three-part family:

| Component | Deliverable | Status |
| --- | --- | --- |
| **Core library** (`pkg/…`) | Reusable Go packages: parse → model → analyze → diagnose | This doc |
| **CLI** (`cmd/dcx`) | `dcx check` — standalone binary for terminals, CI, pre-commit | This doc |
| **LSP server** (`cmd/dcx`) | `dcx serve` — the same binary, over stdio | Designed for, built later |
| **VSCode extension** (`extensions/vscode`) | Thin TypeScript client | This doc |

### 1.1 Goals

- **G1** — Catch every class of `devcontainer.json` defect that can be detected
  statically, with precise source spans and human-readable messages.
- **G2** — Ship as a single static binary with no runtime dependency.
- **G3** — Be architecturally ready for an LSP from day one: no global state, no
  direct filesystem access from rules, cancellable analysis, byte-accurate
  positions, and machine-applicable fixes.
- **G4** — Be usable non-interactively: stable exit codes, JSON and SARIF output,
  GitHub annotations, pre-commit hook.
- **G5** — Be configurable: per-rule severity, inline suppressions, project config file.
- **G6** — Work fully offline by default; network-dependent rules are opt-in.

### 1.2 Non-goals (v1)

- Building, starting, or otherwise executing dev containers. This is a *static*
  analyser; it never invokes Docker.
- Linting `Dockerfile` contents (defer to `hadolint`) or full `docker-compose.yml`
  validation (defer to `docker compose config`). We only cross-reference *the parts
  a `devcontainer.json` points at* — e.g. "does the named compose service exist".
- Auto-generating or scaffolding dev container configs.
- Being a drop-in replacement for `devcontainers/cli`. We complement it: the
  reference CLI parses and merges config but performs **no** schema validation.

### 1.3 Why this project exists

Research into the current ecosystem found:

- The reference `devcontainers/cli` reads and merges `devcontainer.json` but does
  **not** validate it against the published JSON Schema.
- The only third-party tooling found is a GitHub Action that checks for the
  *presence* of specific user-chosen keys — not a general linter.
- Editors that do schema-validate produce unusable errors, because the official
  schema's top level is a nest of `oneOf` branches. A missing `image` key yields
  `"must match exactly one schema in oneOf"` rather than
  `"no container source: expected one of image, build.dockerfile, or dockerComposeFile"`.

The gap is real, and the highest-value work is **not** running a schema validator —
it is discriminating the configuration scenario ourselves and emitting diagnostics a
human can act on.

---

## 2. Language Decision

**Chosen: Go.**

### 2.1 Rationale

| Criterion | Go | TypeScript | Python |
| --- | --- | --- | --- |
| CLI distribution | Single static binary, no runtime | Needs Node | Needs Python/uv |
| Cold start | ~5 ms | ~150–300 ms | ~200–400 ms |
| JSON Schema 2019-09 + `unevaluatedProperties` | `santhosh-tekuri/jsonschema/v6` | Ajv 2019 | `jsonschema` 4.x |
| JSONC parser with positions | Hand-rolled (~700 LOC) | `jsonc-parser` (ideal) | Hand-rolled |
| LSP framework | `tliron/glsp`, `go.lsp.dev` | `vscode-languageserver-node` (reference impl) | `pygls` |
| Cross-compilation for VSIX targets | Trivial | N/A | Painful |

The decisive argument: **the VSCode extension is a thin client in every scenario.**
Once an LSP exists, the extension is ~200 lines that spawn a server process and wire
up `LanguageClient`. TypeScript's "one language everywhere" advantage is therefore
much smaller than it first appears, while distribution size and startup latency are
permanent, daily-felt properties of a linter — and Go wins both outright.

### 2.2 Accepted costs

- **A hand-written JSONC parser.** Bounded (~700 LOC), one-time, and it lets us build
  exactly the CST a linter wants: comments retained and attachable, trailing commas
  recorded rather than discarded, duplicate keys preserved, and error recovery that
  keeps analysing after a syntax fault.
- **A bilingual repository.** Go core plus a small TypeScript extension. Managed by
  keeping the boundary narrow: the extension only ever talks JSON-over-stdio or LSP.
- **Platform-specific VSIX packaging.** Six build targets. Handled once in CI via
  GoReleaser plus `vsce package --target`.

---

## 3. Specification Model

Facts extracted from the spec that drive the design.

### 3.1 Discovery order

Per the spec, configuration is searched in this precedence order:

1. `.devcontainer/devcontainer.json`
2. `.devcontainer.json`
3. `.devcontainer/<folder>/devcontainer.json` (single level of nesting)

### 3.2 Format

`devcontainer.json` is **JSONC**. The official schema explicitly sets
`allowComments: true` and `allowTrailingCommas: true`. Any parser that rejects
comments is wrong for this format.

### 3.3 Schema shape

The upstream `devContainer.base.schema.json` (~24 KB) is **JSON Schema draft 2019-09**
and uses `unevaluatedProperties`. Its top-level structure is:

```
oneOf:
  ├─ allOf:
  │    ├─ oneOf:
  │    │    ├─ allOf: [ oneOf: [dockerfileContainer, imageContainer], nonComposeBase ]
  │    │    └─ composeContainer
  │    └─ devContainerCommon
  └─ devContainerCommon (additionalProperties: false)
```

Definitions and their properties:

- **`devContainerCommon`** — `$schema`, `name`, `features`,
  `overrideFeatureInstallOrder`, `secrets`, `forwardPorts`, `portsAttributes`,
  `otherPortsAttributes`, `updateRemoteUserUID`, `containerEnv`, `containerUser`,
  `mounts`, `init`, `privileged`, `capAdd`, `securityOpt`, `remoteEnv`, `remoteUser`,
  the six lifecycle commands, `waitFor`, `userEnvProbe`, `hostRequirements`,
  `customizations`, `additionalProperties`.
- **`nonComposeBase`** — `appPort`, `runArgs`, `shutdownAction`, `overrideCommand`,
  `workspaceFolder`, `workspaceMount`.
- **`imageContainer`** — requires `image`.
- **`dockerfileContainer`** — `oneOf`: modern `build.dockerfile` (+ `context`,
  `target`, `args`, `cacheFrom`, `options`) **or** legacy top-level
  `dockerFile` + `context`.
- **`composeContainer`** — requires `dockerComposeFile`, `service`,
  `workspaceFolder`; plus `runServices`, and its own `shutdownAction`
  (`none` | `stopCompose`).
- **`Mount`** — requires `type` (`bind` | `volume`) and `target`; optional `source`.

Constrained enums worth checking explicitly:

- `waitFor` — `initializeCommand`, `onCreateCommand`, `updateContentCommand`,
  `postCreateCommand`, `postStartCommand`
- `userEnvProbe` — `none`, `loginShell`, `loginInteractiveShell`, `interactiveShell`
- `shutdownAction` — `none`, `stopContainer` (non-compose) / `none`, `stopCompose` (compose)
- `portsAttributes.*.onAutoForward` — `notify`, `openBrowser`, `openBrowserOnce`,
  `openPreview`, `silent`, `ignore`
- `portsAttributes.*.protocol` — `http`, `https`

### 3.4 Variable substitution

Supported forms: `${localEnv:NAME}`, `${localEnv:NAME:default}`,
`${containerEnv:NAME}`, `${containerEnv:NAME:default}`, `${localWorkspaceFolder}`,
`${containerWorkspaceFolder}`, `${localWorkspaceFolderBasename}`,
`${containerWorkspaceFolderBasename}`, `${devcontainerId}`.

Note `${containerEnv:…}` is only meaningful in `remoteEnv` — a lintable constraint.

### 3.5 Features

Three reference forms: OCI registry (`ghcr.io/owner/repo/feature:version`), direct
HTTPS tarball, and local relative path (`./feature`). Feature metadata lives in
`devcontainer-feature.json` with `id`, `version`, `name`, `options`, `dependsOn`,
`installsAfter`, `deprecated`, and lifecycle hooks. Options are `boolean` or
`string`, the latter optionally constrained by `enum` or suggested by `proposals`.

---

## 4. Architecture

### 4.1 Layer diagram

```
                     ┌────────────────────────────────────────┐
   CLI ──────────────┤                                        │
   LSP server ───────┤            pkg/lint (facade)           │
   Extension ────────┤     Analyze(ctx, Document, Options)    │
                     └────────────────────┬───────────────────┘
                                          │
   ┌──────────────┬──────────────┬────────┴──────┬──────────────┬─────────────┐
   │  discovery   │    jsonc     │     model     │    rules     │   report    │
   │  locate the  │  lex→parse→  │  CST → typed  │  engine +    │  text/json/ │
   │  config file │  CST (+pos)  │  semantic AST │  registry    │  sarif/gh   │
   └──────┬───────┴──────┬───────┴───────┬───────┴──────┬───────┴─────────────┘
          │              │               │              │
   ┌──────┴──────┐ ┌─────┴─────┐  ┌──────┴──────┐ ┌─────┴──────┐ ┌───────────┐
   │     vfs     │ │ position  │  │   schema    │ │  features  │ │ diagnostic│
   │ overlay FS  │ │ LineIndex │  │  embedded   │ │ OCI + cache│ │ Range/Fix │
   │ (unsaved    │ │ UTF-8↔16  │  │  2019-09    │ │  (network) │ │  Severity │
   │  buffers)   │ │           │  │  validator  │ │            │ │           │
   └─────────────┘ └───────────┘  └─────────────┘ └────────────┘ └───────────┘
```

### 4.2 The five LSP-readiness invariants

These are the constraints that make a future language server a straightforward
addition rather than a rewrite. **Every one of them is cheap now and expensive later.**

1. **No `os.Exit`, no `panic`, no writing to stdout below `cmd/`.** The core returns
   values. Only `main` decides process fate.
2. **All filesystem access goes through `vfs.FS`.** An editor holds unsaved buffers
   that do not exist on disk; the LSP supplies an overlay FS whose contents come from
   `textDocument/didChange`. A rule that calls `os.ReadFile` is unusable in an editor.
3. **Every diagnostic carries a byte-offset `Range`, never a line/column string.**
   Rendering to a terminal caret or to an LSP UTF-16 position is a display concern,
   handled by `pkg/position`.
4. **`Analyze` takes a `context.Context` and honours cancellation.** Editors
   re-analyse on keystroke and abandon in-flight runs constantly.
5. **`Diagnostic` has an optional `Fix []TextEdit` from day one.** The CLI uses it for
   `--fix`; the LSP serves it as `textDocument/codeAction`. Retrofitting fixes onto a
   rule set built without them means touching every rule.

### 4.3 Package layout

```
dcx/
├── go.mod
├── cmd/
│   └── dcx/                     # single binary: check, serve, explain, feature
├── pkg/
│   ├── lint/                    # facade: Analyze(), Document, Options
│   ├── vfs/                     # FS interface, OS impl, overlay impl
│   ├── position/                # Offset, Range, LineIndex, UTF-16 conversion
│   ├── diagnostic/              # Diagnostic, Severity, Fix, TextEdit
│   ├── jsonc/                   # lexer, parser, CST nodes, error recovery
│   ├── discovery/               # config file location per spec §3.1
│   ├── schema/                  # go:embed'd upstream schemas + validator
│   ├── model/                   # typed semantic model over the CST
│   ├── features/                # feature ref parsing, OCI resolution, cache
│   ├── registry/                # extension-registry adapters (Open VSX, gallery, static)
│   ├── lintconfig/              # .dcx.yaml loading + merge
│   ├── suppress/                # inline comment directive parsing
│   ├── rules/
│   │   ├── engine.go            # registry, ordering, execution
│   │   ├── rule.go              # Rule interface
│   │   └── <category>/          # one package per rule category
│   └── report/                  # text, json, sarif, github formatters
├── schemas/                     # vendored upstream JSON schemas
├── testdata/                    # fixture corpus + golden files
└── extensions/vscode/           # TypeScript extension
```

`pkg/` is the public API surface. It is documented and semver-stable so that an LSP
living in a *separate* repository remains possible — but the default plan keeps the
server in-tree as `cmd/dcx` to avoid cross-repo version skew.

---

## 5. Component Specifications

### 5.1 `pkg/jsonc` — the parser

A hand-written lexer and recursive-descent parser producing a **concrete** syntax
tree. Concrete, not abstract: a linter must be able to point at the comma nobody
should have typed.

**Node kinds:** `Object`, `Array`, `Property`, `String`, `Number`, `Boolean`, `Null`,
`Comment`, `Error`.

Every node carries `Offset` and `Length` (byte-based). Objects retain their
`Property` list *in source order, including duplicates* — silently dropping a
duplicate key would hide one of the highest-value diagnostics.

**Requirements:**

- Line (`//`) and block (`/* */`) comments preserved as nodes, attachable to the
  following property for suppression directives.
- Trailing commas parsed successfully but recorded on the node.
- **Error recovery.** On a malformed value, emit an `Error` node, resynchronise at the
  next `,` or `}`, and continue. A file with one syntax error must still produce
  semantic diagnostics for the rest of the document — this is what makes the editor
  experience tolerable while typing.
- Native Go fuzzing over the parser; it must never panic on arbitrary bytes.

### 5.2 `pkg/position` — coordinates

Internally everything is a byte offset. `LineIndex` is built once per document and
converts:

- byte offset ↔ (line, UTF-8 column) — for terminal output
- byte offset ↔ (line, UTF-16 code unit) — for LSP `Position`

The UTF-16 conversion is required by the LSP spec and is a classic source of
off-by-N bugs with non-ASCII content. Building it in from the start costs nothing.

### 5.3 `pkg/vfs` — filesystem abstraction

```go
type FS interface {
    ReadFile(path string) ([]byte, error)
    Stat(path string) (fs.FileInfo, error)
    ReadDir(path string) ([]fs.DirEntry, error)
}
```

Two implementations: `OSFS` (the CLI) and `OverlayFS` (the LSP — in-memory documents
layered over `OSFS`). Rules receive an `FS` and never touch `os` directly.

### 5.4 `pkg/model` — semantic model

Lowers the CST into a typed structure, and — critically — **discriminates the
scenario** before schema validation runs:

```go
type Scenario int
const (
    ScenarioUnknown Scenario = iota  // no container source found
    ScenarioImage                    // has `image`
    ScenarioDockerfile               // has `build.dockerfile` or legacy `dockerFile`
    ScenarioCompose                  // has `dockerComposeFile`
    ScenarioAmbiguous                // more than one of the above
    ScenarioMetadataOnly             // valid: common properties only
)
```

Knowing the scenario is what converts `"must match exactly one schema in oneOf"` into
`"'image' and 'dockerComposeFile' cannot both be set: a Compose configuration takes
its image from the Compose file"`. Every field on the model retains a back-pointer to
its CST node so any rule can produce an exact span.

### 5.5 `pkg/schema` — schema validation

The upstream schemas are vendored into `schemas/` and embedded with `go:embed` — the
linter must work offline and must not vary its behaviour with network conditions. A
CI job checks the vendored copy against upstream weekly and opens a PR on drift.

Validation uses `santhosh-tekuri/jsonschema/v6` (draft 2019-09 + `unevaluatedProperties`).

**Error translation is a first-class concern.** Raw validator output is routed
through a translation layer that:

1. Uses the already-known `Scenario` to select the *relevant* `oneOf` branch and
   discard errors from the branches that were never applicable.
2. Maps the JSON Pointer in each error back to a CST node for an exact span.
3. Rewrites the message into prose, adding the enum's valid values, a spelling
   suggestion for unknown properties (Levenshtein over the known key set), and a
   documentation link.

### 5.6 `pkg/rules` — the rule engine

```go
type Rule interface {
    ID() string                     // e.g. "security/docker-socket-mount"
    Description() string
    DefaultSeverity() diagnostic.Severity
    Category() Category
    RequiresNetwork() bool
    Check(ctx context.Context, p *Pass) 
}

type Pass struct {
    Doc      *jsonc.Document   // CST + source text
    Model    *model.DevContainer
    FS       vfs.FS
    Dir      string            // directory containing devcontainer.json
    Features features.Resolver // nil when offline
    Report   func(diagnostic.Diagnostic)
}
```

Rules register themselves in an `init()` into a package-level registry. The engine:

1. Filters by config (severity `off`) and by `RequiresNetwork()` when offline.
2. Runs rules concurrently — they are pure functions over an immutable `Pass`.
3. Collects diagnostics, applies inline suppressions, sorts by position.
4. Checks `ctx.Done()` between rules for LSP cancellation.

### 5.7 `pkg/features` — feature resolution

Offline, we can only check reference *syntax* and pinning. With `--online`, we fetch
each feature's `devcontainer-feature.json` from its OCI artifact to validate option
names and values against the declared `options` schema, and to surface `deprecated`.

Cached under `$XDG_CACHE_HOME/dcx/features/` keyed by resolved digest,
with a configurable TTL. Network failures **degrade to a warning, never an error** —
a linter that fails closed on a flaky registry is a linter people disable.

### 5.8 `pkg/registry` — extension sources and policy

Verifying `customizations.vscode.extensions` requires knowing where extensions come
from — and **there is no single answer.** Four facts drive the design:

1. **The Microsoft Marketplace cannot be the default.** Its Terms of Use state that
   Marketplace offerings may only be installed and used with Visual Studio products
   and services. That restriction is precisely why VSCodium ships pointed at Open VSX
   instead. A third-party OSS linter cannot enable Marketplace queries by default on
   a user's behalf.
2. **Open VSX is not a mirror.** Microsoft's proprietary extensions are simply absent
   from it — a live check confirms `ms-python.vscode-pylance` returns HTTP 404 there,
   while `golang.go` and `ms-azuretools.vscode-docker` resolve fine. A config that
   works perfectly in VS Code silently degrades for a teammate on VSCodium, Cursor,
   Windsurf, or Gitpod.
3. **Private galleries are now first-class.** VS Code's Private Marketplace
   (announced 2025-11-18, GitHub Enterprise customers) deploys as a stateless Docker
   container and is pointed at via `extensions.gallery.serviceUrl`, with
   `extensions.gallery.authProvider` selecting the account that grants access. Older
   and OSS builds use `product.json`'s `extensionsGallery.serviceUrl`. Self-hosting is
   no longer an edge case.
4. **There is already a standard org policy format.** Since VS Code 1.96,
   `extensions.allowed` controls which extensions may be installed, deployable via
   `settings.json` or group policy. It supports publisher wildcards, per-extension
   allow/deny, pinned versions, platform-qualified versions, and `"stable"`.

Fact 2 **reframes the rule**: "does this extension ID exist" is low value — a typo
surfaces the moment the container is built. "Is this extension available to everyone
who will open this repo" is high value, because that failure is silent and only hits
the teammate on the other editor.

Fact 4 is the bigger win, and it is why this is not just a config knob. We do **not**
invent an allowlist syntax — we consume `extensions.allowed` verbatim. An enterprise
that has already written that policy gets a working check with no new authoring, and
the check is **fully offline**.

**Adapter interface:**

```go
type Source interface {
    ID() string
    RequiresNetwork() bool
    Lookup(ctx context.Context, publisher, name string) (*Extension, error)
}

type Extension struct {
    Version         string
    Deprecated      bool
    Downloadable    bool     // false ⇒ unpublished or removed
    AllowedVersions []string // from policy sources; nil ⇒ unconstrained
    TargetPlatforms []string
}
```

Three implementations:

| Kind | Mechanism | Network | Auth |
| --- | --- | --- | --- |
| `openvsx` | `GET {base}/api/{namespace}/{name}`. Serves `open-vsx.org` and self-hosted instances identically. | yes | none |
| `vscode-gallery` | `POST {serviceUrl}/extensionquery` using VS Code's gallery protocol. Covers the Microsoft Marketplace, the Private Marketplace container, and any gallery implementing it. | yes | optional token |
| `policy` | Parses VS Code's own `extensions.allowed` object, from a file path or inline in our config. | **no** | none |

### 5.8.1 Why `policy` is the recommended enterprise path

The Private Marketplace authenticates through `extensions.gallery.authProvider` —
a GitHub Enterprise or Entra ID sign-in flow, not a static token. **The linter does
not implement OAuth**, and should not: a CI job holding an interactive enterprise
identity is a bad idea regardless of effort.

For organisations, the `policy` source is both more tractable and more valuable. It
needs no credentials, no network, and no VPN; it answers the question that actually
bites — *will this extension install for our developers at all* — and it reads a file
the org has already written for a different purpose. Gallery queries remain available
for anyone who wants them, with a token supplied out-of-band.

### 5.8.2 `extensions.allowed` cannot come from the repository

There is no in-repo location VS Code honours for this policy, and that is deliberate.
`extensions.allowed` is **application-scoped**. VS Code maintains a list of settings
unsupported in workspace settings: the first time a workspace defines one, the editor
warns, and thereafter always ignores the value. So neither candidate location works:

| Candidate | Outcome |
| --- | --- |
| `.vscode/settings.json` | Workspace scope. Warned once, then permanently ignored. |
| `customizations.vscode.settings` | Written to remote/machine settings, which is likewise not application scope. |

The reason is a security property, not an oversight: **if a repository could set the
extension allowlist, any repository could allowlist arbitrary extensions for whoever
opened it.** Application scope exists precisely to prevent that, so no repo-provided
location can ever be authoritative here. Org policy arrives through local user
settings or group policy — outside the repository entirely.

Two consequences:

1. **Auto-discovery is dropped.** The `policy` source is always explicitly configured
   in `.dcx.yaml` — inline, or a path to a policy file the org
   distributes by its own means. It is *our* input data, not a mirror of something VS
   Code reads from the repo.
2. **This is itself a lintable mistake**, and exactly the silent failure this project
   exists to catch. Hence `vscode/ineffective-application-setting`: it flags any
   application-scoped setting placed in `customizations.vscode.settings`, where it
   will be quietly discarded. The rule covers the whole application-scoped set, not
   just `extensions.allowed`.

### 5.8.3 Configuration is layered, and split by ownership

The user's point stands: this must be per-project. But *which* part is per-project
matters, because two different concerns are in play.

- **Source definitions** (id, kind, url, credentials) may be declared in the project
  config *and* extended by a user-level config at
  `$XDG_CONFIG_HOME/dcx/config.yaml`. A developer on VSCodium can add
  Open VSX to their own checks without editing a shared file.
- **Policy** (which sources are `required`, and the `satisfy` mode) is
  **project-owned only**. It is a team decision about what this repo must support,
  and a user-level file must not be able to weaken it.

**Credentials are never literals.** A token is given as an env var name or a
credential-helper command, never a value. `.dcx.yaml` is a committed
file, and we ship a `security/hardcoded-secret` rule — inviting a PAT into our own
config would be indefensible. The loader rejects a literal-looking token outright.

**Lookups are case-insensitive.** Open VSX's canonical record for `golang.go` is
namespace `golang`, name `Go`. A rule reporting "not found" on a case difference
would be a pure false positive.

**Unreachable sources degrade to a warning, never an error** — a self-hosted gallery
is often only reachable on a VPN, and CI must not fail because of it.

---

## 6. Rule Catalog

Rule IDs are `category/kebab-name`. IDs are stable API: once shipped, a rule is never
renamed and never changes meaning. Removal requires a major version.

Severities: `error`, `warning`, `info`, `off`.
Rules marked 🌐 require `--online`.

### 6.1 `syntax/` — parse-level

| ID | Default | Description |
| --- | --- | --- |
| `syntax/parse-error` | error | Malformed JSONC |
| `syntax/duplicate-key` | error | Key appears twice; later value silently wins |
| `syntax/trailing-comma` | off | Legal per spec, but some third-party parsers reject it |

### 6.2 `schema/` — schema conformance

| ID | Default | Description |
| --- | --- | --- |
| `schema/unknown-property` | warning | Property not in the spec; includes a spelling suggestion |
| `schema/type-mismatch` | error | Wrong JSON type for a known property |
| `schema/invalid-enum-value` | error | Value outside the allowed set; lists valid values |
| `schema/missing-required` | error | A required property for the detected scenario is absent |

### 6.3 `scenario/` — container source discrimination

| ID | Default | Description |
| --- | --- | --- |
| `scenario/no-container-source` | error | None of `image`, `build.dockerfile`, `dockerComposeFile` present |
| `scenario/conflicting-source` | error | More than one container source declared |
| `scenario/compose-missing-service` | error | `dockerComposeFile` without `service` |
| `scenario/compose-missing-workspace-folder` | error | Compose requires an explicit `workspaceFolder` |
| `scenario/compose-service-not-found` | error | `service` names a service absent from the Compose file |
| `scenario/non-compose-property` | warning | `runArgs`/`appPort`/`workspaceMount` are ignored under Compose |
| `scenario/shutdown-action-mismatch` | error | `stopCompose` without Compose, or `stopContainer` with it |

### 6.4 `semantic/` — cross-field consistency

| ID | Default | Description |
| --- | --- | --- |
| `semantic/workspace-mount-without-folder` | error | `workspaceMount` requires `workspaceFolder` |
| `semantic/wait-for-unreachable` | warning | `waitFor` names a lifecycle command that is not defined |
| `semantic/invalid-substitution` | error | Unknown `${…}` variable name |
| `semantic/substitution-scope` | warning | `${containerEnv:…}` used outside `remoteEnv` |
| `semantic/local-env-no-default` | info | `${localEnv:X}` with no default silently becomes empty |
| `semantic/remote-user-not-container-user` | info | `remoteUser` differs from `containerUser`; often intended, sometimes not |
| `semantic/update-remote-user-uid-noop` | info | Set on a config where it cannot apply |
| `semantic/build-arg-not-declared` | warning | A `build.args` key has no matching `ARG` in the referenced Dockerfile, so the value is silently discarded |

### 6.5 `fs/` — referenced-path existence

| ID | Default | Description |
| --- | --- | --- |
| `fs/dockerfile-not-found` | error | `build.dockerfile` does not resolve |
| `fs/context-not-found` | error | `build.context` does not resolve |
| `fs/compose-file-not-found` | error | A `dockerComposeFile` entry does not resolve |
| `fs/local-feature-not-found` | error | A `./`-relative feature path does not resolve |
| `fs/path-escapes-workspace` | warning | A referenced path traverses above the project root |

### 6.6 `deprecation/`

| ID | Default | Description |
| --- | --- | --- |
| `deprecation/top-level-dockerfile` | warning | Legacy `dockerFile`/`context` at root; use `build.*` — **fixable** |
| `deprecation/app-port` | warning | `appPort` superseded by `forwardPorts` |
| `deprecation/root-extensions` | warning | Root `extensions` moved to `customizations.vscode.extensions` — **fixable** |
| `deprecation/root-settings` | warning | Root `settings` moved to `customizations.vscode.settings` — **fixable** |

### 6.7 `feature/`

| ID | Default | Description |
| --- | --- | --- |
| `feature/invalid-reference` | error | Reference matches none of the three legal forms |
| `feature/unpinned-version` | warning | No tag, or `:latest` — breaks reproducibility |
| `feature/duplicate` | error | Same feature declared twice |
| `feature/override-order-unknown` | warning | `overrideFeatureInstallOrder` lists a feature not in `features` |
| `feature/unknown-option` 🌐 | error | Option not declared by the feature |
| `feature/invalid-option-value` 🌐 | error | Value outside the option's `enum` |
| `feature/deprecated` 🌐 | warning | Feature is marked `deprecated` upstream |
| `feature/missing-dependency` 🌐 | warning | A `dependsOn` requirement is unsatisfied |

### 6.8 `port/`

| ID | Default | Description |
| --- | --- | --- |
| `port/out-of-range` | error | Not in 1–65535 |
| `port/duplicate-forward` | warning | Port listed twice in `forwardPorts` |
| `port/invalid-attribute-key` | error | `portsAttributes` key is not a port, `host:port`, or range |
| `port/attributes-orphan` | info | `portsAttributes` entry for a port that is never forwarded |
| `port/privileged-without-elevate` | info | Port < 1024 without `elevateIfNeeded` |

### 6.9 `mount/`

| ID | Default | Description |
| --- | --- | --- |
| `mount/invalid-string-syntax` | error | String-form mount is not valid `key=value,…` |
| `mount/missing-target` | error | Mount has no `target` |
| `mount/duplicate-target` | error | Two mounts target the same path |
| `mount/absolute-host-path` | warning | Bind source is a machine-specific absolute path |

### 6.10 `lifecycle/`

| ID | Default | Description |
| --- | --- | --- |
| `lifecycle/shell-syntax-in-array-form` | warning | Array form bypasses the shell; `&&`, `|`, `>` will be literal arguments |
| `lifecycle/parallel-non-string-value` | error | Object (parallel) form requires string or array values |
| `lifecycle/initialize-runs-on-host` | info | `initializeCommand` executes on the host, not in the container |
| `lifecycle/empty-command` | warning | Empty command string |

### 6.11 `security/`

| ID | Default | Description |
| --- | --- | --- |
| `security/privileged` | warning | `privileged: true` grants near-host access |
| `security/docker-socket-mount` | warning | Mounting `/var/run/docker.sock` is effectively host root |
| `security/cap-add-sys-admin` | warning | `SYS_ADMIN` is close to full privilege |
| `security/seccomp-unconfined` | warning | `seccomp=unconfined` disables syscall filtering |
| `security/privileged-run-args` | warning | `--privileged`/`--cap-add` smuggled through `runArgs` |
| `security/hardcoded-secret` | error | Credential-shaped literal in `containerEnv`, `remoteEnv`, or `build.args` |

### 6.12 `vscode/` — editor customizations

| ID | Default | Description |
| --- | --- | --- |
| `vscode/invalid-extension-id` | error | Not a `publisher.name` identifier |
| `vscode/extension-not-allowed` | error | Denied by an `extensions.allowed` policy source — it will not install for anyone in the org. Offline |
| `vscode/extension-version-not-allowed` | warning | Policy pins permitted versions (or platform-qualified versions) that the requested extension does not satisfy. Offline |
| `vscode/extension-not-found` 🌐 | error | Absent from every source marked `required` |
| `vscode/extension-not-portable` 🌐 | warning | Present in some required sources but not all — the VS Code / Open VSX gap |
| `vscode/extension-deprecated` 🌐 | warning | Source reports `deprecated`, or `downloadable: false` (unpublished or removed) |
| `vscode/ineffective-application-setting` | warning | `customizations.vscode.settings` contains an application-scoped setting (`extensions.allowed`, `extensions.gallery.*`, …). VS Code discards these — the config has no effect |

### 6.13 `repro/` — reproducibility

| ID | Default | Description |
| --- | --- | --- |
| `repro/unpinned-image` | warning | `image` has no tag, or uses `:latest` |
| `repro/image-no-digest` | off | Opt-in: require `@sha256:` digest pinning |
| `repro/mutable-build-arg` | info | `build.args` value interpolates a host env var |

### 6.14 `style/`

| ID | Default | Description |
| --- | --- | --- |
| `style/missing-name` | info | No `name`; tools will display a generated label |
| `style/missing-schema` | off | No `$schema`; adding it enables editor completion — **fixable** |

### 6.15 `meta/` — the linter's own hygiene

| ID | Default | Description |
| --- | --- | --- |
| `meta/unused-suppression` | warning | A `dcx-disable-*` directive suppressed nothing |

**Total: 71 rules across 15 categories.**

> Correction: earlier drafts of this document stated 52 and then 58. Both were
> arithmetic slips in the running total; the per-category tables were correct. The
> figure above is a recount: syntax 3, schema 4, scenario 7, semantic 8, fs 5,
> deprecation 4, feature 8, port 5, mount 4, lifecycle 4, security 6, vscode 7,
> repro 3, style 2, meta 1.

---

## 7. CLI Design

### 7.1 Invocation

```
dcx check [flags] [path...]
```

`path` may be a `devcontainer.json` file, or a directory. With no path, the current
directory is used.

### 7.2 Target resolution

Given a directory, resolve in spec precedence order:

1. `<dir>/.devcontainer/devcontainer.json`
2. `<dir>/.devcontainer.json`
3. `<dir>/.devcontainer/*/devcontainer.json` — **all** matches are linted

If none is found, exit 2 with a message naming the paths searched. `--recursive`
walks the tree for every dev container config beneath the target, honouring
`.gitignore`.

### 7.3 Flags

| Flag | Description |
| --- | --- |
| `--format <fmt>` | `text` (default), `json`, `sarif`, `github`, `compact` |
| `--config <path>` | Explicit config file; disables discovery |
| `--no-config` | Ignore any project config |
| `--online` | Enable network-dependent rules |
| `--offline` | Force offline (default) |
| `--rule <id>` | Run only these rules (repeatable) |
| `--disable <id>` | Disable these rules (repeatable) |
| `--severity <id>=<sev>` | Override one rule's severity |
| `--max-severity <sev>` | Cap severity, e.g. treat everything as at most `warning` |
| `--error-on-warning` | Exit non-zero for warnings too |
| `--fix` | Apply machine-applicable fixes in place |
| `--fix-dry-run` | Print the unified diff `--fix` would apply |
| `--no-color` / `--color=<when>` | Colour control (`auto`, `always`, `never`) |
| `--quiet` | Only print diagnostics, no summary |
| `--explain <id>` | Print the long-form explanation for a rule and exit |
| `--list-rules` | Print the rule catalog (respects `--format json`) |
| `--version` | Version, commit, build date |

### 7.4 Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No diagnostics at or above the failure threshold |
| 1 | Lint findings at/above the threshold (default: any `error`) |
| 2 | Tool error: bad usage, unreadable file, no config found |

Separating 1 from 2 is what lets CI distinguish "your config is wrong" from "the
linter broke".

### 7.5 Text output

```
.devcontainer/devcontainer.json:14:3: error: 'image' and 'dockerComposeFile' cannot
  both be set — a Compose configuration takes its image from the Compose file
  [scenario/conflicting-source]

   12 │   "name": "api",
   13 │   "dockerComposeFile": "docker-compose.yml",
   14 │   "image": "mcr.microsoft.com/devcontainers/go:1",
      │   ^^^^^^^
   15 │   "service": "app",

  help: remove "image", or replace "dockerComposeFile" and "service" with a
        single-container configuration
  docs: https://containers.dev/implementors/json_reference/#compose-specific

✖ 1 error, 2 warnings in 1 file
```

`compact` format is one line per diagnostic (`file:line:col: severity: message [id]`)
for editor `errorformat` integration and grep.

### 7.6 SARIF

SARIF 2.1.0 with `rules[]` populated from the registry, so GitHub code scanning shows
descriptions and help URIs. This makes the linter a first-class citizen in the
GitHub Security tab with no extra work from the user.

---

## 8. Configuration

### 8.1 File

`.dcx.yaml` (also `.yml`, `.json`) — **these three and nothing else; no
TOML, no bespoke format** — discovered by walking upward from the linted file to the
repository root.

```yaml
version: 1

# Fail the run on anything at or above this severity.
fail-on: error

# Enable rules that need network access.
online: false

rules:
  security/privileged: error          # promote
  style/missing-name: off             # disable
  repro/image-no-digest: warning      # enable an off-by-default rule
  syntax/trailing-comma: error

# Turn whole categories off at once.
categories:
  style: off

# Paths excluded from linting (gitignore syntax).
exclude:
  - "examples/**"
  - "testdata/**"

features:
  # Allow these otherwise-unpinned features.
  allow-unpinned:
    - "ghcr.io/devcontainers/features/common-utils"
  cache-ttl: 24h

# ── Extension sources ────────────────────────────────────────────────
# Definitions may be extended by user-level config; `required` may not.
extension-sources:
  - id: openvsx
    kind: openvsx
    url: https://open-vsx.org
    required: true

  # VS Code's own `extensions.allowed` format, verbatim. Offline, no auth.
  - id: corp-policy
    kind: policy
    path: .vscode/extensions-policy.json
    required: true

  # Or inline, using the same syntax:
  # - id: corp-policy
  #   kind: policy
  #   required: true
  #   allowed:
  #     "microsoft": true
  #     "ms-azuretools.vscode-containers": false
  #     "dbaeumer.vscode-eslint": ["3.0.0"]
  #     "rust-lang.rust-analyzer": ["5.0.0@win32-x64", "5.0.0@darwin-x64"]
  #     "redhat": "stable"

  # Private Marketplace or Microsoft Marketplace. Opt-in; you are responsible
  # for compliance with the gallery's terms of use.
  - id: corp-gallery
    kind: vscode-gallery
    url: https://marketplace.corp.example/_apis/public/gallery
    token-env: CORP_GALLERY_TOKEN     # env var NAME — never a literal
    required: false

extensions:
  # all — must satisfy every source marked `required` (the portability check)
  # any — must satisfy at least one
  satisfy: all
```

Precedence, lowest to highest: rule defaults → user config → project config →
environment → CLI flags. The one exception is `required` and `satisfy` under
`extension-sources`, which are project-owned: a user-level config may add source
definitions but may not weaken the project's policy.

### 8.2 Inline suppression

Because the format is JSONC, comment directives are natural — and this is a genuine
differentiator over schema-only validation.

```jsonc
{
  // dcx-disable-next-line security/docker-socket-mount
  "mounts": ["source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"],

  "privileged": true, // dcx-disable-line security/privileged -- CI needs this
}
```

- `dcx-disable-next-line <ids…>`
- `dcx-disable-line <ids…>`
- `dcx-disable-file <ids…>` (must be in the leading comment block)
- Everything after ` -- ` is a reason, preserved in JSON/SARIF output.
- With no IDs, all rules are suppressed for that scope.
- A `meta/unused-suppression` rule (default `warning`) flags directives that
  suppressed nothing — otherwise suppressions rot silently.

---

## 9. LSP Integration Plan

The server is a **thin adapter**, not a second implementation. It is built once the
CLI rule set is stable (M8), and its existence is what §4.2's invariants pay for.

### 9.1 Server surface

| Capability | Backed by |
| --- | --- |
| `textDocument/publishDiagnostics` | `lint.Analyze` on open/change (debounced ~200 ms) |
| `textDocument/codeAction` | `Diagnostic.Fix` — already produced by rules |
| `textDocument/hover` | Property descriptions from the embedded schema |
| `textDocument/completion` | Property names, enum values, feature IDs 🌐 |
| `textDocument/documentLink` | `build.dockerfile`, `dockerComposeFile`, local features |
| `textDocument/definition` | Jump from `service` to its Compose definition |
| `workspace/executeCommand` | "Fix all auto-fixable problems" |

### 9.2 Mechanics

- Transport: stdio (`--stdio`), matching every editor's expectation.
- Sync: incremental (`TextDocumentSyncKind.Incremental`); `OverlayFS` holds buffers.
- Cancellation: each `didChange` cancels the previous analysis `context`.
- Positions: `pkg/position` converts byte offsets to UTF-16, per LSP spec.
- The server shares the CLI's config discovery, so a project's
  `.dcx.yaml` governs the editor identically.

### 9.3 One binary, not two

The server is a **subcommand of the same binary**, not a separate executable:
`dcx serve --stdio` alongside `dcx check`. Three reasons:

1. **The extension bundles one artefact instead of two.** DCL-47 ships a
   platform-specific VSIX for six targets; two binaries would double both the
   payload and the packaging matrix.
2. **The server and the rule set change together.** A split would make every rule
   addition a two-artefact release with a version-skew window in between.
3. **Users install one thing.** `brew install dcx` gives you the CLI, the language
   server, and everything the extension needs.

The `pkg/` API stays documented and semver-stable regardless, so extracting the
server later remains possible if it ever grows its own release rhythm.

## 10. VSCode Extension

`extensions/vscode`, TypeScript, deliberately minimal.

### 10.1 Two-phase plan

**Phase 1 (M7) — CLI-driven.** No LSP required. The extension spawns
`dcx check --format json` on open and on save, parses the output, and
populates a `DiagnosticCollection`. Roughly 250 lines. This ships real value long
before the server exists, and it validates the JSON output contract.

**Phase 2 (M8) — LSP-driven.** Replace the runner with `vscode-languageclient`
spawning `dcx serve --stdio`. Diagnostics arrive over the wire; hover,
completion, code actions, and document links come along for free. The Phase 1 code
path is deleted, not maintained in parallel.

### 10.2 Binary resolution

In order: `dcx.path` setting → bundled binary in `bin/` → `PATH`. If all
three fail, show a notification with an install command rather than failing silently.

### 10.3 Packaging

Platform-specific VSIX via `vsce package --target <t>` for `win32-x64`,
`win32-arm64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`. GoReleaser
produces the binaries; a CI matrix copies the right one into `bin/` before packaging.
The Marketplace serves each user only their platform's ~6 MB payload.

### 10.4 Activation and settings

Activation: `onLanguage:jsonc`, plus `workspaceContains:**/.devcontainer/devcontainer.json`
and `workspaceContains:**/.devcontainer.json`.

| Setting | Default | Description |
| --- | --- | --- |
| `dcx.enable` | `true` | Master switch |
| `dcx.path` | `""` | Override binary location |
| `dcx.run` | `onSave` | `onSave` \| `onType` |
| `dcx.online` | `false` | Enable network rules |
| `dcx.configPath` | `""` | Explicit config file |
| `dcx.trace.server` | `off` | LSP tracing |

Commands: *Lint Workspace*, *Fix All Auto-fixable Problems*, *Restart Server*,
*Show Output*.

---

## 11. Testing Strategy

| Layer | Approach |
| --- | --- |
| **Parser** | Table-driven unit tests; Go native fuzzing (`FuzzParse`) asserting no panic and that offsets stay within bounds |
| **Rules** | Golden-file tests: `testdata/rules/<rule-id>/<case>.jsonc` with `// want: error: …` annotations inline, in the style of Go's `analysistest`. The annotation sits on the line the diagnostic must target, so span correctness is tested implicitly. |
| **Schema translation** | Snapshot tests over the rewritten message for each error class |
| **CLI** | End-to-end tests over `testdata/projects/*` asserting stdout, stderr, and exit code |
| **Formatters** | Golden files; SARIF output validated against the SARIF 2.1.0 schema |
| **Corpus** | A vendored set of ~200 real `devcontainer.json` files harvested from public repos. CI asserts zero panics and snapshots the aggregate diagnostic counts — a diff in that snapshot forces a deliberate review of any rule change's blast radius. |
| **Fixes** | Every fixable rule has a `.jsonc` / `.fixed.jsonc` pair; the test applies fixes and asserts the result, then re-lints to assert convergence |
| **Extension** | `@vscode/test-electron` integration test asserting diagnostics appear for a fixture workspace |

The corpus test is the single highest-value item here: it is the difference between
"the rule works on my example" and "the rule does not produce a wall of false
positives on real-world configs".

---

## 12. Distribution

| Channel | Mechanism |
| --- | --- |
| GitHub Releases | GoReleaser, 6 platform archives + checksums + SBOM |
| `go install` | `go install github.com/lonhutt/dcx/cmd/dcx@latest` |
| Homebrew | Tap, updated by GoReleaser |
| Scoop | Bucket, updated by GoReleaser |
| Linux packages | `.deb`, `.rpm`, `.apk` via GoReleaser's nfpm |
| Docker | Distroless image, `ghcr.io/lonhutt/dcx` |
| pre-commit | `.pre-commit-hooks.yaml` with a `golang` hook and a binary-download hook |
| GitHub Action | Composite action wrapping the binary, uploading SARIF |
| VSCode | Marketplace + Open VSX, platform-specific VSIX |

### 12.1 Versioning policy

Semantic versioning. Rule IDs are public API:

- **Patch** — bug fixes, message improvements, fewer false positives.
- **Minor** — new rules (may cause new findings; release notes list them), new flags.
- **Major** — rule removal or rename, severity promotion to `error`, exit-code changes.

---

## 13. Milestones

| # | Milestone | Content | Exit criterion |
| --- | --- | --- | --- |
| **M0** | Foundations | Repo, `go.mod`, CI (test/lint/build matrix), `position`, `vfs`, `diagnostic` packages | CI green on all 6 platforms |
| **M1** | JSONC parser | Lexer, parser, CST, comment retention, error recovery, fuzzing | Parses the 200-file corpus with zero panics |
| **M2** | Schema layer | Vendored schemas, `go:embed`, 2019-09 validation, scenario discrimination, error translation | Every schema error class yields a human-readable message with an exact span |
| **M3** | Rule engine | `Rule` interface, registry, concurrent execution, config file, inline suppressions | Engine runs with a trivial rule set; suppressions tested |
| **M4** | Core rules | `syntax/`, `schema/`, `scenario/`, `semantic/`, `fs/`, `deprecation/` — 31 rules | Golden tests pass for each |
| **M5** | CLI | Discovery, all flags, `text`/`compact`/`json` output, exit codes | End-to-end tests pass; usable by hand |
| **M6** | Extended rules | `feature/` (offline), `port/`, `mount/`, `lifecycle/`, `security/`, `repro/`, `style/`, plus `meta/`, the four offline `vscode/` rules and the `policy` source — 37 rules | Corpus false-positive review complete |
| **M7** | Reporters + release | SARIF, GitHub annotations, GoReleaser, Homebrew, Docker, pre-commit, GH Action | `v0.1.0` published and installable |
| **M8** | VSCode extension v1 | CLI-driven diagnostics, binary bundling, platform VSIX, settings | Published to Marketplace + Open VSX |
| **M9** | Network rules | OCI feature resolution, cache, `--online`, option validation; `openvsx` and `vscode-gallery` sources and the three network `vscode/` rules (3 rules) | Feature option errors detected against real registries; Open VSX portability gap detected on a known-proprietary extension |
| **M10** | Fixes | `Fix` on fixable rules, `--fix`, `--fix-dry-run`, convergence tests | All rules marked *fixable* apply cleanly |
| **M11** | LSP server | `cmd/dcx`, diagnostics, code actions, hover, completion, links | Works in VSCode and Neovim |
| **M12** | Extension v2 | Switch to `LanguageClient`, delete Phase 1 path | Feature parity plus hover/completion |

M0–M7 constitute a genuinely useful, releasable tool. Everything after is additive.

---

## 14. Resolved Decisions

Every question from the review draft is now closed.

| # | Question | Resolution |
| --- | --- | --- |
| 1 | Compose validation depth | **Accepted.** Parse `docker-compose.yml` for the `services` key list only. No Compose semantics, no interpolation, no `extends`. Backs `scenario/compose-service-not-found`. |
| 2 | Does `extensions` honour `publisher.ext@1.2.3`? | **Deferred** → [D1](#15-deferred-backlog). Until verified, `vscode/extension-version-not-allowed` compares against policy pins only. |
| 3 | Gallery authentication | **Offline `policy` source only for now.** No OAuth, and no `token-command` helper in v1. Tracked as [D2](#15-deferred-backlog), low priority. |
| 4 | Auto-discover `extensions.allowed` | **Dropped — there is no valid in-repo location.** See §5.8.2. The finding instead produced a new rule, `vscode/ineffective-application-setting`. |
| 5 | Dockerfile cross-checks | **Accepted.** Exactly one check — `build.args` keys against `ARG` declarations — and explicitly nothing more. Ships as `semantic/build-arg-not-declared`. |
| 6 | `devcontainer-feature.json` linting | **Not in v1.** Tracked as [D3](#15-deferred-backlog). |
| 7 | Rule ID scheme | **`category/kebab-name`.** No numeric aliases. |
| 8 | Config file format | **YAML and JSON only.** No TOML, no bespoke format, nothing else. |

---

## 15. Deferred Backlog

Tracked work that is deliberately outside v1. Each is independently schedulable and
none blocks another.

### D1 — Verify `@version` support in the `extensions` array — *low*

VS Code's `extensions.allowed` policy definitively supports pinned and
platform-qualified versions (`"5.0.0@win32-x64"`). Whether a devcontainer's own
`customizations.vscode.extensions` array accepts a `@version` suffix is unverified.

- **Do:** test against the Dev Containers extension and the reference CLI; read how
  the extension list is passed to the install step.
- **If supported:** extend `vscode/extension-version-not-allowed` to check the
  requested pin against policy, and add a `repro/unpinned-extension` rule.
- **If not:** add a rule warning that a `@version` suffix is silently ignored.
- **Blocked by:** nothing. **Blocks:** nothing.

### D2 — Credential helper for gallery authentication — *low*

Today a `vscode-gallery` source takes a token via `token-env` only. Some users will
want `token-command: gh auth token` so no long-lived token sits in the environment.

- **Do:** add `token-command` to the source schema; execute it, trim, treat a
  non-zero exit as an unreachable source (warning, not error).
- **Explicitly still out of scope:** OAuth against
  `extensions.gallery.authProvider`. That decision does not get revisited here.
- **Blocked by:** M9. **Blocks:** nothing.

### D3 — Lint `devcontainer-feature.json` — *medium, post-v1*

A natural second target reusing the entire pipeline: parser, schema layer, rule
engine, reporters, and CLI all apply unchanged.

- **Shape:** `dcx feature ./src/my-feature`, with a `feature/*` schema
  vendored alongside the devcontainer schema and a new rule namespace.
- **Candidate rules:** required `id`/`version`/`name`; `id` matches the directory
  name; semver `version`; option `default` satisfies its own `enum`; `dependsOn` and
  `installsAfter` reference resolvable features; `install.sh` exists and is
  executable; `deprecated` features declare a replacement.
- **Why it fits:** the architecture already separates document kind from rule
  registry, so this is a new schema plus a new namespace, not a new tool.
- **Blocked by:** M7 (stable rule engine and reporters). **Blocks:** nothing.

---

## 16. Summary of Key Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Language | Go | Single binary, ~5 ms startup; the extension is a thin client either way |
| Parser | Hand-written JSONC CST | No Go library preserves comments *and* positions *and* recovers from errors |
| Schema | Vendored + `go:embed`, `santhosh-tekuri/jsonschema/v6` | Offline-deterministic; draft 2019-09 + `unevaluatedProperties` |
| Error quality | Discriminate scenario *before* validating | Turns `oneOf` noise into actionable prose — the core value of the project |
| Filesystem | `vfs.FS` abstraction everywhere | Unsaved editor buffers are the whole reason an LSP needs it |
| Positions | Byte offsets internally, converted at the edge | Terminal carets and LSP UTF-16 from one source of truth |
| Fixes | `Diagnostic.Fix` from rule #1 | Retrofitting fixes means rewriting every rule |
| Network | Off by default, degrades to warning | A linter that fails on a flaky registry gets disabled |
| Extension sources | Open VSX default; Marketplace opt-in | Marketplace ToS restricts offerings to Visual Studio products |
| Enterprise path | Consume VS Code's `extensions.allowed` verbatim | Offline, no auth, no new syntax — the org already wrote it |
| Source config | Definitions layered user+project; `required` project-only | Adding your own registry is personal; what the repo must support is a team decision |
| LSP location | `dcx serve`, same binary | One artefact to bundle, install, and version |
| Extension | Phase 1 CLI-driven, Phase 2 LSP | Ships value early; validates the JSON contract |
