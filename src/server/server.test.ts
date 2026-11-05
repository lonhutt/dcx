import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { join } from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { check, type Io } from "../cli/check";
import { LineIndex } from "../position/position";
import { lspPair } from "../testutil/lsp";
import { MemFS } from "../vfs/memfs";
import { CAPABILITIES } from "./server";
import { analyzer } from "./diagnostics";

const PATH = join("/w", ".devcontainer", "devcontainer.json");
const CLEAN = '{\n  "name": "x",\n  "image": "node:22"\n}\n';

let pair: ReturnType<typeof lspPair> | undefined;
const start = (files: Record<string, string> = {}) => (pair = lspPair({ fs: new MemFS(files) }));
afterEach(async () => {
  await pair?.dispose();
  pair = undefined;
});

describe("lifecycle", () => {
  test("initialize advertises exactly CAPABILITIES; shutdown then exit is a clean exit", async () => {
    const p = start();
    expect((await p.initialize()).capabilities).toEqual(JSON.parse(JSON.stringify(CAPABILITIES)));
    await p.request("shutdown", {});
    await p.client.sendNotification("exit");
    await Bun.sleep(20);
    expect(p.exitCode()).toBe(0);
  });

  test("exit without shutdown is exit code 1", async () => {
    const p = start();
    await p.initialize();
    await p.client.sendNotification("exit");
    await Bun.sleep(20);
    expect(p.exitCode()).toBe(1);
  });
});

// every advertised capability, and the request a client sends for it
const METHODS: Record<string, string | undefined> = {
  textDocumentSync: undefined,
  codeActionProvider: "textDocument/codeAction",
  executeCommandProvider: "workspace/executeCommand",
  hoverProvider: "textDocument/hover",
  completionProvider: "textDocument/completion",
  documentLinkProvider: "textDocument/documentLink",
  definitionProvider: "textDocument/definition",
};

test("every advertised capability has a handler", async () => {
  expect(Object.keys(CAPABILITIES).sort()).toEqual(Object.keys(METHODS).sort());
  const p = start({ [PATH]: CLEAN });
  await p.initialize();
  await p.open(PATH, CLEAN);
  const textDocument = { uri: p.uriOf(PATH) };
  const position = { line: 1, character: 4 };
  const range = { start: position, end: position };
  const params: Record<string, object> = {
    "textDocument/codeAction": { textDocument, range, context: { diagnostics: [] } },
    "workspace/executeCommand": { command: "dcx.fixAll", arguments: [textDocument.uri] },
    "textDocument/hover": { textDocument, position },
    "textDocument/completion": { textDocument, position },
    "textDocument/documentLink": { textDocument },
    "textDocument/definition": { textDocument, position },
  };
  for (const method of Object.values(METHODS).filter((m) => m !== undefined))
    await p.request(method, params[method]!); // an unhandled method rejects with MethodNotFound
});

