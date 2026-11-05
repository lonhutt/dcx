import { format } from "node:util";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import {
  createConnection,
  createProtocolConnection,
  type WatchDog,
} from "vscode-languageserver/lib/common/api";
import { startServer } from "../server/server";
import { DiskFS } from "../vfs/diskfs";
import type { Io } from "./check";
import { UsageError } from "./errors";

const PARENT_POLL_MS = 3000;
// messages read before stdin closed are still queued; a closing client's shutdown and
// exit usually are, and should still be answered
const DRAIN_MS = 1000;

/**
 * `dcx serve --stdio`: the language server over stdin and stdout. Resolves the exit code
 * once the client says exit (0 after a shutdown, 1 without), or once its stdin closes or
 * the editor process that started it is gone.
 */
export function serve(args: string[], io: Io): Promise<number> {
  if (args.length !== 1 || args[0] !== "--stdio")
    throw new UsageError('serve takes exactly one flag, "--stdio"');

  // nothing but LSP framing may reach stdout; a stray console.log anywhere would corrupt it
  const toStderr = (...a: unknown[]) => void process.stderr.write(format(...a) + "\n");
  Object.assign(console, { log: toStderr, info: toStderr, debug: toStderr, warn: toStderr });

  return new Promise((resolve) => {
    let shutdownReceived = false;
    let parent: ReturnType<typeof setInterval> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearInterval(parent);
      clearTimeout(drain);
      server.dispose();
      connection.dispose();
      process.stdin.destroy();
      resolve(code);
    };
    // the library's own watchdog calls process.exit; this one hands the code back instead
    const watchDog: WatchDog = {
      get shutdownReceived() {
        return shutdownReceived;
      },
      set shutdownReceived(value) {
        shutdownReceived = value;
      },
      initialize({ processId }) {
        if (typeof processId !== "number") return;
        parent = setInterval(() => {
          try {
            process.kill(processId, 0);
          } catch {
            finish(1);
          }
        }, PARENT_POLL_MS);
      },
      exit: finish,
    };
    const connection = createConnection(
      (logger) =>
        createProtocolConnection(
          new StreamMessageReader(process.stdin),
          new StreamMessageWriter(process.stdout),
          logger,
        ),
      watchDog,
    );
    process.stdin.on("end", () => {
      drain = setTimeout(() => finish(shutdownReceived ? 0 : 1), DRAIN_MS);
    });
    const server = startServer(connection, { fs: new DiskFS(), env: io.env, home: io.home });
  });
}
