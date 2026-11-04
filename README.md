# dcx

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

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
- this README: the version in the dev container description above
- `package.json`: `engines.bun` (only if the minimum supported version changes)