describe("document sync", () => {
  test("incremental edits, emoji and CRLF included, leave the overlay matching the buffer", async () => {
    const p = start();
    await p.initialize();
    const text = '{\r\n  "name": "🐳 box",\r\n  "image": "node:22"\r\n}';
    await p.open(PATH, text);
    const reference = TextDocument.create(p.uriOf(PATH), "jsonc", 1, text);
    const edits = [
      {
        range: { start: { line: 1, character: 13 }, end: { line: 1, character: 16 } },
        text: "容器",
      },
      { range: { start: { line: 1, character: 11 }, end: { line: 1, character: 11 } }, text: "👩‍💻" },
      {
        range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } },
        text: '  "image": "a"\r\n',
      },
    ];
    for (const e of edits) {
      await p.change(PATH, e);
      TextDocument.update(reference, [e], reference.version + 1);
    }
    await p.settle();
    expect(await p.overlay.readFile(PATH)).toBe(reference.getText());
  });

  test("any sequence of incremental edits matches applying them to a plain document", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: "grapheme", maxLength: 30 }),
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.string({ unit: "grapheme", maxLength: 6 })), {
          maxLength: 8,
        }),
        async (initial, raw) => {
          const p = lspPair({ fs: new MemFS() });
          try {
            await p.initialize();
            await p.open(PATH, initial);
            const reference = TextDocument.create(p.uriOf(PATH), "jsonc", 1, initial);
            for (const [a, b, insert] of raw) {
              const len = reference.getText().length;
              const [from, to] = [a % (len + 1), b % (len + 1)].sort((x, y) => x - y);
              const e = {
                range: { start: reference.positionAt(from!), end: reference.positionAt(to!) },
                text: insert,
              };
              await p.change(PATH, e);
              TextDocument.update(reference, [e], reference.version + 1);
            }
            await p.settle();
            expect(await p.overlay.readFile(PATH)).toBe(reference.getText());
          } finally {
            await p.dispose();
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("diagnostics", () => {
  test("a range after emoji and CJK text lands where the position oracle says", async () => {
    const text = '{\n  "name": "🐳 容器 👩‍💻",\n  "nmae": "y",\n  "image": "node:22"\n}';
    const p = start();
    await p.initialize();
    await p.open(PATH, text);
    const found = await p.diagnostics(PATH);
    const typo = found.find((d) => d.code === "schema/unknown-property")!;
    const lines = new LineIndex(text);
    const at = text.indexOf('"nmae"');
    expect(typo.range).toEqual({ start: lines.positionAt(at), end: lines.positionAt(at + 6) });
  });

  test("50 changes in quick succession publish once", async () => {
    const p = lspPair({ fs: new MemFS(), debounceMs: 100 });
    pair = p;
    await p.initialize();
    await p.open(PATH, CLEAN);
    for (let i = 0; i < 50; i++)
      await p.change(PATH, {
        range: { start: { line: 1, character: 11 }, end: { line: 1, character: 11 } },
        text: "x",
      });
    await p.settle();
    expect(p.published.filter((d) => d.uri === p.uriOf(PATH))).toHaveLength(1);
  });

  test("opening and closing 100 documents leaves nothing pending, and each close clears", async () => {
    const p = start();
    await p.initialize();
    for (let i = 0; i < 100; i++) {
      const path = join("/w", `p${i}`, ".devcontainer.json");
      await p.open(path, CLEAN);
      await p.close(path);
    }
    await p.settle();
    expect(p.pending().size).toBe(0);
    const last = new Map(p.published.map((d) => [d.uri, d.diagnostics]));
    expect(last.size).toBe(100);
    for (const diagnostics of last.values()) expect(diagnostics).toEqual([]);
  });

  test("files that aren't devcontainer.json are synced but never linted", async () => {
    const p = start();
    await p.initialize();
    await p.open("/w/package.json", "{");
    await p.settle();
    expect(p.published).toEqual([]);
    expect(await p.overlay.readFile("/w/package.json")).toBe("{");
  });

  test("the same .dcx.yaml gives the same findings through the CLI and the server", async () => {
    const config = '{\n  "image": "node:22",\n  "appPort": 3000\n}\n';
    const files = {
      "/w/.git/HEAD": "",
      "/w/.dcx.yaml": "rules:\n  style/missing-name: error\n  repro/image-no-digest: warning\n",
      [PATH]: config,
    };
    let stdout = "";
    const io: Io = {
      stdout: (s) => void (stdout += s),
      stderr: () => {},
      env: {},
      cwd: "/w",
      isTTY: false,
      home: "/home",
    };
    await check(["--format", "json", "/w"], io, new MemFS(files));
    const cli = JSON.parse(stdout).files[0].diagnostics.map(
      (d: { ruleId: string; severity: string }) => `${d.ruleId} ${d.severity}`,
    );

    const p = start(files);
    await p.initialize();
    await p.open(PATH, config);
    const server = (await p.diagnostics(PATH)).map(
      (d) => `${d.code} ${["", "error", "warning", "info"][d.severity!]}`,
    );
    expect(server).toEqual(cli);
    expect(server).toContain("style/missing-name error");
  });

  test("a broken .dcx.yaml is shown in that file, not as a crash", async () => {
    const files = { "/w/.git/HEAD": "", "/w/.dcx.yaml": "fail-on: sometimes\n", [PATH]: CLEAN };
    const p = start(files);
    await p.initialize();
    await p.open(PATH, CLEAN);
    const found = await p.diagnostics("/w/.dcx.yaml");
    expect(found[0]!.message).toContain("fail-on");
  });
});

describe("review fixes", () => {
  const compose = "services:\n  db:\n    image: postgres\n";
  const composeConfig =
    '{ "dockerComposeFile": "../compose.yml", "service": "app", "workspaceFolder": "/w" }';

  test("editing an open Compose file re-lints the configs that read it", async () => {
    const p = start({ "/w/.git/HEAD": "", "/w/compose.yml": compose, [PATH]: composeConfig });
    await p.initialize();
    await p.open(PATH, composeConfig);
    const codes = async (n: number) => (await p.diagnostics(PATH, n)).map((d) => d.code);
    expect(await codes(1)).toContain("scenario/compose-service-not-found");
    await p.open("/w/compose.yml", compose + "  app:\n    image: node\n");
    expect(await codes(2)).not.toContain("scenario/compose-service-not-found");
  });

  test("a document that isn't a file never touches the working copy's buffer", async () => {
    const p = start({ "/w/.git/HEAD": "", [PATH]: CLEAN });
    await p.initialize();
    await p.open(PATH, CLEAN);
    await p.diagnostics(PATH);
    const git = p.uriOf(PATH).replace(/^file:/, "git:");
    const textDocument = { uri: git, languageId: "jsonc", version: 1, text: "{ broken" };
    await p.client.sendNotification("textDocument/didOpen", { textDocument });
    await p.client.sendNotification("textDocument/didClose", { textDocument: { uri: git } });
    await p.settle();
    expect(await p.overlay.readFile(PATH)).toBe(CLEAN);
    expect(p.published.some((d) => d.uri === git)).toBe(false);
  });

  test("fix-all with a broken .dcx.yaml answers with nothing rather than failing", async () => {
    const text = '{\n  "name": "x",\n  "image": "node:22",\n  "extensions": ["a.b"]\n}\n';
    const p = start({ "/w/.git/HEAD": "", "/w/.dcx.yaml": "fail-on: sometimes\n", [PATH]: text });
    await p.initialize();
    await p.open(PATH, text);
    const actions = await p.request("textDocument/codeAction", {
      textDocument: { uri: p.uriOf(PATH) },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { diagnostics: [], only: ["source.fixAll"] },
    });
    expect(actions).toEqual([]);
  });

  test("the explicit config and the user config are watched too", async () => {
    const p = start();
    const registered = new Promise<unknown>((resolve) =>
      p.client.onRequest("client/registerCapability", (r: unknown) => (resolve(r), null)),
    );
    await p.initialize(
      {
        workspace: {
          didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
        },
      },
      { configPath: "/etc/lint.yaml" },
    );
    const { registrations } = (await registered) as {
      registrations: { registerOptions: { watchers: { globPattern: unknown }[] } }[];
    };
    expect(registrations[0]!.registerOptions.watchers.map((w) => w.globPattern)).toEqual([
      "**/.dcx.{yaml,yml,json}",
      { baseUri: p.uriOf("/etc"), pattern: "lint.yaml" },
      { baseUri: p.uriOf(join("/home", ".config", "dcx")), pattern: "config.yaml" },
    ]);
  });

  test("run: onSave lints on open and save, not on each edit", async () => {
    const p = start({ [PATH]: CLEAN });
    await p.initialize({}, { run: "onSave" });
    await p.open(PATH, CLEAN);
    await p.diagnostics(PATH);
    await p.change(PATH, { text: '{ "nmae": 1 }' });
    await p.settle();
    expect(p.published).toHaveLength(1);
    await p.client.sendNotification("textDocument/didSave", {
      textDocument: { uri: p.uriOf(PATH) },
    });
    expect((await p.diagnostics(PATH, 2)).map((d) => d.code)).toContain("schema/unknown-property");
  });

  test("dispose stops analysis that's still pending", async () => {
    const p = lspPair({ fs: new MemFS({ [PATH]: CLEAN }), debounceMs: 10_000 });
    pair = p;
    await p.initialize();
    await p.open(PATH, CLEAN);
    while (!p.pending().size) await Bun.sleep(5);
    p.disposeServer();
    expect(p.pending().size).toBe(0);
  });
});

describe("analyzer cancellation", () => {
  const doc = TextDocument.create("file:///w/.devcontainer.json", "jsonc", 1, "{}");
  const sent: unknown[] = [];
  const connection = { sendDiagnostics: async (p: unknown) => void sent.push(p) } as never;

  test("a run cancelled while still going never publishes", async () => {
    sent.length = 0;
    let started = 0;
    const a = analyzer({
      connection,
      get: () => doc,
      // resolves only after its signal aborts, like a rule stuck on the network
      lint: (_, signal) => {
        started++;
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve([])));
      },
      failed: () => {},
    });
    a.schedule(doc.uri, 0);
    while (!started) await Bun.sleep(1);
    a.schedule(doc.uri, 10_000);
    await Bun.sleep(20);
    a.dispose();
    expect(sent).toEqual([]);
    expect(a.pending().size).toBe(0);
  });

  test("a run already cancelled before it starts doesn't lint at all", async () => {
    let linted = false;
    const a = analyzer({
      connection,
      get: () => doc,
      lint: async () => ((linted = true), []),
      failed: () => {},
    });
    a.schedule(doc.uri, 5);
    a.close(doc.uri);
    await Bun.sleep(20);
    expect(linted).toBe(false);
  });
});

