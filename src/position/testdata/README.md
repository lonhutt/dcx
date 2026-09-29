# position test fixtures

`large-commented.jsonc` — a real `devcontainer.json` from
`Ilenburg1993/chatgpt-docker-puppeteer`, retrieved 2026-09-04. The widest gap between
bytes and characters found in a survey of public dev container configs: 1,885 non-ASCII
characters and 9 astral-plane emoji across 1,558 lines. The p100 tail; the median
real-world `devcontainer.json` is about 1.7 KB.

`mixed-script.jsonc` — hand-built to put every width class and every line terminator
on one page: CJK (2 columns), half-width katakana (1), a combining mark (0), tabs at
line start and mid-line, an astral emoji, a ZWJ family (one 2-column glyph from 8 code
units), a flag, and `\n`, `\r\n` and a lone `\r`. Its exact bytes matter — do not let
an editor normalise its line endings.
