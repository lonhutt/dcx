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

The same checks run from the command line with `dcx check`.
