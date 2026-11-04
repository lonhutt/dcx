import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { join } from "node:path";
import type { Diagnostic } from "../diagnostic/diagnostic";
import { LineIndex } from "../position/position";
import { all } from "../rules/index";
import { expectGolden } from "../testutil/golden";
import { colorEnabled, paint } from "./color";
import { compact } from "./compact";
import { excerpt } from "./excerpt";
import { escapeMessage, escapeProperty, github } from "./github";
import { json, type JsonOutput } from "./json";
import { summary, type FileResult } from "./report";
import { catalog, explainRule } from "./rules";
import { artifactUri, levelFor, sarif } from "./sarif";
import { text } from "./text";

const TESTDATA = join(import.meta.dir, "testdata");

const SOURCE = '{\n  // base\n  "image": "x",\n  "nmae": "<y>",\n  "appPort": 3000\n}\n';
const at = (needle: string, len = needle.length) => {
  const start = SOURCE.indexOf(needle);
  return { start, end: start + len };
};
const DIAGNOSTICS: Diagnostic[] = [
  {
    ruleId: "schema/unknown-property",
    severity: "warning",
    range: at('"nmae"'),
    message: 'Unknown property "nmae"; did you mean "name"?',
    help: 'rename it to "name"',
    docsUrl: "https://containers.dev/implementors/json_reference/#general-properties",
  },
  {
    ruleId: "deprecation/app-port",
    severity: "error",
    range: at('"appPort"'),
    message: '"appPort" is deprecated; use "forwardPorts"',
    related: [{ range: at('"image"'), message: "the image" }],
    fix: { title: "Rename", edits: [{ range: at('"appPort"'), newText: '"forwardPorts"' }] },
  },
  {
    ruleId: "style/missing-name",
    severity: "info",
    range: at("{", 1),
    message: "No name",
    suppressed: true,
    suppressReason: "generated file",
  },
];
const FILE: FileResult = {
  path: ".devcontainer/devcontainer.json",
  text: SOURCE,
  lines: new LineIndex(SOURCE),
  diagnostics: DIAGNOSTICS,
};
const PLAIN = { color: false, quiet: false };

describe("excerpt carets line up in display width", () => {
  const caretColumn = (src: string, needle: string) => {
    const out = excerpt(
      src,
      new LineIndex(src),
      { start: src.indexOf(needle), end: src.indexOf(needle) + needle.length },
      paint(false),
    );
    const [line, caret] = out
      .split("\n")
      .filter((l, i, a) => a[i + 1]?.includes("^") || l.includes("^"));
    const body = line!.slice(line!.indexOf("│") + 2);
    const carets = caret!.slice(caret!.indexOf("│") + 2);
    return { body, carets };
  };
  test.each<[string, string, string]>([
    ["ascii", '{"a": "x"}', '"x"'],
    ["a tab before", '{\t"a": "x"}', '"x"'],
    ["two tabs", '{\n\t\t"a": "x"}', '"x"'],
    ["CJK before", '{"名前": "x"}', '"x"'],
    ["emoji before", '{"👩‍💻": "x"}', '"x"'],
    ["a combining mark before", '{"é": "x"}', '"x"'],
  ])("%s", (_, src, needle) => {
    const { body, carets } = caretColumn(src, needle);
    const col = Bun.stringWidth(body.slice(0, body.indexOf(needle)));
    expect(carets.indexOf("^")).toBe(col);
    expect(carets.trim()).toBe("^".repeat(Bun.stringWidth(needle)));
  });

  test("an empty range still gets one caret", () => {
    expect(excerpt("{}", new LineIndex("{}"), { start: 1, end: 1 }, paint(false))).toContain("^");
  });
});

