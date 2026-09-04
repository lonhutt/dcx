# dcx

[![CI](https://github.com/lonhutt/dcx/actions/workflows/ci.yaml/badge.svg)](https://github.com/lonhutt/dcx/actions/workflows/ci.yaml)
[![Go Reference](https://pkg.go.dev/badge/github.com/lonhutt/dcx.svg)](https://pkg.go.dev/github.com/lonhutt/dcx)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Static analysis for dev container configuration, built against the
[Development Container Specification](https://containers.dev/implementors/spec/).

> **Status: skeleton.** The repository layout and tooling are in place; no rules are
> implemented yet. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design.

## Why

The reference `devcontainers/cli` reads and merges `devcontainer.json` but performs no
schema validation. Editors that do validate produce unusable errors, because the
official schema's top level is a nest of `oneOf` branches — a missing `image` key
yields `must match exactly one schema in oneOf` rather than something you can act on.

`dcx` discriminates the configuration scenario itself, then reports:

```
.devcontainer/devcontainer.json:14:3: error: 'image' and 'dockerComposeFile' cannot
  both be set — a Compose configuration takes its image from the Compose file
  [scenario/conflicting-source]
```

## Install

```sh
go install github.com/lonhutt/dcx/cmd/dcx@latest
```

Release archives, Homebrew, Scoop, Linux packages and a container image are planned —
see Design §12.

## Usage

```
dcx check [path...]     Analyse devcontainer.json
dcx serve --stdio       Run the language server
dcx explain <rule-id>   Describe a rule
dcx feature <path>      Analyse devcontainer-feature.json
```

One binary, subcommands rather than separate tools — so the CLI, the language server,
and the editor extension all ship the same artefact.

## Planned surface

- **71 rules across 15 categories** — syntax, schema conformance, container-source
  discrimination, cross-field semantics, referenced-path existence, deprecations,
  Features, ports, mounts, lifecycle commands, security, VS Code customizations,
  reproducibility, style.
- **Offline by default.** Network-dependent rules are opt-in via `--online` and
  degrade to a warning when a registry is unreachable.
- **`text`, `compact`, `json`, `sarif`, and `github` output**, with exit code 1 for
  findings and 2 for tool errors so CI can tell them apart.
- **Editor support** via a VS Code extension and a language server sharing this core.

## Configuration

`.dcx.yaml` (also `.yml`, `.json`) in your repository, discovered by walking upward.
Rules can be suppressed inline, using the comments JSONC already allows:

```jsonc
{
  // dcx-disable-next-line security/docker-socket-mount
  "mounts": ["source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"]
}
```

## Contributing

Issues and pull requests: <https://github.com/lonhutt/dcx>

## Development

```sh
make check     # fmt-check, vet, lint, test — everything CI runs
make build     # build ./bin/dcx
make help      # list all targets
```

Requires Go 1.27+ and [golangci-lint](https://golangci-lint.run) v2.

## Layout

Everything under `pkg/` is public, semver-stable API; `cmd/` is not part of that
contract. See [`pkg/doc.go`](pkg/doc.go) and Design §4.3.

| Path | Purpose |
| --- | --- |
| `cmd/dcx/` | Single binary: check, serve, explain, feature |
| `pkg/jsonc/` | JSONC lexer and concrete syntax tree |
| `pkg/position/` | Byte offsets, UTF-8 columns, UTF-16 LSP positions |
| `pkg/vfs/` | Filesystem abstraction, including editor overlays |
| `pkg/diagnostic/` | Diagnostic, severity, range, fix |
| `pkg/model/` | Typed semantic model and scenario discrimination |
| `pkg/schema/` | Embedded JSON Schema and error translation |
| `pkg/rules/` | Rule interface, registry, engine |
| `pkg/report/` | Output formatters |
| `pkg/lint/` | Facade shared by the CLI, LSP, and extension |
| `schemas/` | Vendored upstream JSON schemas |
| `extensions/vscode/` | VS Code extension |

## License

MIT — see [LICENSE](LICENSE).
