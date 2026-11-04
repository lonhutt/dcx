# dcx

Lints `devcontainer.json` and `.devcontainer.json` as you type. Problems show up inline and in the Problems panel:

- typos in property names, with a suggestion (`postCreateComand` → `postCreateCommand`)
- values the schema doesn't allow, and values of the wrong type
- settings that don't fit the config's setup, like `image` in a Docker Compose config
- missing required properties, duplicate keys, and syntax errors

The same checks run from the command line with `dcx check`.
