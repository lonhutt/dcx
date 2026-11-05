import { homedir } from "node:os";
import { check, HELP, versionString, type Io } from "./check";
import { ToolError, UsageError } from "./errors";
import { serve } from "./serve";

/**
 * Runs the CLI and resolves to its exit code: 0 clean, 1 findings at or above the
 * failure threshold, 2 dcx couldn't run. Never throws, and never exits the process.
 */
export async function run(args: string[], io: Io = processIo()): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === "-h" || command === "--help") return (io.stdout(HELP + "\n"), 0);
    if (command === "-v" || command === "--version") return (io.stdout(versionString() + "\n"), 0);
    if (command === "serve") return await serve(rest, io);
    if (command !== "check")
      throw new UsageError(command ? `unknown command "${command}"` : "no command given");
    return await check(rest, io);
  } catch (err) {
    if (err instanceof UsageError) io.stderr(`dcx: ${err.message}\n\n${HELP}\n`);
    else if (err instanceof ToolError) io.stderr(`dcx: ${err.message}\n`);
    else io.stderr(`dcx: internal error: ${(err as Error)?.stack ?? String(err)}\n`);
    return 2;
  }
}

function processIo(): Io {
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
    isTTY: !!process.stdout.isTTY,
    home: homedir(),
  };
}
