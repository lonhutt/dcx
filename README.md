# dcx

A linter for `devcontainer.json`. It catches the mistakes the dev container CLI doesn't
tell you about until a build fails, or never tells you about at all: typos in property
names, properties that don't apply to the kind of config you have, Dockerfiles and
Compose services that don't exist, mounts that collide, extensions that won't install
for half the team, tokens committed in plain text.

```console
$ bunx dcx check
.devcontainer/devcontainer.json:4:3: warning: Unknown property "postCreateComand"; did you mean "postCreateCommand"? [schema/unknown-property]

 2 │   "name": "api",
 3 │   "image": "mcr.microsoft.com/devcontainers/typescript-node:1-22",
 4 │   "postCreateComand": "npm ci",
   │   ^^^^^^^^^^^^^^^^^^
 5 │ }

  help: rename it to "postCreateCommand"
  docs: https://containers.dev/implementors/json_reference/#general-properties

⚠ 1 warning in 1 file
```

There are 72 rules; [RULES.md](RULES.md) lists them all, with an explanation of each.

## Install

dcx runs on [Bun](https://bun.com) 1.4 or later.

```bash
bunx dcx check            # no install
bun add -d dcx            # or as a dev dependency
```

## Usage

```
dcx check [flags] [path...]
```

Each path is a `devcontainer.json`, or a directory to look in (default: the current
directory). For a directory, dcx looks where the dev container CLI does:
`.devcontainer/devcontainer.json`, then `.devcontainer.json`, then every
`.devcontainer/<folder>/devcontainer.json` (all of them, not just the first).

| Flag                            |                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `--format <fmt>`                | `text` (default), `json`, `compact`, `sarif`, `github`                         |
| `--config <path>`               | Use this config file; skips discovery                                          |
| `--no-config`                   | Ignore any project config                                                      |
| `--online` / `--offline`        | Run the rules that need network access; offline is the default                 |
| `--rule <id>`                   | Run only this rule (repeatable); turns it on if it's off by default            |
| `--disable <id>`                | Turn a rule off (repeatable)                                                   |
| `--severity <id>=<sev>`         | Set one rule's severity: `error`, `warning`, `info`, `off`                     |
| `--max-severity <sev>`          | Cap every finding at this severity                                             |
| `--error-on-warning`            | Exit 1 for warnings too                                                        |
| `--fix`                         | Apply the automatic fixes in place                                             |
| `--fix-dry-run`                 | Print the diff `--fix` would apply                                             |
| `--color <when>` / `--no-color` | `auto` (default), `always`, `never`; `NO_COLOR` and `FORCE_COLOR` are honoured |
| `-q`, `--quiet`                 | No summary line                                                                |
| `--explain <id>`                | Explain a rule                                                                 |
| `--list-rules`                  | Print the rule catalog (`--format json` for the machine-readable one)          |

Exit codes: **0** nothing at or above the failure threshold, **1** findings, **2** dcx
couldn't run (bad flags, no config found, an unreadable file, a broken `.dcx.yaml`).
Keeping 1 and 2 apart is what lets CI tell "the config is wrong" from "the linter broke".

### Online rules

`--online` turns on seven rules that need the network: four check feature options
against the feature's own metadata (fetched from its registry and cached under
`$XDG_CACHE_HOME/dcx`), and three check extensions against marketplaces. A registry or
marketplace dcx can't reach is a warning on stderr, never a failed run; self-hosted
galleries are often VPN-only.

## Configuration

dcx reads the nearest `.dcx.yaml` (or `.dcx.yml`, `.dcx.json`) walking up from the
target, stopping at the repository root, plus a user config at
`$XDG_CONFIG_HOME/dcx/config.yaml`. Flags beat `DCX_ONLINE`/`DCX_FAIL_ON`, which beat
the project config, which beats the user config.

```yaml
fail-on: error # exit 1 at or above this: error, warning, info
online: false

rules:
  style/missing-name: off
  repro/image-no-digest: warning
categories:
  security: error

exclude: # gitignore syntax, relative to this file
  - examples/

features:
  allow-unpinned: # features you've decided to track at latest
    - ghcr.io/devcontainers/features/common-utils
  cache-ttl: 24h

# where extensions come from; see "Extension sources" below
extension-sources:
  - id: org
    kind: policy
    path: ./org-extension-policy.json
  - id: open-vsx
    kind: openvsx
    url: https://open-vsx.org
    required: true
extensions:
  satisfy: all # an extension must be in every required source (or "any")
```

### Extension sources

There's no one place extensions come from, and that's the point of these rules:
Microsoft's proprietary extensions aren't on Open VSX, so a config that works in
VS Code silently comes up without them in VSCodium, Cursor or Gitpod.

- **`policy`** reads a VS Code `extensions.allowed` policy, from a file (bare, or a
  settings.json holding one) or inline as `allowed:`. Offline; this is the one to use
  for an organisation, since it answers "will this install for our developers at all"
  from a file the org already wrote. It can't come from the repository itself: VS Code
  ignores `extensions.allowed` anywhere but user settings, on purpose
  (`vscode/ineffective-application-setting` catches the attempt).
