import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { all } from "../rules/index";
import { catalog } from "../report/rules";
import type { Fetch } from "../net/http";
import type { Io } from "./check";
import { check, HELP, OPTIONS } from "./check";
import { run } from "./cli";

const entry = join(import.meta.dir, "..", "..", "index.ts");
let root: string;

const PROJECTS: Record<string, string> = {
  "clean/.devcontainer.json": '{"name": "x", "image": "node:22"}',
  "broken/.devcontainer.json": '{\n\t"name": "x",\n\t"image": "node:22",\n\t"nmae": "y"\n}',
  "warning/.devcontainer.json": '{"name": "x", "image": "node:22", "appPort": 3000}',
  "badconfig/.devcontainer.json": '{"name": "x", "image": "node:22"}',
  "badconfig/.dcx.yaml": "fail-on: sometimes\n",
  "error/.devcontainer.json": '{"name": "x", "image": "node:22", "privileged": "yes"}',
  "empty/.keep": "",
  "configured/.devcontainer.json": '{"name": "x", "image": "node:22", "appPort": 3000}',
  "configured/.dcx.yaml": "fail-on: warning\nrules:\n  deprecation/app-port: error\n",
  "multi/.devcontainer/a/devcontainer.json": '{"name": "a", "image": "node:22"}',
  "multi/.devcontainer/b/devcontainer.json":
    '{"name": "b", "image": "node:22", "privileged": "yes"}',
  "multi/.dcx.yaml": "exclude:\n  - .devcontainer/b/\n",
  "online/.devcontainer.json":
    '{"name": "x", "image": "node:22", "features": {"ghcr.io/devcontainers/features/node:1": {}}, "customizations": {"vscode": {"extensions": ["golang.go"]}}}',
  "commas/.devcontainer.json": '{"name": "x", "image": "node:22",}',
  "userexclude/.devcontainer/a/devcontainer.json": '{"name": "a", "image": "node:22"}',
  "userexclude/.devcontainer/b/devcontainer.json":
    '{"name": "b", "image": "node:22", "privileged": "yes"}',
  "userhome/.config/dcx/config.yaml": "exclude:\n  - .devcontainer/b/\n",
  "fixme/.devcontainer.json":
    '{\n  "name": "x",\n  "image": "node:22",\n  "settings": {"a": 1}\n}\n',
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dcx-cli-"));
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(PROJECTS)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The CLI in-process, with captured output and an empty home. */
const dcx = (...args: string[]) => dcxIn(join(root, "home"), ...args);

async function dcxIn(home: string, ...args: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    env: {},
    cwd: root,
    isTTY: false,
    home,
  };
  const code = await run(args, io);
  return { stdout, stderr, code };
}

/** The real entry point, as a process. */
async function spawned(...args: string[]) {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: join(root, "home") },
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
  ["config with errors", ["check", "error"], 1],
  ["warnings only", ["check", "warning"], 0],
  ["no config found", ["check", "missing"], 2],
  ["a broken .dcx.yaml", ["check", "badconfig"], 2],
  ["unknown command", ["lint"], 2],
  ["unknown flag", ["check", "--nope"], 2],
  ["unknown rule", ["check", "--rule", "schema/nope", "clean"], 2],
  ["help", ["--help"], 0],
])("the process exits %p: %d", async (_, args, code) => {
  const result = await spawned(...args);
  // stderr in the failure message; a crash on startup is otherwise just "Received: 1"
  expect(result.code, `exit ${result.code}, stderr:\n${result.stderr}`).toBe(code);
});

test("compact prints file:line:col with the column in display width", async () => {
  const { stdout } = await dcx("check", "--format", "compact", "broken");
  expect(stdout).toBe(
    `${join("broken", ".devcontainer.json")}:4:9: warning: Unknown property "nmae"; did you mean "name"? [schema/unknown-property]\n`,
  );
});

