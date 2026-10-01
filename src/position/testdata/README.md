# position test fixtures

`large-commented.jsonc` is a real `devcontainer.json` from
`Ilenburg1993/chatgpt-docker-puppeteer` (retrieved 2026-09-04). It had the widest gap
between bytes and characters in a survey of public configs; 1,885 non-ASCII
characters and 9 astral emoji across 1,558 lines. The median is about 1.7 KB, so this is
the far tail.

`mixed-script.jsonc` is hand-built to cover every width class and line terminator in one
file: CJK (2 columns), half-width katakana (1), a combining mark (0), tabs at the start
and middle of a line, an emoji, a ZWJ family (8 code units, 2 columns), a flag, and
`\n`, `\r\n` and a lone `\r`. The exact bytes matter; don't let an editor normalize the
line endings.
