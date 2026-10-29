import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "..", "index.ts");
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dcx-cli-"));
  for (const [dir, text] of Object.entries({
    clean: '{"image": "x"}',
    broken: '{\n\t"image": "x",\n\t"nmae": "y"\n}',
  })) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, ".devcontainer.json"), text);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function dcx(...args: string[]) {
  // execPath, not "bun": the binary running the tests, whatever PATH holds
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// CI has to tell "your config is wrong" (1) from "the linter couldn't run" (2)
test.each<[string, string[], number]>([
  ["clean config", ["check", "clean"], 0],
  ["config with problems", ["check", "broken"], 1],
  ["no config found", ["check", "missing"], 2],
  ["unknown command", ["lint"], 2],
  ["unknown flag", ["check", "--nope"], 2],
  ["help", ["--help"], 0],
])("%s exits %d", async (_, args, code) => {
  const result = await dcx(...args);
  // stderr in the failure message; a crash on startup is otherwise just "Received: 1"
  expect(result.code, `exit ${result.code}, stderr:\n${result.stderr}`).toBe(code);
});

test("a problem prints as file:line:col with the column in display width", async () => {
  const { stdout } = await dcx("check", "broken");
  expect(stdout).toBe(
    `${join("broken", ".devcontainer.json")}:3:9: error: Unknown property "nmae"; did you mean "name"? [schema/unknown-property]\n`,
  );
});