describe("flags win over config files", () => {
  test("the project config makes a warning fail", async () => {
    expect((await dcx("check", "configured")).code).toBe(1);
  });
  test("--severity beats the config's rules", async () => {
    expect((await dcx("check", "--severity", "deprecation/app-port=info", "configured")).code).toBe(
      0,
    );
  });
  test("--disable beats the config's rules", async () => {
    expect((await dcx("check", "--disable", "deprecation/app-port", "configured")).code).toBe(0);
  });
  test("--max-severity caps what the config raised", async () => {
    expect((await dcx("check", "--max-severity", "info", "configured")).code).toBe(0);
  });
  test("--no-config ignores the project config", async () => {
    expect((await dcx("check", "--no-config", "configured")).code).toBe(0);
  });
  test("--config names one outright", async () => {
    expect((await dcx("check", "--config", "configured/.dcx.yaml", "warning")).code).toBe(1);
  });
  test("the environment layer sits under flags", async () => {
    const io = (env: Record<string, string>) => ({
      stdout: () => {},
      stderr: () => {},
      env,
      cwd: root,
      isTTY: false,
      home: join(root, "home"),
    });
    expect(await run(["check", "warning"], io({ DCX_FAIL_ON: "warning" }))).toBe(1);
    expect(
      await run(
        ["check", "--severity", "deprecation/app-port=info", "warning"],
        io({ DCX_FAIL_ON: "warning" }),
      ),
    ).toBe(0);
  });
});

test("--severity applies before the threshold", async () => {
  expect((await dcx("check", "warning")).code).toBe(0);
  expect((await dcx("check", "--severity", "deprecation/app-port=error", "warning")).code).toBe(1);
  expect((await dcx("check", "--error-on-warning", "warning")).code).toBe(1);
});

test("--rule runs only that rule, even one that's off by default", async () => {
  const { stdout } = await dcx(
    "check",
    "--format",
    "compact",
    "--rule",
    "syntax/trailing-comma",
    "broken",
  );
  expect(stdout).toBe("");
  const only = await dcx(
    "check",
    "--format",
    "compact",
    "--rule",
    "deprecation/app-port",
    "warning",
  );
  expect(only.stdout).toContain("[deprecation/app-port]");
  expect(only.stdout.trim().split("\n")).toHaveLength(1);
});

test("an unknown rule ID suggests the closest one", async () => {
  expect((await dcx("check", "--disable", "schema/unknown-proprety")).stderr).toContain(
    'did you mean "schema/unknown-property"?',
  );
});

test("a broken .dcx.yaml is shown with an excerpt of the config", async () => {
  const { stderr } = await dcx("check", "badconfig");
  expect(stderr).toContain(join("badconfig", ".dcx.yaml"));
  expect(stderr).toContain("fail-on: sometimes");
  expect(stderr).toContain("^");
});

test("no devcontainer.json names every path it looked for", async () => {
  const { stderr } = await dcx("check", "empty");
  expect(stderr).toContain(join("empty", ".devcontainer", "devcontainer.json"));
  expect(stderr).toContain(join("empty", ".devcontainer.json"));
});

test("every nested config is linted, minus what exclude drops; a named file is always linted", async () => {
  expect((await dcx("check", "--format", "compact", "multi")).stdout).toBe("");
  expect((await dcx("check", "--no-config", "multi")).code).toBe(1);
  expect((await dcx("check", "multi/.devcontainer/b/devcontainer.json")).code).toBe(1);
});

test("--fix-dry-run prints the diff and leaves the file alone; --fix writes it", async () => {
  const path = join(root, "fixme", ".devcontainer.json");
  const before = readFileSync(path, "utf8");
  const dry = await dcx("check", "--fix-dry-run", "fixme");
  expect(dry.stdout).toStartWith(
    "--- a/fixme/.devcontainer.json\n+++ b/fixme/.devcontainer.json\n@@",
  );
  expect(readFileSync(path, "utf8")).toBe(before);

  const fixed = await dcx("check", "--fix", "fixme");
  expect(fixed.code).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    name: "x",
    image: "node:22",
    customizations: { vscode: { settings: { a: 1 } } },
  });
  expect((await dcx("check", "--fix-dry-run", "fixme")).stdout).toBe("");
  writeFileSync(path, before);
});

