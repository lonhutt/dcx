# position test fixtures

`large-commented.jsonc` — a real `devcontainer.json` from
`Ilenburg1993/chatgpt-docker-puppeteer`, retrieved 2026-09-04.

It is here because it is the widest gap between bytes and characters found in a
survey of public dev container configs: 86,007 bytes but 82,799 characters, with
1,885 non-ASCII characters and 9 astral-plane emoji across 1,558 lines. Every one
of those emoji is 4 UTF-8 bytes and 2 UTF-16 code units, which is exactly the case
a naive column implementation gets wrong.

Median real-world devcontainer.json is about 1.7 KB; this is the p100 tail.
