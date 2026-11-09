# dcx

Lints `devcontainer.json` and `.devcontainer.json` as you type. Problems show up inline and in the Problems panel:

- typos in property names, with a suggestion (`postCreateComand` → `postCreateCommand`)
- values the schema doesn't allow, and values of the wrong type
- settings that don't fit the config's setup, like `image` in a Docker Compose config
- missing required properties, duplicate keys, and syntax errors

It also has quick fixes (and **dcx: Fix All Auto-fixable Problems**, or `source.fixAll.dcx`
in `editor.codeActionsOnSave`), hover docs and completion from the spec's schema, links to
the Dockerfile and Compose files, and go-to-definition from `"service"` to the Compose
service.

The same checks run from the command line and in CI; no VS Code needed.

## Command line and CI

With [Bun](https://bun.com):

```bash
bunx @craftbuild/dcx check
```

Or without anything installed, using a standalone binary from
[Releases](https://github.com/lonhutt/dcx/releases) (Linux, macOS and Windows).

In GitHub Actions, findings show up on the PR and in code scanning:

```yaml
- uses: lonhutt/dcx@v0.1.0
```

As a [pre-commit](https://pre-commit.com) hook:

```yaml
- repo: https://github.com/lonhutt/dcx
  rev: v0.1.0
  hooks:
    - id: dcx
```

Configuration (`.dcx.yaml`, which the extension reads too) is in the
[README](https://github.com/lonhutt/dcx#configuration), and every rule is explained in
[RULES.md](https://github.com/lonhutt/dcx/blob/main/RULES.md).
