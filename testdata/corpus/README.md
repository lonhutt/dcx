# Corpus

Real-world `devcontainer.json` files from public GitHub repos with permissive licences,
one per repo, refreshed by hand with `bun scripts/corpus-fetch.ts` (never in CI).
`manifest.json` records where each one came from: repo, path, commit, licence, and the
date it was retrieved. Each file keeps its upstream licence.

`src/lint/corpus.test.ts` lints every file offline (no `fs/*` rules, since the Dockerfiles
and Compose files beside them aren't here) and checks:

- nothing throws or reports an internal error
- `security/hardcoded-secret` finds nothing
- per-rule counts match `counts.golden.json`

A change to `counts.golden.json` is a rule change's effect on real configs. Look at it
(`bun scripts/corpus-report.ts` prints hit rates with sample findings), then
`UPDATE=1 bun test src/lint/corpus.test.ts`.