describe("colour", () => {
  test.each<[string, Parameters<typeof colorEnabled>[0], boolean, Record<string, string>, boolean]>(
    [
      ["auto on a TTY", "auto", true, {}, true],
      ["auto off a TTY", "auto", false, {}, false],
      ["NO_COLOR beats a TTY", "auto", true, { NO_COLOR: "1" }, false],
      ["FORCE_COLOR beats no TTY", "auto", false, { FORCE_COLOR: "1" }, true],
      ["NO_COLOR beats FORCE_COLOR", "auto", true, { NO_COLOR: "1", FORCE_COLOR: "1" }, false],
      ["FORCE_COLOR=0 is off", "auto", true, { FORCE_COLOR: "0" }, false],
      ["always beats NO_COLOR", "always", false, { NO_COLOR: "1" }, true],
      ["never beats a TTY", "never", true, {}, false],
    ],
  )("%s", (_, mode, isTTY, env, want) => {
    expect(colorEnabled(mode, { isTTY }, env)).toBe(want);
  });

  test("the no-colour text output has no escape bytes; the colour one resets every span", async () => {
    const plain = text([FILE], PLAIN);
    expect(plain).not.toContain("\x1b");
    const colored = text([FILE], { color: true, quiet: false });
    expect(colored).toContain("\x1b[");
    expect(Bun.stripANSI(colored)).toBe(plain);
  });
});

describe("text", () => {
  test("golden", async () => {
    await expectGolden(join(TESTDATA, "text.golden.txt"), text([FILE], PLAIN));
  });
  test("suppressed findings aren't printed", () => {
    expect(text([FILE], PLAIN)).not.toContain("No name");
  });
  test("--quiet drops the summary", () => {
    expect(text([FILE], { color: false, quiet: true })).not.toContain(" in 1 file");
  });
  test.each<[Parameters<typeof summary>[0], string]>([
    [{ error: 0, warning: 0, info: 0, files: 0 }, "no problems"],
    [{ error: 1, warning: 2, info: 0, files: 1 }, "1 error, 2 warnings in 1 file"],
    [{ error: 0, warning: 1, info: 3, files: 2 }, "1 warning, 3 infos in 2 files"],
  ])("summary %j", (c, want) => {
    expect(summary(c)).toBe(want);
  });
});

describe("compact", () => {
  test("matches vim's %f:%l:%c: %m", () => {
    const lines = compact([FILE], PLAIN).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines)
      expect(l).toMatch(/^[^:]+:\d+:\d+: (error|warning|info): .+ \[[a-z]+\/[a-z-]+\]$/);
    expect(lines[0]).toBe(
      '.devcontainer/devcontainer.json:4:3: warning: Unknown property "nmae"; did you mean "name"? [schema/unknown-property]',
    );
  });
});

describe("json", () => {
  const out = () => JSON.parse(json([FILE], PLAIN)) as JsonOutput;
  test("golden", async () => {
    await expectGolden(join(TESTDATA, "json.golden.json"), json([FILE], PLAIN));
  });
  test("offsets and line/column agree", () => {
    for (const d of out().files[0]!.diagnostics) {
      const p = FILE.lines.terminalPositionAt(d.range.start.offset);
      expect([d.range.start.line, d.range.start.column]).toEqual([p.line, p.column]);
    }
  });
  test("suppressed findings are kept, with their reason; absent fields are absent", () => {
    const [, appPort, missing] = out().files[0]!.diagnostics;
    expect(missing).toMatchObject({ suppressed: true, suppressReason: "generated file" });
    expect(Object.keys(appPort!)).not.toContain("suppressed");
    expect(Object.keys(missing!)).not.toContain("fix");
  });
  test("is versioned, and keeps a < literally", () => {
    const raw = json([FILE], PLAIN);
    expect(out().version).toBe("1");
    expect(raw).toContain('"Unknown property \\"nmae\\"');
    expect(
      json([{ ...FILE, diagnostics: [{ ...DIAGNOSTICS[0]!, message: "<y>" }] }], PLAIN),
    ).toContain('"<y>"');
  });
});

const sarifSchema = await Bun.file(join(TESTDATA, "sarif", "sarif-2.1.0.schema.json")).json();