test("--fix-dry-run exits on the file as it is, not as the fix would leave it", async () => {
  expect((await dcx("check", "--error-on-warning", "fixme")).code).toBe(1);
  expect((await dcx("check", "--error-on-warning", "--fix-dry-run", "fixme")).code).toBe(1);
});

test("--rule turns an off rule on even with --max-severity", async () => {
  const named = await dcx(
    "check",
    "--rule",
    "syntax/trailing-comma",
    "--max-severity",
    "info",
    "commas",
  );
  expect(named.stdout).toContain("syntax/trailing-comma");
});

test("a user config's excludes are relative to the project, not ~/.config/dcx", async () => {
  expect((await dcx("check", "userexclude")).code).toBe(1);
  expect((await dcxIn(join(root, "userhome"), "check", "userexclude")).code).toBe(0);
});

test("--format json and sarif", async () => {
  const j = JSON.parse((await dcx("check", "--format", "json", "broken")).stdout);
  expect(j.version).toBe("1");
  expect(j.files[0].diagnostics[0].ruleId).toBe("schema/unknown-property");
  const s = JSON.parse((await dcx("check", "--format", "sarif", "broken")).stdout);
  expect(s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
    "broken/.devcontainer.json",
  );
});

test("--list-rules --format json round-trips to the catalog", async () => {
  const { stdout, code } = await dcx("check", "--list-rules", "--format", "json");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual(catalog(all()));
  expect((await dcx("check", "--list-rules")).stdout.trim().split("\n")).toHaveLength(all().length);
});

test("--explain", async () => {
  const known = await dcx("check", "--explain", "deprecation/app-port");
  expect(known.code).toBe(0);
  expect(known.stdout).toContain("forwardPorts");
  expect((await dcx("check", "--explain", "nope/nope")).code).toBe(2);
});

test.each(Object.keys(OPTIONS))("--help documents --%s", (flag) => {
  expect(HELP).toContain(`--${flag}`);
});

test("nothing below the CLI writes to the console", async () => {
  const spies = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn")];
  const write = spyOn(process.stdout, "write");
  try {
    await dcx("check", "error");
    await dcx("check", "--fix-dry-run", "fixme");
    for (const s of [...spies, write]) expect(s).not.toHaveBeenCalled();
  } finally {
    for (const s of [...spies, write]) s.mockRestore();
  }
});

test("--version names the version", async () => {
  expect((await dcx("--version")).stdout).toMatch(/^dcx \d+\.\d+\.\d+ \(/);
});

describe("--online", () => {
  const online = (fetchFn: Fetch, ...args: string[]) => {
    let stdout = "";
    let stderr = "";
    const io: Io = {
      stdout: (s) => void (stdout += s),
      stderr: (s) => void (stderr += s),
      env: { XDG_CACHE_HOME: join(root, "cache-" + Math.random().toString(36).slice(2)) },
      cwd: root,
      isTTY: false,
      home: join(root, "home"),
    };
    return check(args, io, undefined, fetchFn).then((code) => ({ code, stdout, stderr }));
  };

  test("network rules don't run, and nothing is fetched, without --online", async () => {
    let calls = 0;
    const counting: Fetch = async () => (calls++, new Response("", { status: 500 }));
    await online(counting, "--format", "compact", "online");
    expect(calls).toBe(0);
  });

  test("an unreachable registry is a warning on stderr, never a failed run", async () => {
    const refused: Fetch = async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    };
    const { code, stderr } = await online(refused, "--online", "--format", "compact", "online");
    expect(code).toBe(0);
    expect(stderr).toContain(
      'dcx: warning: couldn\'t resolve feature "ghcr.io/devcontainers/features/node:1"',
    );
    expect(stderr).toContain('dcx: warning: extension source "open-vsx" is unreachable');
  });
});

test("the pre-commit hook and the action run this version", async () => {
  const repo = join(import.meta.dir, "..", "..");
  const { version } = await Bun.file(join(repo, "package.json")).json();
  expect(await Bun.file(join(repo, ".pre-commit-hooks.yaml")).text()).toContain(
    `bunx dcx@${version} check`,
  );
  expect(await Bun.file(join(repo, "action.yml")).text()).toContain(`default: ${version}`);
});
