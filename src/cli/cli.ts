import { relative } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { discoverDevcontainer } from "../discovery/discovery";
import { parse } from "../jsonc/jsonc";
import { lint } from "../lint/lint";
import { BunFS } from "../vfs/bunfs";

const HELP = `Usage: dcx check [path]

Lints devcontainer.json. path is the file, or a directory to find it in
(default: the current directory).

Options:
  -h, --help     Show this help
  -v, --version  Show the version

Exit codes: 0 no problems, 1 problems found, 2 dcx couldn't run.`;

/**
 * Runs the CLI and resolves to its exit code. Problems go to stdout, one per line as
 * `file:line:col: error: message [rule]`; anything stopping the run goes to stderr.
 */
export async function run(args: string[]): Promise<number> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
    }));
  } catch (err) {
    return usage((err as Error).message);
  }
  if (values.help) return (console.log(HELP), 0);
  if (values.version) return (console.log(pkg.version), 0);
  const [command, target, ...extra] = positionals;
  if (command !== "check")
    return usage(command ? `unknown command "${command}"` : "no command given");
  if (extra.length) return usage(`unexpected argument "${extra[0]}"`);

  const fs = new BunFS();
  try {
    const { targets, searched } = await discoverDevcontainer(fs, target);
    if (!targets.length) {
      console.error(`dcx: no devcontainer.json found; looked for:\n  ${searched.join("\n  ")}`);
      return 2;
    }
    let problems = 0;
    for (const path of targets) {
      const doc = parse(path, await fs.readFile(path));
      for (const d of lint(doc)) {
        const { line, column } = doc.lines.terminalPositionAt(d.range.start);
        console.log(
          `${relative(process.cwd(), path)}:${line}:${column}: error: ${d.message} [${d.rule}]`,
        );
        problems++;
      }
    }
    return problems ? 1 : 0;
  } catch (err) {
    console.error(`dcx: ${(err as Error).message}`);
    return 2;
  }
}

function usage(problem: string): number {
  console.error(`dcx: ${problem}\n\n${HELP}`);
  return 2;
}