- **`openvsx`** queries an Open VSX registry; a self-hosted one is just a different `url`.
  With `--online` and no sources configured, dcx checks Open VSX.
- **`vscode-gallery`** queries a VS Code gallery (the Microsoft Marketplace, or a
  Private Marketplace) at `url`. Never on by default: the Marketplace's terms limit it to
  Microsoft's own products. A token goes in an environment variable, named by
  `token-env`; dcx refuses a config that holds a token itself.

`required` and `extensions.satisfy` can only be set in the project config; a user
config can add sources, not weaken what the project requires.

### Suppressing a finding

```jsonc
{
  // dcx-disable-next-line security/privileged -- docker-in-docker needs it
  "privileged": true,
  "appPort": 3000, // dcx-disable-line deprecation/app-port
}
```

`dcx-disable-file` in the file's leading comment block covers the whole file. Leaving out
the rule ID covers every rule. A directive that suppresses nothing is itself reported
(`meta/unused-suppression`), so they don't pile up after the problem's gone.

## CI

### GitHub Actions

```yaml
- uses: lonhutt/dcx@v0.1.0
  with:
    path: . # default
    online: false # default
```

Findings show up as annotations on the PR and in code scanning (the action uploads
SARIF; give the job `security-events: write`).

### pre-commit

```yaml
- repo: https://github.com/lonhutt/dcx
  rev: v0.1.0
  hooks:
    - id: dcx
```

The hook runs `bunx dcx@0.1.0 check` with the Bun on your PATH, so it needs Bun installed;
pre-commit doesn't install it.

## JSON output

`--format json` is a compatibility contract: the shape below only changes in a
backwards-incompatible way with a new `version` (and a new major version of dcx).
Adding an optional field isn't such a change.

```jsonc
{
  "version": "1",
  "files": [
    {
      "path": ".devcontainer/devcontainer.json",   // relative to the working directory
      "diagnostics": [
        {
          "ruleId": "schema/unknown-property",
          "severity": "warning",                    // error | warning | info
          "message": "Unknown property \"nmae\"; did you mean \"name\"?",
          "help": "rename it to \"name\"",          // optional
          "docsUrl": "https://containers.dev/...",  // optional
          "range": {
            // offset: UTF-16 code units; line: 1-based; column: 1-based display width
            "start": { "offset": 30, "line": 4, "column": 3 },
            "end": { "offset": 36, "line": 4, "column": 9 }
          },
          "related": [{ "range": { ... }, "message": "..." }],             // optional
          "fix": { "title": "...", "edits": [{ "range": { ... }, "newText": "..." }] }, // optional
          "suppressed": true,                       // only on a suppressed finding
          "suppressReason": "..."                   // optional
        }
      ]
    }
  ],
  "summary": { "errors": 0, "warnings": 1, "infos": 0, "files": 1 }
}
```

Suppressed findings are included, marked, so a consumer can show why something was
silenced; every other format leaves them out.

## Editors

The VS Code extension in `extensions/vscode` runs the same rules as you type. Settings:
`dcx.enable`, `dcx.run` (`onSave` or `onType`), `dcx.online`, `dcx.configPath`.

### Language server

`dcx serve --stdio` is a language server for any editor that speaks LSP. It finds
`.dcx.yaml` the same way `dcx check` does, so the editor and CI agree. It provides:

- diagnostics as you type (debounced; a newer edit cancels the older run)
- quick fixes, and `source.fixAll.dcx` (or the `dcx.fixAll` command) for every fix at once
- hover and completion from the spec's own schema
- links to the Dockerfile, Compose files and local features, and go-to-definition from
  `"service"` to its Compose service

`initializationOptions` takes `online` and `configPath`, as the extension settings of
the same names. Point the client at `devcontainer.json` and `.devcontainer.json`; the
server ignores any other file it's sent, apart from keeping it in sync.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
bun run format
```

`bun run rules-doc` regenerates RULES.md after a rule changes; a test fails until it's
regenerated. `UPDATE=1 bun test` rewrites golden files and fixture annotations, for
when a change in output is the point. `bun scripts/corpus-fetch.ts` refreshes the
real-world corpus in `testdata/corpus` (by hand, never in CI).

## Dev container

The repo has its own dev container in `.devcontainer/` (Bun 1.4.2 on Debian slim, plus git and gh); the same config gets linted by `dcx check` in CI.

To use it, open the repo in VS Code and run **Dev Containers: Reopen in Container**. Or from the CLI:

```bash
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bun test
```

The post-create step pulls the `devcontainer-spec` submodule and runs `bun install`, so there's nothing else to set up.

### Bumping Bun

The Bun version is pinned in more than one place; bump all of them together:

- `.devcontainer/Dockerfile`: the `FROM oven/bun:<version>-slim` tag
- `.github/workflows/ci.yaml`: `bun-version` in each of the three jobs (test, check, build smoke)
- `action.yml`: `bun-version` in the setup step
- this README: the version in the dev container description above
- `package.json`: `engines.bun` (only if the minimum supported version changes)
