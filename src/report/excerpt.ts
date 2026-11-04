import { displayWidth, type LineIndex, type Range } from "../position/position";
import type { Paint } from "./color";

const CONTEXT = 2;
const TAB_WIDTH = 8;

/**
 * The source lines around `range` with a caret underline, gutter-numbered:
 *
 *    13 │   "dockerComposeFile": "docker-compose.yml",
 *    14 │   "image": "x",
 *       │   ^^^^^^^
 *
 * Tabs are expanded in the printed line so the caret, measured in display width, lines
 * up under it. A multi-line range is underlined to the end of its first line.
 */
export function excerpt(text: string, lines: LineIndex, range: Range, p: Paint): string {
  const first = lines.lineAt(range.start);
  const from = Math.max(0, first - CONTEXT);
  // a file's final newline leaves an empty last line; it isn't context worth printing
  const last =
    lines.lineCount -
    1 -
    (lines.lineCount > 1 && text.length === lines.lineStart(lines.lineCount - 1) ? 1 : 0);
  const to = Math.max(first, Math.min(last, first + CONTEXT));
  const width = String(to + 1).length;
  const gutter = (n?: number) =>
    p.dim(`${(n === undefined ? "" : String(n)).padStart(width + 1)} │`);

  const out: string[] = [];
  for (let line = from; line <= to; line++) {
    const { start, end } = lines.lineRange(line);
    const body = expandTabs(text.slice(start, end));
    out.push(`${gutter(line + 1)}${body && " " + body}`);
    if (line !== first) continue;
    const lineEnd = lines.lineRange(first).end;
    const startCol = lines.terminalPositionAt(range.start, TAB_WIDTH).column;
    const endCol = lines.terminalPositionAt(Math.min(range.end, lineEnd), TAB_WIDTH).column;
    const carets = "^".repeat(Math.max(1, endCol - startCol));
    out.push(`${gutter()} ${" ".repeat(startCol - 1)}${p.red(carets)}`);
  }
  return out.join("\n");
}

function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const run of line.split("\t").map((r, i, all) => [r, i < all.length - 1] as const)) {
    out += run[0];
    if (run[1]) out += " ".repeat(TAB_WIDTH - (displayWidth(out) % TAB_WIDTH));
  }
  return out;
}
