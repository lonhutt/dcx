import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  commands,
  ConfigurationTarget,
  extensions,
  languages,
  Position,
  window,
  workspace,
  type CompletionList,
  type Hover,
  type MarkdownString,
  type Uri,
} from "vscode";

const TIMEOUT_MS = 20_000;

async function until<T>(what: string, check: () => T | undefined | Promise<T | undefined>) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// VS Code's own JSON support reports on the same file; only dcx's findings count
const ours = (uri: Uri) => languages.getDiagnostics(uri).filter((d) => d.source === "dcx");
const codes = (uri: Uri) =>
  ours(uri).map((d) => (typeof d.code === "object" ? d.code.value : d.code));
const linted = (uri: Uri) =>
  until("dcx diagnostics", () => codes(uri).includes("schema/unknown-property") || undefined);

// pgrep, so this suite only runs where pgrep does; CI runs it on Linux
function serverPids(serverPath: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", serverPath], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** Runs inside VS Code's extension host, against the workspace e2e/run.ts opened. */
export async function run(): Promise<void> {
  const extension = extensions.getExtension("lonhutt.dcx")!;
  await extension.activate();
  const serverPath = join(extension.extensionPath, "dist", "server.js");
  const folder = workspace.workspaceFolders![0]!.uri;
  const uri = folder.with({ path: `${folder.path}/.devcontainer/devcontainer.json` });
  const editor = await window.showTextDocument(await workspace.openTextDocument(uri));

  const steps: [string, () => Promise<void>][] = [
    ["diagnostics come from the bundled server", () => linted(uri).then(() => {})],
    [
      "hover",
      async () => {
        const hovers = await commands.executeCommand<Hover[]>(
          "vscode.executeHoverProvider",
          uri,
          new Position(1, 4),
        );
        const text = hovers.flatMap((h) => h.contents.map((c) => (c as MarkdownString).value));
        ok(
          text.some((t) => t.includes("**name**")),
          text.join("\n"),
        );
      },
    ],
    [
      "completion",
      async () => {
        const list = await commands.executeCommand<CompletionList>(
          "vscode.executeCompletionItemProvider",
          uri,
          new Position(1, 2),
        );
        ok(list.items.some((i) => i.label === "forwardPorts"));
      },
    ],
    [
      "fix all from the command palette",
      async () => {
        await commands.executeCommand("dcx.fixAll");
        await until("the fix", () => editor.document.getText().includes('"customizations"'));
      },
    ],
    [
      "restart brings back a server that crashed past the client's own retries",
      async () => {
        // the client restarts a crashed server 4 times in 3 minutes, then gives up
        for (let i = 0; i < 10; i++) {
          const pid = await until("a server process", () => serverPids(serverPath)[0]);
          process.kill(pid, "SIGKILL");
          await new Promise((r) => setTimeout(r, 1000));
          if (!serverPids(serverPath).length) break;
        }
        strictEqual(serverPids(serverPath).length, 0, "the client should have given up");
        await commands.executeCommand("dcx.restartServer");
        await until("a new server process", () => serverPids(serverPath).length || undefined);
        // a finding on new text, so diagnostics left over from before the crash don't count
        await editor.edit((e) => e.insert(new Position(1, 2), '"imagee": "x", '));
        await until("a finding from the new server", () =>
          ours(uri).some((d) => d.message.includes('"imagee"')),
        );
      },
    ],
    [
      "dcx.enable: false stops the server",
      async () => {
        await workspace
          .getConfiguration("dcx")
          .update("enable", false, ConfigurationTarget.Workspace);
        await until("the server to stop", () => !serverPids(serverPath).length || undefined);
        await until(
          `dcx's diagnostics to clear (still ${JSON.stringify(codes(uri))})`,
          () => !codes(uri).length || undefined,
        );
      },
    ],
  ];

  for (const [name, step] of steps) {
    console.log(`- ${name}`);
    await step();
  }
}