test("dcx serve --stdio: a whole session puts nothing on stdout but LSP frames, and exits 0", async () => {
  const entry = join(import.meta.dir, "..", "..", "index.ts");
  const proc = Bun.spawn([process.execPath, entry, "serve", "--stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: "/nonexistent" },
  });
  const send = (m: object) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...m });
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const uri = "file:///nonexistent/.devcontainer.json";
  send({
    id: 1,
    method: "initialize",
    params: { processId: null, rootUri: null, capabilities: {} },
  });
  send({ method: "initialized", params: {} });
  send({
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId: "jsonc", version: 1, text: '{"nmae": 1}' } },
  });
  send({
    method: "textDocument/didChange",
    params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: '{"image": "🐳"}' }] },
  });
  await Bun.sleep(400);
  send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
  send({ id: 2, method: "shutdown" });
  send({ method: "exit" });
  proc.stdin.end();
  const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);

  const bytes = Buffer.from(out);
  const methods: string[] = [];
  for (let at = 0; at < bytes.length;) {
    const header = /^Content-Length: (\d+)\r\n\r\n/.exec(
      bytes.subarray(at, at + 40).toString("latin1"),
    );
    expect(header).not.toBeNull();
    const start = at + header![0].length;
    const message = JSON.parse(bytes.subarray(start, start + Number(header![1])).toString("utf8"));
    methods.push(message.method ?? `response ${message.id}`);
    at = start + Number(header![1]);
  }
  expect(methods).toContain("response 1");
  expect(methods).toContain("textDocument/publishDiagnostics");
  expect(methods.at(-1)).toBe("response 2");
  expect(code).toBe(0);
}, 15_000);