describe("sarif", () => {
  const schema = sarifSchema;
  // the schema is draft-04; Ajv 8 reads it as draft-07 once `id` is `$id`
  const { $schema: _, id, ...rest } = schema;
  const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile({
    ...rest,
    $id: id,
  });

  test("validates against the SARIF 2.1.0 schema", () => {
    const log = JSON.parse(
      sarif([FILE, { ...FILE, path: "b\\.devcontainer.json" }], all(), "0.1.0"),
    );
    expect(validate(log), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
  test("rules[] is the whole registry, with help links", () => {
    const log = JSON.parse(sarif([], all(), "0.1.0"));
    const rules = log.runs[0].tool.driver.rules;
    expect(rules.map((r: { id: string }) => r.id)).toEqual(catalog(all()).map((r) => r.id));
    for (const r of rules) expect(r.helpUri).toStartWith("https://");
  });
  test("each finding appears once per file, suppressions carry their reason", () => {
    const log = JSON.parse(
      sarif([FILE, { ...FILE, path: "other/devcontainer.json" }], all(), "0.1.0"),
    );
    const results = log.runs[0].results;
    expect(results).toHaveLength(6);
    const suppressed = results.find((r: { ruleId: string }) => r.ruleId === "style/missing-name");
    expect(suppressed.suppressions).toEqual([
      { kind: "inSource", justification: "generated file" },
    ]);
  });
  test.each<[string, string]>([
    ["a\\b\\devcontainer.json", "a/b/devcontainer.json"],
    ["./x/../.devcontainer.json", ".devcontainer.json"],
    ["dir with space/devcontainer.json", "dir%20with%20space/devcontainer.json"],
  ])("artifactUri(%s)", (path, want) => {
    expect(artifactUri(path)).toBe(want);
  });
  test("levels", () => {
    expect([levelFor("error"), levelFor("warning"), levelFor("info")]).toEqual([
      "error",
      "warning",
      "note",
    ]);
  });
});

describe("github", () => {
  test("golden", async () => {
    await expectGolden(join(TESTDATA, "github.golden.txt"), github([FILE], PLAIN));
  });
  test("a newline in a message stays on one command line", () => {
    const out = github(
      [{ ...FILE, diagnostics: [{ ...DIAGNOSTICS[0]!, message: "a\nb", help: undefined }] }],
      PLAIN,
    );
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(out).toContain("a%0Ab");
  });
  test("properties escape : and , ; messages don't", () => {
    expect(escapeProperty("C:\\a,b")).toBe("C%3A\\a%2Cb");
    expect(escapeMessage("a: b, c")).toBe("a: b, c");
    expect(escapeMessage("100%")).toBe("100%25");
  });
  test("info is a notice; off and suppressed emit nothing", () => {
    const d = (severity: Diagnostic["severity"], suppressed = false): Diagnostic => ({
      ...DIAGNOSTICS[0]!,
      severity,
      suppressed,
    });
    const out = github([{ ...FILE, diagnostics: [d("info"), d("off"), d("error", true)] }], PLAIN);
    expect(
      out
        .trimEnd()
        .split("\n")
        .map((l) => l.split(" ")[0]),
    ).toEqual(["::notice"]);
  });
});

describe("rule catalog", () => {
  test("matches the registry, sorted and stable", () => {
    const a = catalog(all());
    expect(a.map((r) => r.id)).toEqual([...all().map((r) => r.id)].sort());
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(catalog([...all()].reverse())).toEqual(a);
  });
  test.each(all().map((r) => [r.id, r] as const))("%s explains more than it describes", (_, r) => {
    expect(r.explain.trim().length).toBeGreaterThan(r.description.length);
    expect(explainRule(catalog([r])[0]!)).toContain(r.id);
  });
});

test("RULES.md is up to date with the registry (bun scripts/rules-doc.ts)", async () => {
  const { renderRulesDoc } = await import("./rules-doc");
  const path = join(import.meta.dir, "..", "..", "RULES.md");
  const want = renderRulesDoc(all());
  if (process.env.UPDATE) await Bun.write(path, want);
  expect(await Bun.file(path).text()).toBe(want);
});
