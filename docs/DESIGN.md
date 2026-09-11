# dcx — Design Document

**Status:** Draft for review
**Date:** 2026-09-10
**Language:** TypeScript on Bun (see [Language Decision](#2-language-decision))

---

## 1. Overview

`dcx` is a standalone static analyser for `devcontainer.json`, built against the
[Development Container Specification](https://containers.dev/implementors/spec/).

It is the first component of a three-part family:

| Component | Deliverable | Status |
| --- | --- | --- |
| **Core library** (`src/…`) | Reusable TypeScript modules: parse → model → analyze → diagnose | This doc |
| **CLI** (`src/cli`) | `dcx check` — for terminals, CI, pre-commit | This doc |
| **LSP server** (`src/server`) | `dcx serve` — the same package, over stdio | Designed for, built later |
| **VSCode extension** (`extensions/vscode`) | Imports the server in-process | This doc |

### 1.1 Goals

- **G1** — Catch every class of `devcontainer.json` defect that can be detected
  statically, with precise source spans and human-readable messages.
- **G2** — Ship as a single npm package with no runtime dependency beyond Bun or
  Node, and no native addons. Self-contained executables are available for
  environments without a JavaScript runtime.
- **G3** — Be architecturally ready for an LSP from day one: no global state, no
  direct filesystem access from rules, cancellable analysis, editor-accurate
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

**Chosen: TypeScript, running on Bun.**

### 2.1 Rationale

| Criterion | TypeScript / Bun | Go | Python |
| --- | --- | --- | --- |
| CLI distribution | npm package; optional 78 MB executable | Single ~2 MB static binary | Needs Python/uv |
| Cold start | **9 ms measured** (3 ms of which is process spawn) | ~5 ms | ~200–400 ms |
| JSON Schema 2019-09 + `unevaluatedProperties` | Ajv 2019, precompiled standalone | `santhosh-tekuri/jsonschema/v6` | `jsonschema` 4.x |
| JSONC parser with positions | **`jsonc-parser` — the parser VS Code itself uses** | Hand-rolled (~700 LOC) | Hand-rolled |
| LSP framework | `vscode-languageserver-node` — the reference implementation | `tliron/glsp`, `go.lsp.dev` | `pygls` |
| Extension integration | **In-process import; no subprocess, no binary to ship** | Spawn a per-platform binary | N/A |

The measurements above were taken on this machine against a trivial CLI: `bun
build --compile --minify --bytecode` produces a 78 MB executable that starts in 9 ms
median over 30 runs, against a 3 ms floor for `/bin/true`.

Three arguments decide it.

**The cold-start objection was aimed at Node, not at Bun.** A ~5 ms versus ~9 ms
difference, half of which is process-spawn overhead that any language pays, is not
something a human operating a linter can perceive. Startup latency is no longer a
differentiator; it was the load-bearing argument for a compiled language and it does
not survive measurement.

**`jsonc-parser` is not merely a convenient library — it is the parser VS Code
uses.** A linter for a JSONC file whose primary consumer is VS Code has exactly one
thing it must never get wrong: disagreeing with the editor about what the document
says. Adopting the editor's own parser makes that agreement structural rather than
aspirational. Every hand-rolled parser is a standing invitation to diverge on some
escape sequence or recovery decision, and that divergence surfaces as a false
positive in the one place it is least welcome.

**The extension stops being a client at all.** The argument for Go was that the
extension is a thin client either way, so sharing a language buys little. That holds
only while the server is a separate process. In TypeScript the server is an
`import`: no binary to resolve, no subprocess to spawn or supervise, no
platform-specific VSIX matrix, no version skew between an extension and a binary
released on a different cadence. §10.3 of the Go design specified six build targets
and a CI matrix to copy the right executable into `bin/` before packaging. That
entire section is deleted here rather than ported.

### 2.2 Accepted costs

- **78 MB executables.** Bun embeds a full JavaScript engine, and its own
  documentation concedes the binary is too big. This is a real and permanent loss
  against Go's ~2 MB. It is mitigated, not solved, by making npm the primary
  distribution channel (§12): the audience for a `devcontainer.json` linter runs
  Node already, and the extension ships no binary at all. Executables remain
  available for Docker images and runtime-free CI.
- **No native fuzzer.** Go's `testing.F` has no Bun equivalent. Property-based
  testing via `fast-check` covers the same ground with more setup (§11).
- **Ajv generates validator code at runtime.** That fits poorly with
  `--compile --bytecode`. We compile validators to standalone modules at build time
  instead (§5.5), which is better practice regardless — it makes schema compilation
  a build-time cost rather than a per-invocation one.
- **Single-threaded analysis.** Rules run sequentially rather than in goroutines.
  For a ~24 KB document this is not a real cost, and it removes a class of data race
  the Go design had to reason about (§5.6).
- **A dependency tree.** Go's ethos of near-zero dependencies is not available here.
  We hold the line at **three** runtime dependencies in the core — `jsonc-parser`,
  `ajv`, and `yaml` — each pinned in the lockfile, audited, and justified in §5. The
  LSP server entry point adds `vscode-languageserver` as an optional fourth (§9).

---

## 3. Specification Model

Facts extracted from the spec that drive the design. This section is
language-independent and is unchanged from the original design.

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
   LSP server ───────┤            src/lint (facade)           │
   Extension ────────┤   analyze(doc, options, signal)        │
                     └────────────────────┬───────────────────┘
                                          │
   ┌──────────────┬──────────────┬────────┴──────┬──────────────┬─────────────┐
   │  discovery   │    jsonc     │     model     │    rules     │   report    │
   │  locate the  │  jsonc-parser│  CST → typed  │  engine +    │  text/json/ │
   │  config file │  adapter→CST │  semantic AST │  registry    │  sarif/gh   │
   └──────┬───────┴──────┬───────┴───────┬───────┴──────┬───────┴─────────────┘
          │              │               │              │
   ┌──────┴──────┐ ┌─────┴─────┐  ┌──────┴──────┐ ┌─────┴──────┐ ┌───────────┐
   │     vfs     │ │ position  │  │   schema    │ │  features  │ │ diagnostic│
   │ overlay FS  │ │ LineIndex │  │ text-import │ │ OCI + cache│ │ Range/Fix │
   │ (unsaved    │ │ UTF-16↔   │  │ + standalone│ │  (network) │ │  Severity │
   │  buffers)   │ │ display   │  │ Ajv 2019    │ │            │ │           │
   └─────────────┘ └───────────┘  └─────────────┘ └────────────┘ └───────────┘
```

### 4.2 The five LSP-readiness invariants

These are the constraints that make a future language server a straightforward
addition rather than a rewrite. **Every one of them is cheap now and expensive later.**

1. **No `process.exit`, no thrown exception escaping the core, no `console.*` below
   `src/cli`.** The core returns values. Only the CLI entry point decides process
   fate. An exception that escapes `analyze()` takes down a language server that is
   expected to stay up for hours.
2. **All filesystem access goes through the `FileSystem` interface.** An editor holds
   unsaved buffers that do not exist on disk; the LSP supplies an overlay FS whose
   contents come from `textDocument/didChange`. A rule that calls `Bun.file` directly
   is unusable in an editor.
3. **Every diagnostic carries a `Range` of UTF-16 code-unit offsets.** This is the
   unit JavaScript strings are indexed in, the unit `jsonc-parser` reports, and the
   unit the LSP `Position` type is defined in — so the common path requires no
   conversion at all. Rendering a terminal caret needs a *display width*, not a byte
   count, and that conversion is `src/position`'s job (§5.2).
4. **`analyze()` accepts an `AbortSignal` and honours it.** Editors re-analyse on
   keystroke and abandon in-flight runs constantly.
5. **`Diagnostic` has an optional `fix?: TextEdit[]` from day one.** The CLI uses it
   for `--fix`; the LSP serves it as `textDocument/codeAction`. Retrofitting fixes
   onto a rule set built without them means touching every rule.

Invariant 3 is the one that changed direction from the original design, which
mandated byte offsets internally. In Go that was correct: strings are byte slices and
UTF-16 is foreign, so byte offsets are the natural internal unit and the LSP edge
pays the conversion. In JavaScript the same reasoning points the opposite way.
Holding byte offsets internally here would mean a `TextEncoder` round-trip at every
boundary — on entry from the parser, and again on exit to the editor — to arrive back
at the unit we started in.

### 4.3 Package layout

```
dcx/
├── package.json                 # subpath exports; bin: dcx
├── tsconfig.json
├── src/
│   ├── cli/                     # argv parsing, process exit, stdout — check, explain, feature
│   ├── server/                  # LSP server over stdio
│   ├── lint/                    # facade: analyze(), Document, Options
│   ├── vfs/                     # FileSystem interface, Bun impl, overlay impl
│   ├── position/                # Offset, Range, LineIndex, display-width conversion
│   ├── diagnostic/              # Diagnostic, Severity, Fix, TextEdit
│   ├── jsonc/                   # jsonc-parser adapter → CST + comment list
│   ├── discovery/               # config file location per spec §3.1
│   ├── schema/                  # vendored schemas + generated Ajv validators
│   ├── model/                   # typed semantic model over the CST
│   ├── features/                # feature ref parsing, OCI resolution, cache
│   ├── registry/                # extension-registry adapters (Open VSX, gallery, policy)
│   ├── lintconfig/              # .dcx.yaml loading + merge
│   ├── suppress/                # inline comment directive parsing
│   ├── rules/
│   │   ├── engine.ts            # registry, ordering, execution
│   │   ├── rule.ts              # Rule interface
│   │   └── <category>/          # one directory per rule category
│   └── report/                  # text, json, sarif, github formatters
├── schemas/                     # vendored upstream JSON schemas
├── scripts/                     # build-time codegen (Ajv standalone compilation)
├── testdata/                    # fixture corpus + golden files
└── extensions/vscode/           # VSCode extension
```

The public API surface is declared explicitly through `exports` in `package.json`
rather than by directory convention:

```json
{
  "exports": {
    ".":             "./src/lint/index.ts",
    "./diagnostic":  "./src/diagnostic/index.ts",
    "./rules":       "./src/rules/index.ts",
    "./server":      "./src/server/index.ts"
  }
}
```

Anything not listed is private and may change without a major version. This is
stricter than Go's `pkg/` convention, which exports every capitalised identifier in
every package whether or not that was intended.

Bun runs TypeScript sources directly, so there is no build step during development
and no `dist/` to keep in sync. The only generated artefacts are the standalone Ajv
validators (§5.5), produced by `scripts/` and committed.

---

## 5. Component Specifications

### 5.1 `src/jsonc` — the parser adapter

The original design called for a hand-written lexer and recursive-descent parser,
roughly 700 lines, justified by the absence of a Go library that preserves comments
*and* positions *and* recovers from errors. TypeScript has exactly that library, and
it is the one VS Code uses. `src/jsonc` is therefore an **adapter**, not a parser —
roughly 150 lines.

`jsonc-parser` supplies, directly:

| Requirement | Mechanism |
| --- | --- |
| CST with positions | `parseTree()` → nodes with `offset`, `length`, `type`, `colonOffset` |
| Error recovery | Parsing continues past faults; `ParseError[]` is an out-parameter |
| Duplicate keys preserved | Property children are a source-ordered list, not a map |
| Trailing commas | `allowTrailingComma` option; positions recovered via `visit()` |
| Node lookup by JSON Pointer | `findNodeAtLocation(root, path)` |
| Node lookup by offset | `findNodeAtOffset(root, offset)` — the LSP hover/completion primitive |
| Format-preserving edits | `modify()` / `applyEdits()` |

Two things it does not give us, which the adapter supplies:

**Comments are not tree nodes.** `parseTree()` discards them; `visit()` reports them
through an `onComment(offset, length, startLine, startChar)` callback. The adapter
runs `visit()` alongside `parseTree()` and collects comments into a source-ordered
side list, then attaches each to the property that follows it. Suppression directives
(§8.2) read from that list. This is a genuine ergonomic loss against a CST with
`Comment` nodes in it, and it is the main cost of the decision — but attaching by
offset is about twenty lines, and it buys the parser itself for free.

**Trailing commas are permitted, not reported.** With `allowTrailingComma: true` the
parse succeeds silently; with it `false` the position arrives as a `ParseError`. The
adapter parses permissively and locates trailing commas through `visit()`'s
`onSeparator` callback, recording them on the enclosing node so
`syntax/trailing-comma` can report a span.

The resulting `Document` is:

```ts
interface Document {
  readonly uri: string;
  readonly text: string;
  readonly root: Node | undefined;      // undefined for empty/unparseable input
  readonly comments: readonly Comment[];
  readonly errors: readonly ParseError[];
  readonly lines: LineIndex;
}
```

Rules consume `Document` and the re-exported `Node` type. Should `jsonc-parser` ever
need replacing, the blast radius is this directory.

**`modify()` and `applyEdits()` deserve particular note.** They perform
format-preserving edits against the *source text*, honouring the surrounding
indentation and leaving comments intact. In the Go design, every fixable rule had to
construct its own `TextEdit` spans by hand and the convergence tests existed largely
to catch mistakes in that arithmetic. Here, a rule that wants to move root
`extensions` into `customizations.vscode.extensions` expresses it as two `modify()`
calls against JSON paths. §13's M10 shrinks accordingly.

### 5.2 `src/position` — coordinates

Internally everything is a **UTF-16 code-unit offset**: the unit JavaScript string
indices use, the unit `jsonc-parser` emits, and the unit LSP `Position` is defined
in. Conversion to an LSP position is therefore a line lookup and a subtraction, with
no character re-encoding on the path an editor exercises on every keystroke.

`LineIndex` is built once per document — a single pass recording the offset of each
line start — and converts:

- offset → `{ line, character }` for LSP, by binary search over line starts
- offset → `{ line, column }` for terminal output, where *column* is a **display
  width**, not a code-unit count

The second conversion is the one that carries real complexity, and it is complexity
the original design did not account for. A caret rendered under a span must line up
with what the terminal actually draws, which means accounting for East Asian wide
characters (two columns), combining marks (zero), and tabs (to the next tab stop). A
byte count gets this wrong for exactly the same inputs a code-unit count does; the
Go design's "byte offset ↔ (line, UTF-8 column)" mapping would not have produced a
correctly aligned caret for a CJK container name either. We use
`Bun.stringWidth()`, which implements the width rules natively and requires no
dependency.

Surrogate pairs are the remaining subtlety. An emoji in a `name` field is one code
point, two UTF-16 code units, and two display columns. Ranges must never split a
surrogate pair; the adapter asserts this in development builds.

### 5.3 `src/vfs` — filesystem abstraction

```ts
interface FileSystem {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<Stats | undefined>;
  readDir(path: string): Promise<DirEntry[]>;
}
```

Two implementations: `BunFS` (the CLI, over `Bun.file`) and `OverlayFS` (the LSP —
in-memory documents layered over `BunFS`). Rules receive a `FileSystem` and never
import `Bun.file` or `node:fs` directly.

`stat` returns `undefined` rather than throwing on a missing path. The `fs/*` rules
(§6.5) exist precisely to report missing paths, so absence is an expected result, not
an exceptional one — and invariant 1 says exceptions do not escape the core.

### 5.4 `src/model` — semantic model

Lowers the CST into a typed structure, and — critically — **discriminates the
scenario** before schema validation runs:

```ts
type Scenario =
  | { kind: "unknown" }                                   // no container source found
  | { kind: "image";      image: Field<string> }
  | { kind: "dockerfile"; dockerfile: Field<string>; legacy: boolean }
  | { kind: "compose";    files: Field<string>[]; service: Field<string> | undefined }
  | { kind: "ambiguous";  sources: Field<unknown>[] }     // more than one of the above
  | { kind: "metadataOnly" };                             // valid: common properties only
```

A discriminated union rather than Go's `iota` enum, and the difference is not
cosmetic. The Go version carried a `Scenario` integer and left every consumer to
re-derive which fields were populated; here the payload travels with the tag, and a
`switch` over `kind` that forgets a case is a compile error under `strict`. The
`ambiguous` case carrying its conflicting sources is what lets
`scenario/conflicting-source` name both offenders with spans rather than reporting a
generic conflict.

Every field on the model retains a back-pointer to its CST node:

```ts
interface Field<T> {
  readonly value: T;
  readonly node: Node;     // for the span
}
```

Knowing the scenario is what converts `"must match exactly one schema in oneOf"` into
`"'image' and 'dockerComposeFile' cannot both be set: a Compose configuration takes
its image from the Compose file"`.

### 5.5 `src/schema` — schema validation

The upstream schemas are vendored into `schemas/` — the linter must work offline and
must not vary its behaviour with network conditions. A CI job checks the vendored
copy against upstream weekly and opens a PR on drift.

Where Go used `go:embed`, Bun uses a **text import**, which embeds the file contents
into the module graph at build time:

```ts
import baseSchema from "../../schemas/devContainer.base.schema.json" with { type: "text" };
```

In a compiled executable the text is stored once in the engine's own string
representation and handed back without a copy.

Validation uses **Ajv 2019** (`ajv/dist/2019`), which supports draft 2019-09
including `unevaluatedProperties`.

**Validators are compiled at build time, not at startup.** Ajv's normal mode
generates validator source and evaluates it with `new Function`. That is a poor fit
for a compiled executable with `--bytecode`, and it charges every single invocation
for compiling a 24 KB schema. Instead, `scripts/build-validators.ts` runs Ajv with
`code: { source: true, esm: true }` and writes standalone ESM modules into
`src/schema/generated/`, which are committed and imported like ordinary code. The
schema becomes a build-time input, dead code is eliminated by the bundler, and no
code is generated at runtime. The weekly drift job regenerates these alongside the
vendored schema, so a stale validator is a CI failure rather than a silent
divergence.

**Error translation is a first-class concern.** Ajv reports errors as
`{ instancePath, schemaPath, keyword, params, message }`, where `instancePath` is a
JSON Pointer. Raw output is routed through a translation layer that:

1. Uses the already-known `Scenario` to select the *relevant* `oneOf` branch and
   discard errors from the branches that were never applicable. Ajv reports every
   failed branch, so an unfiltered run against this schema produces dozens of errors
   for a single mistake — this step is what makes the output usable at all.
2. Maps `instancePath` to a CST node for an exact span. The pointer splits into path
   segments and goes straight into `findNodeAtLocation(root, path)`, so this is a
   lookup rather than a traversal we write ourselves.
3. Rewrites the message into prose, adding the enum's valid values (from
   `params.allowedValues`), a spelling suggestion for unknown properties
   (Levenshtein over the known key set), and a documentation link.

Ajv must run with `allErrors: true` so step 1 has a full set to filter.

### 5.6 `src/rules` — the rule engine

```ts
interface Rule {
  readonly id: string;                  // e.g. "security/docker-socket-mount"
  readonly description: string;
  readonly defaultSeverity: Severity;
  readonly category: Category;
  readonly requiresNetwork: boolean;
  check(pass: Pass): void | Promise<void>;
}

interface Pass {
  readonly doc: Document;               // CST + source text
  readonly model: DevContainer;
  readonly fs: FileSystem;
  readonly dir: string;                 // directory containing devcontainer.json
  readonly features: FeatureResolver | undefined;   // undefined when offline
  readonly signal: AbortSignal;
  report(d: Diagnostic): void;
}
```

Rules are registered by **explicit import into a manifest**, not by a side effect at
load time. Go's `init()`-based self-registration has no safe equivalent here: module
side effects run on import, and a bundler is free to drop or reorder a module whose
exports are unused. `src/rules/index.ts` lists every rule explicitly. The cost is one
line per rule; the benefit is that tree-shaking, test isolation, and rule ordering
all become predictable, and a rule that was never imported fails a registry
completeness test rather than silently not running.

The engine:

1. Filters by config (severity `off`) and by `requiresNetwork` when offline.
2. Runs offline rules **sequentially**, awaiting `null` between rules to yield to the
   event loop. Network-dependent rules run concurrently via `Promise.all`, since they
   are I/O-bound and that is where concurrency actually pays.
3. Collects diagnostics, applies inline suppressions, sorts by position.
4. Checks `signal.aborted` between rules for LSP cancellation.

Point 2 is a deliberate simplification of the Go design, which ran all rules
concurrently. For a document measured in kilobytes the offline rule set is
single-digit milliseconds of pure CPU work; parallelising it across workers would
cost more in structured-clone overhead than it saves. Sequential execution also makes
diagnostic ordering deterministic without a sort key tiebreaker, and removes any
question of two rules observing the model mid-mutation.

### 5.7 `src/features` — feature resolution

Offline, we can only check reference *syntax* and pinning. With `--online`, we fetch
each feature's `devcontainer-feature.json` from its OCI artifact to validate option
names and values against the declared `options` schema, and to surface `deprecated`.

OCI registry access is plain `fetch` against the distribution API — a token request
against the registry's auth endpoint, then a manifest fetch, then a blob fetch.
No client library is required and none is taken.

Cached under `$XDG_CACHE_HOME/dcx/features/` keyed by resolved digest, with a
configurable TTL. Network failures **degrade to a warning, never an error** — a
linter that fails closed on a flaky registry is a linter people disable.

### 5.8 `src/registry` — extension sources and policy

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

```ts
interface Source {
  readonly id: string;
  readonly requiresNetwork: boolean;
  lookup(publisher: string, name: string, signal: AbortSignal): Promise<Extension | undefined>;
}

interface Extension {
  readonly version: string;
  readonly deprecated: boolean;
  readonly downloadable: boolean;          // false ⇒ unpublished or removed
  readonly allowedVersions: string[] | undefined;  // from policy sources; undefined ⇒ unconstrained
  readonly targetPlatforms: string[];
}
```

Three implementations:

| Kind | Mechanism | Network | Auth |
| --- | --- | --- | --- |
| `openvsx` | `GET {base}/api/{namespace}/{name}`. Serves `open-vsx.org` and self-hosted instances identically. | yes | none |
| `vscode-gallery` | `POST {serviceUrl}/extensionquery` using VS Code's gallery protocol. Covers the Microsoft Marketplace, the Private Marketplace container, and any gallery implementing it. | yes | optional token |
| `policy` | Parses VS Code's own `extensions.allowed` object, from a file path or inline in our config. | **no** | none |

#### 5.8.1 Why `policy` is the recommended enterprise path

The Private Marketplace authenticates through `extensions.gallery.authProvider` —
a GitHub Enterprise or Entra ID sign-in flow, not a static token. **The linter does
not implement OAuth**, and should not: a CI job holding an interactive enterprise
identity is a bad idea regardless of effort.

For organisations, the `policy` source is both more tractable and more valuable. It
needs no credentials, no network, and no VPN; it answers the question that actually
bites — *will this extension install for our developers at all* — and it reads a file
the org has already written for a different purpose. Gallery queries remain available
for anyone who wants them, with a token supplied out-of-band.

#### 5.8.2 `extensions.allowed` cannot come from the repository

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
   in `.dcx.yaml` — inline, or a path to a policy file the org distributes by its own
   means. It is *our* input data, not a mirror of something VS Code reads from the repo.
2. **This is itself a lintable mistake**, and exactly the silent failure this project
   exists to catch. Hence `vscode/ineffective-application-setting`: it flags any
   application-scoped setting placed in `customizations.vscode.settings`, where it
   will be quietly discarded. The rule covers the whole application-scoped set, not
   just `extensions.allowed`.

#### 5.8.3 Configuration is layered, and split by ownership

Two different concerns are in play, and they have different owners.

- **Source definitions** (id, kind, url, credentials) may be declared in the project
  config *and* extended by a user-level config at `$XDG_CONFIG_HOME/dcx/config.yaml`.
  A developer on VSCodium can add Open VSX to their own checks without editing a
  shared file.
- **Policy** (which sources are `required`, and the `satisfy` mode) is
  **project-owned only**. It is a team decision about what this repo must support,
  and a user-level file must not be able to weaken it.

**Credentials are never literals.** A token is given as an env var name or a
credential-helper command, never a value. `.dcx.yaml` is a committed file, and we
ship a `security/hardcoded-secret` rule — inviting a PAT into our own config would be
indefensible. The loader rejects a literal-looking token outright.

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

This catalog describes the spec, not the implementation language, and is unchanged.

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
| `lifecycle/shell-syntax-in-array-form` | warning | Array form bypasses the shell; `&&`, `\|`, `>` will be literal arguments |
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

**Total: 71 rules across 15 categories** — syntax 3, schema 4, scenario 7, semantic 8,
fs 5, deprecation 4, feature 8, port 5, mount 4, lifecycle 4, security 6, vscode 7,
repro 3, style 2, meta 1.

---

## 7. CLI Design

### 7.1 Invocation

```
dcx check [flags] [path...]
```

`path` may be a `devcontainer.json` file, or a directory. With no path, the current
directory is used.

Argument parsing uses Bun's built-in `parseArgs` (`node:util`). No dependency is
taken for this; the flag set below is entirely expressible in it, and a CLI framework
would be the single largest dependency in the project for the least benefit.

### 7.2 Target resolution

Given a directory, resolve in spec precedence order:

1. `<dir>/.devcontainer/devcontainer.json`
2. `<dir>/.devcontainer.json`
3. `<dir>/.devcontainer/*/devcontainer.json` — **all** matches are linted

If none is found, exit 2 with a message naming the paths searched. `--recursive`
walks the tree for every dev container config beneath the target, honouring
`.gitignore`. `Bun.Glob` supplies the traversal.

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

Colour detection uses `Bun.color` and honours `NO_COLOR`, `FORCE_COLOR`, and TTY
detection in that order.

### 7.4 Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No diagnostics at or above the failure threshold |
| 1 | Lint findings at/above the threshold (default: any `error`) |
| 2 | Tool error: bad usage, unreadable file, no config found |

Separating 1 from 2 is what lets CI distinguish "your config is wrong" from "the
linter broke". Per invariant 1, `process.exit` is called in exactly one place —
`src/cli/main.ts` — and an unexpected exception is caught there, reported as an
internal error, and turned into exit 2.

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

Caret alignment uses the display-width conversion from §5.2, so the underline lines
up under non-ASCII content rather than drifting.

`compact` format is one line per diagnostic (`file:line:col: severity: message [id]`)
for editor `errorformat` integration and grep.

### 7.6 SARIF

SARIF 2.1.0 with `rules[]` populated from the registry, so GitHub code scanning shows
descriptions and help URIs. This makes the linter a first-class citizen in the
GitHub Security tab with no extra work from the user.

Regions are emitted as `startLine`/`startColumn`/`endLine`/`endColumn`. SARIF columns
are 1-based character offsets, which our UTF-16 offsets convert to directly; the
`byteOffset` properties the Go design would have used are optional and are omitted.

---

## 8. Configuration

### 8.1 File

`.dcx.yaml` (also `.yml`, `.json`) — **these three and nothing else; no TOML, no
bespoke format** — discovered by walking upward from the linted file to the
repository root.

YAML parsing uses the `yaml` package. This is the third and last runtime dependency.
Bun has no built-in YAML parser, and hand-rolling one to read a config file would be
the worst kind of not-invented-here.

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

The loaded config is validated by its own Ajv validator, generated by the same
build-time step as the devcontainer schema (§5.5), so a malformed `.dcx.yaml`
produces a diagnostic with a span rather than a runtime type error.

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

Directives are read from the comment side list produced by the parser adapter
(§5.1), matched to diagnostics by line.

---

## 9. LSP Integration Plan

The server is a **thin adapter**, not a second implementation. It is built once the
CLI rule set is stable (M11), and its existence is what §4.2's invariants pay for.

It uses `vscode-languageserver-node`, which is the reference implementation of the
protocol rather than a third-party binding — the same codebase VS Code's own language
servers are built on. It is a runtime dependency of the `./server` entry point only
and is declared `optional`, so installing `dcx` for CLI or CI use does not pull it
in. The core library never imports it.

### 9.1 Server surface

| Capability | Backed by |
| --- | --- |
| `textDocument/publishDiagnostics` | `analyze()` on open/change (debounced ~200 ms) |
| `textDocument/codeAction` | `Diagnostic.fix` — already produced by rules |
| `textDocument/hover` | Property descriptions from the embedded schema |
| `textDocument/completion` | Property names, enum values, feature IDs 🌐 |
| `textDocument/documentLink` | `build.dockerfile`, `dockerComposeFile`, local features |
| `textDocument/definition` | Jump from `service` to its Compose definition |
| `workspace/executeCommand` | "Fix all auto-fixable problems" |

Hover and completion both need "which node is under the cursor", which is
`findNodeAtOffset()` from the parser adapter — a function we get rather than write.

### 9.2 Mechanics

- Transport: stdio (`--stdio`), matching every editor's expectation.
- Sync: incremental (`TextDocumentSyncKind.Incremental`); `OverlayFS` holds buffers.
- Cancellation: each `didChange` aborts the previous analysis via its `AbortController`.
- Positions: offsets are already UTF-16 code units, so an LSP `Position` is a line
  lookup and a subtraction (§5.2).
- The server shares the CLI's config discovery, so a project's `.dcx.yaml` governs
  the editor identically.

### 9.3 One package, not two

The server is a **subcommand of the same package**, not a separate artefact:
`dcx serve --stdio` alongside `dcx check`. Three reasons:

1. **The server and the rule set change together.** A split would make every rule
   addition a two-artefact release with a version-skew window in between.
2. **Users install one thing.** `bun add -d dcx` gives you the CLI and the language
   server, and the extension needs nothing further.
3. **There is no packaging pressure to split.** The Go design had to weigh bundling
   one binary against two; here both are entry points in a package that the extension
   imports directly.

The `exports` surface in §4.3 stays documented and semver-stable regardless, so
extracting the server later remains possible if it ever grows its own release rhythm.

---

## 10. VSCode Extension

`extensions/vscode`, TypeScript, deliberately minimal — and substantially smaller
than the Go design's equivalent, because there is no binary to find, ship, version,
or spawn.

### 10.1 Two-phase plan

**Phase 1 (M8) — in-process, direct.** No LSP required. The extension imports the
lint facade directly, calls `analyze()` on open and on save, and populates a
`DiagnosticCollection`. Roughly 100 lines. There is no subprocess, no JSON parsing of
another process's stdout, and no error path for "the binary is missing".

**Phase 2 (M12) — LSP-driven.** Replace the direct call with
`vscode-languageclient`, running `src/server` in a Node IPC transport. Diagnostics
arrive over the protocol; hover, completion, code actions, and document links come
along with it. The Phase 1 code path is deleted, not maintained in parallel.

The reason to move to Phase 2 at all is not the extension — Phase 1 serves VS Code
perfectly well. It is Neovim, Helix, and Zed, which need a real server over stdio.

### 10.2 Binary resolution

None required. The Go design needed a three-step resolution order — `dcx.path`
setting, then a bundled binary in `bin/`, then `PATH` — plus a notification for the
case where all three failed. The extension bundles the analyser as JavaScript and
runs it in the extension host, so none of that exists.

A `dcx.path` setting is retained for one narrow case: pointing the extension at a
locally built checkout during development on dcx itself.

### 10.3 Packaging

One VSIX, all platforms. `bun build --target=node` bundles the extension and the
analyser into a single JavaScript file of roughly 200 KB, and `vsce package` ships
it.

This replaces the Go design's six platform-specific VSIX targets, the CI matrix that
copied the right executable into `bin/` before packaging, and the ~6 MB per-platform
payload. It is the single largest simplification in this document.

### 10.4 Activation and settings

Activation: `onLanguage:jsonc`, plus `workspaceContains:**/.devcontainer/devcontainer.json`
and `workspaceContains:**/.devcontainer.json`.

| Setting | Default | Description |
| --- | --- | --- |
| `dcx.enable` | `true` | Master switch |
| `dcx.path` | `""` | Point at a local checkout (development only) |
| `dcx.run` | `onSave` | `onSave` \| `onType` |
| `dcx.online` | `false` | Enable network rules |
| `dcx.configPath` | `""` | Explicit config file |
| `dcx.trace.server` | `off` | LSP tracing (Phase 2) |

Commands: *Lint Workspace*, *Fix All Auto-fixable Problems*, *Restart Server*,
*Show Output*.

---

## 11. Testing Strategy

`bun test` throughout — Jest-compatible API, built in, no runner dependency and no
transform configuration.

| Layer | Approach |
| --- | --- |
| **Parser adapter** | Table-driven unit tests over the adapter's additions: comment attachment, trailing-comma positions, error surfacing. We do not re-test `jsonc-parser` itself. |
| **Rules** | Golden-file tests: `testdata/rules/<rule-id>/<case>.jsonc` with `// want: error: …` annotations inline. The annotation sits on the line the diagnostic must target, so span correctness is tested implicitly. |
| **Schema translation** | Snapshot tests (`toMatchSnapshot`) over the rewritten message for each error class |
| **CLI** | End-to-end tests over `testdata/projects/*` asserting stdout, stderr, and exit code, driven through `Bun.$` |
| **Formatters** | Golden files; SARIF output validated against the SARIF 2.1.0 schema by a generated Ajv validator |
| **Corpus** | A vendored set of ~200 real `devcontainer.json` files harvested from public repos. CI asserts zero exceptions and snapshots the aggregate diagnostic counts — a diff in that snapshot forces a deliberate review of any rule change's blast radius. |
| **Fixes** | Every fixable rule has a `.jsonc` / `.fixed.jsonc` pair; the test applies fixes and asserts the result, then re-lints to assert convergence |
| **Property-based** | `fast-check` over the analyser: arbitrary JSONC input must never throw, and every reported range must be within document bounds and must not split a surrogate pair |
| **Extension** | `@vscode/test-electron` integration test asserting diagnostics appear for a fixture workspace |

Two notes on what changed.

**There is no native fuzzer.** Go's `testing.F` with coverage-guided mutation has no
Bun equivalent, and this is a genuine loss — it is the tool that finds the input you
did not think of. `fast-check` with a JSONC-shaped arbitrary plus a mutation pass over
the corpus covers most of the same ground, but through generators we have to write.
The mitigating factor is that the highest-risk component, the parser, is now a
widely-deployed library rather than 700 lines of our own recursive descent.

**The corpus test remains the single highest-value item here.** It is the difference
between "the rule works on my example" and "the rule does not produce a wall of false
positives on real-world configs".

---

## 12. Distribution

npm is the primary channel. The audience for a `devcontainer.json` linter overwhelmingly
has a JavaScript runtime already, and the payload difference is three orders of
magnitude — a published package of roughly 300 KB against a 78 MB executable.

| Channel | Mechanism | Payload |
| --- | --- | --- |
| **npm** | `bunx dcx check`, or `bun add -d dcx` / `npm i -D dcx` | ~300 KB |
| **Executables** | `bun build --compile --target=<t>` for the 8 supported targets; attached to GitHub Releases with checksums and SBOM | ~78 MB each |
| **Homebrew** | Tap wrapping the executable | ~78 MB |
| **Docker** | `ghcr.io/lonhutt/dcx`, `oven/bun`-based | ~120 MB |
| **pre-commit** | `.pre-commit-hooks.yaml` with a `node` hook, plus a binary-download hook | — |
| **GitHub Action** | Composite action running `bunx dcx`, uploading SARIF | — |
| **VSCode** | Marketplace + Open VSX, one VSIX for all platforms | ~200 KB |

Executables exist for the environments that genuinely have no runtime — a distroless
CI image, a bootstrapping script — and are honestly labelled as the heavyweight
option. Note that `bun build --compile` cross-compiles from any host to all eight
targets, so the release job is a single-runner loop rather than a matrix of runners.

Scoop and the Linux packages (`.deb`/`.rpm`/`.apk`) from the Go design are dropped.
GoReleaser produced them nearly for free; here each would be hand-rolled packaging
around a 78 MB payload for an audience already served by npm.

### 12.1 Versioning policy

Semantic versioning. Rule IDs are public API:

- **Patch** — bug fixes, message improvements, fewer false positives.
- **Minor** — new rules (may cause new findings; release notes list them), new flags.
- **Major** — rule removal or rename, severity promotion to `error`, exit-code changes.

The `exports` map in §4.3 is versioned on the same policy: adding a subpath is minor,
removing or narrowing one is major.

---

## 13. Milestones

| # | Milestone | Content | Exit criterion |
| --- | --- | --- | --- |
| **M0** | Foundations | Repo, `package.json`, CI (test/typecheck/lint), `position`, `vfs`, `diagnostic` modules | CI green; `position` round-trips the Unicode test corpus |
| **M1** | JSONC adapter | `jsonc-parser` wrapper, comment side-list and attachment, trailing-comma positions, `Document` type | Parses the 200-file corpus with zero exceptions; comment attachment verified against fixtures |
| **M2** | Schema layer | Vendored schemas, text imports, build-time Ajv standalone generation, scenario discrimination, error translation | Every schema error class yields a human-readable message with an exact span |
| **M3** | Rule engine | `Rule` interface, manifest registry, sequential execution, config file, inline suppressions | Engine runs with a trivial rule set; suppressions tested; registry completeness test passes |
| **M4** | Core rules | `syntax/`, `schema/`, `scenario/`, `semantic/`, `fs/`, `deprecation/` — 31 rules | Golden tests pass for each |
| **M5** | CLI | Discovery, all flags, `text`/`compact`/`json` output, exit codes | End-to-end tests pass; usable by hand |
| **M6** | Extended rules | `feature/` (offline), `port/`, `mount/`, `lifecycle/`, `security/`, `repro/`, `style/`, plus `meta/`, the four offline `vscode/` rules and the `policy` source — 37 rules | Corpus false-positive review complete |
| **M7** | Reporters + release | SARIF, GitHub annotations, npm publish, executables, Docker, pre-commit, GH Action | `v0.1.0` published and installable via `bunx` |
| **M8** | VSCode extension v1 | In-process diagnostics, single VSIX, settings | Published to Marketplace + Open VSX |
| **M9** | Network rules | OCI feature resolution, cache, `--online`, option validation; `openvsx` and `vscode-gallery` sources and the three network `vscode/` rules (3 rules) | Feature option errors detected against real registries; Open VSX portability gap detected on a known-proprietary extension |
| **M10** | Fixes | `fix` on fixable rules via `modify()`, `--fix`, `--fix-dry-run`, convergence tests | All rules marked *fixable* apply cleanly |
| **M11** | LSP server | `src/server`, diagnostics, code actions, hover, completion, links | Works in VSCode and Neovim |
| **M12** | Extension v2 | Switch to `LanguageClient`, delete Phase 1 path | Feature parity plus hover/completion |

M0–M7 constitute a genuinely useful, releasable tool. Everything after is additive.

M1, M8, and M10 are materially cheaper than their Go equivalents — the parser is a
wrapper rather than a recursive-descent implementation, the extension ships no
binary, and fixes are expressed as `modify()` calls against JSON paths rather than
hand-computed edit spans. M0 and M2 are slightly more expensive: `position` carries
display-width handling the Go design underspecified, and M2 gains a build-time
codegen step.

---

## 14. Resolved Decisions

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
| 9 | Runtime dependency budget | **Three in the core, and they are named:** `jsonc-parser`, `ajv`, `yaml`. Anything else must displace one of them or be written in-tree. The `./server` entry point adds `vscode-languageserver` as an optional dependency, not installed for CLI use. |
| 10 | Node compatibility | **Bun is the development and primary runtime; the published package must also run on Node 22+.** Bun-specific APIs (`Bun.file`, `Bun.Glob`, `Bun.stringWidth`) are confined to `src/vfs`, `src/cli`, and `src/position`, each behind a narrow interface with a Node fallback. The core is runtime-agnostic, which is also what lets the VSCode extension host run it unchanged. |

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

- **Do:** add `token-command` to the source schema; execute it via `Bun.$`, trim,
  treat a non-zero exit as an unreachable source (warning, not error).
- **Explicitly still out of scope:** OAuth against
  `extensions.gallery.authProvider`. That decision does not get revisited here.
- **Blocked by:** M9. **Blocks:** nothing.

### D3 — Lint `devcontainer-feature.json` — *medium, post-v1*

A natural second target reusing the entire pipeline: parser, schema layer, rule
engine, reporters, and CLI all apply unchanged.

- **Shape:** `dcx feature ./src/my-feature`, with a `feature/*` schema vendored
  alongside the devcontainer schema and a new rule namespace.
- **Candidate rules:** required `id`/`version`/`name`; `id` matches the directory
  name; semver `version`; option `default` satisfies its own `enum`; `dependsOn` and
  `installsAfter` reference resolvable features; `install.sh` exists and is
  executable; `deprecated` features declare a replacement.
- **Why it fits:** the architecture already separates document kind from rule
  registry, so this is a new schema plus a new namespace, not a new tool.
- **Blocked by:** M7 (stable rule engine and reporters). **Blocks:** nothing.

### D4 — Worker-parallel corpus linting — *low*

`--recursive` over a monorepo with hundreds of dev container configs is the one case
where single-threaded analysis (§5.6) could become noticeable. If it does, the fix is
`Worker` over *files*, not over rules: each worker owns a document end to end, so the
structured-clone cost is one string in and one diagnostic array out.

- **Trigger:** a measured `--recursive` run exceeding ~2 s on a real repository.
- **Blocked by:** M5. **Blocks:** nothing.

---

## 16. Summary of Key Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript on Bun | 9 ms measured start; the whole target ecosystem — parser, LSP framework, extension host — is TypeScript |
| Parser | `jsonc-parser` behind a thin adapter | It is the parser VS Code uses; agreeing with the editor becomes structural, not aspirational |
| Schema | Vendored + text import, Ajv 2019 compiled standalone at build time | Offline-deterministic; draft 2019-09 + `unevaluatedProperties`; no runtime codegen |
| Error quality | Discriminate scenario *before* validating | Turns `oneOf` noise into actionable prose — the core value of the project |
| Filesystem | `FileSystem` interface everywhere | Unsaved editor buffers are the whole reason an LSP needs it |
| Positions | UTF-16 code units internally; display width at the terminal edge | The unit the parser, the language, and the protocol already share |
| Rule registration | Explicit manifest, not load-time side effects | Bundler-safe and testable; `init()` has no safe equivalent |
| Concurrency | Sequential offline, concurrent for network I/O | Parallelism where it pays; determinism where it doesn't |
| Fixes | `Diagnostic.fix` from rule #1, via `modify()` | Retrofitting fixes means rewriting every rule; format-preserving edits come free |
| Network | Off by default, degrades to warning | A linter that fails on a flaky registry gets disabled |
| Extension sources | Open VSX default; Marketplace opt-in | Marketplace ToS restricts offerings to Visual Studio products |
| Enterprise path | Consume VS Code's `extensions.allowed` verbatim | Offline, no auth, no new syntax — the org already wrote it |
| Source config | Definitions layered user+project; `required` project-only | Adding your own registry is personal; what the repo must support is a team decision |
| LSP location | `dcx serve`, same package | One thing to install and version |
| Extension | Phase 1 in-process, Phase 2 LSP | Ships value early; Phase 2 exists for Neovim and Zed, not for VS Code |
| Distribution | npm primary, executables secondary | 300 KB against 78 MB, for an audience that has a runtime already |

---

## 17. Assessment

What this language choice actually costs and buys, stated plainly.

### 17.1 What got better

**The parser stops being ours.** §5.1 falls from ~700 lines of hand-written lexer and
recursive-descent parser to a ~150 line adapter, and — more importantly — the
remaining risk moves from our code to Microsoft's. For a tool whose correctness is
defined as *agreeing with VS Code about what this file says*, using VS Code's parser
is not a convenience but a correctness argument.

**The extension stops being a distribution problem.** Six platform-specific VSIX
targets, a CI matrix to place the right executable in `bin/`, a three-step binary
resolution order, and the whole class of "the bundled binary doesn't match the
extension version" bug are deleted rather than ported. One VSIX, ~200 KB, everywhere.

**Fixes get cheaper.** `modify()` / `applyEdits()` perform format-preserving edits
against JSON paths, so M10 stops being an exercise in hand-computed edit arithmetic.

**Positions get simpler.** UTF-16 offsets are what the parser emits, what the
language indexes strings by, and what the protocol is defined in. The conversion the
Go design had to perform on the editor's hottest path does not exist.

### 17.2 What got worse

**Binary size: 78 MB against roughly 2 MB, measured.** This is the real loss and
there is no mitigation that makes it go away — only the observation that npm, not the
executable, is now the path almost everyone takes. Anyone who genuinely needs a
runtime-free single file is worse off by a factor of forty.

**No coverage-guided fuzzer.** `fast-check` covers similar ground through generators
we write rather than mutation the tool discovers. Partly offset by the parser no
longer being ours to fuzz.

**A dependency tree.** Three runtime dependencies against Go's near-zero-dependency
norm, plus a transitive graph and a supply chain to watch. Decision 9 caps it.

**Single-threaded.** Immaterial for one document, potentially material for
`--recursive` over a monorepo. D4 holds the escape hatch.

### 17.3 The argument that did not survive

The Go design's §2.1 rested on TypeScript costing 150–300 ms to start. That figure
describes Node. Bun starts this CLI in **9 ms median over 30 runs**, of which 3 ms is
process-spawn overhead any language pays — against the ~5 ms the Go design claimed
for itself. A 4 ms difference on a tool a human invokes on save is not a
differentiator, and it was the load-bearing argument for compiling ahead of time.

What remains of the original case for Go is binary size, and binary size mattered
chiefly *because* the extension had to bundle the thing. In TypeScript it does not.
The two costs were load-bearing for each other, and neither stands alone.
