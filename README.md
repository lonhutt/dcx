# devcontainer-lint

A standalone static analyser for `devcontainer.json`, built against the
[Development Container Specification](https://containers.dev/implementors/spec/).

> **Status: skeleton.** The repository layout and tooling are in place; no rules are
> implemented yet. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design.

## Why

The reference `devcontainers/cli` reads and merges `devcontainer.json` but performs no
schema validation. Editors that do validate produce unusable errors, because the
official schema's top level is a nest of `oneOf` branches — a missing `image` key
yields `must match exactly one schema in oneOf` rather than something you can act on.

devcontainer-lint discriminates the configuration scenario itself, then reports:

```
.devcontainer/devcontainer.json:14:3: error: 'image' and 'dockerComposeFile' cannot
  both be set — a Compose configuration takes its image from the Compose file
  [scenario/conflicting-source]
```

## Planned surface

- **71 rules across 15 categories** — syntax, schema conformance, container-source
  discrimination, cross-field semantics, referenced-path existence, deprecations,
  Features, ports, mounts, lifecycle commands, security, VS Code customizations,
  reproducibility, style.
- **Offline by default.** Network-dependent rules are opt-in via `--online` and
  degrade to a warning when a registry is unreachable.
- **`text`, `compact`, `json`, `sarif`, and `github` output**, with exit code 1 for
  findings and 2 for tool errors so CI can tell them apart.
- **Editor support** via a VS Code extension and, later, a language server sharing
  this same core.

## Development

```sh
make check     # fmt-check, vet, lint, test — everything CI runs
make build     # build ./bin/devcontainer-lint
make help      # list all targets
```

Requires Go 1.27+ and [golangci-lint](https://golangci-lint.run) v2.

## Layout

Everything under `pkg/` is public, semver-stable API; `cmd/` is not part of that
contract. See [`pkg/doc.go`](pkg/doc.go) and Design §4.3.

| Path | Purpose |
| --- | --- |
| `cmd/devcontainer-lint/` | CLI entry point |
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
