import { describe, expect, test } from "bun:test";
import { applyEdits, parse } from "../jsonc/jsonc";
import { duplicateKey } from "./syntax/duplicate-key";
import { runCase } from "./rulestest/harness";
import { RULES } from "./index";
import { buildArgNotDeclared } from "./semantic/rules";
import { composeServiceNotFound } from "./scenario/rules";
import { appPort, rootExtensions, rootSettings, topLevelDockerfile } from "./deprecation/rules";

const fixed = (
  text: string,
  d: { fix?: { edits: readonly { range: { start: number; end: number }; newText: string }[] } },
) =>
  applyEdits(
    text,
    d.fix!.edits.map((e) => ({
      offset: e.range.start,
      length: e.range.end - e.range.start,
      content: e.newText,
    })),
  );

test("duplicate-key points at both the duplicate and the original", async () => {
  const text = '{"image": "a", "image": "b"}';
  const [d] = await runCase(duplicateKey, text);
  expect(text.slice(d!.range.start, d!.range.end)).toBe('"image"');
  expect(d!.range.start).toBe(15);
  expect(d!.related?.map((r) => r.range.start)).toEqual([1]);
});

test("trailing-comma is off by default; every deprecation rule is a warning", () => {
  const byId = new Map(RULES.map((r) => [r.id, r]));
  expect(byId.get("syntax/trailing-comma")!.defaultSeverity).toBe("off");
  for (const r of RULES.filter((r) => r.category === "deprecation"))
    expect(r.defaultSeverity).toBe("warning");
});

describe("deprecation fixes exist now, long before the fix engine", () => {
  test("top-level dockerFile/context move under build", async () => {
    const text = '{\n  "dockerFile": "Dockerfile",\n  "context": "..",\n  "name": "x"\n}';
    const [d] = await runCase(topLevelDockerfile, text);
    expect(JSON.parse(fixed(text, d!))).toEqual({
      name: "x",
      build: { dockerfile: "Dockerfile", context: ".." },
    });
  });

  test("root extensions merge into an existing customizations block, not clobber it", async () => {
    const text =
      '{\n  "image": "x",\n  "extensions": ["a.b", "c.d"],\n  "customizations": {\n    "vscode": { "extensions": ["c.d"], "settings": {"k": 1} },\n    "other": {}\n  }\n}';
    const [d] = await runCase(rootExtensions, text);
    expect(JSON.parse(fixed(text, d!))).toEqual({
      image: "x",
      customizations: { vscode: { extensions: ["c.d", "a.b"], settings: { k: 1 } }, other: {} },
    });
  });

  test("root settings merge, the existing customizations value winning", async () => {
    const text =
      '{"image": "x", "settings": {"a": 1, "b": 1}, "customizations": {"vscode": {"settings": {"b": 2}}}}';
    const [d] = await runCase(rootSettings, text);
    expect(JSON.parse(fixed(text, d!))).toEqual({
      image: "x",
      customizations: { vscode: { settings: { a: 1, b: 2 } } },
    });
  });

  test("a fix is one edit, and keeps the document's comments and indentation", async () => {
    const text = '{\n\t// the base image\n\t"image": "x",\n\t"settings": {"a": 1}\n}';
    const [d] = await runCase(rootSettings, text);
    expect(d!.fix!.edits).toHaveLength(1);
    const out = fixed(text, d!);
    expect(out).toContain('\t// the base image\n\t"image": "x"');
    expect(parse("u", out).errors).toEqual([]);
  });

  // found by the property test: modify() throws writing through a non-object
  test('a "customizations" that isn\'t an object still gets the finding, just no fix', async () => {
    const [d] = await runCase(
      rootExtensions,
      '{"image": "x", "customizations": 0, "extensions": ["a.b"]}',
    );
    expect(d!.ruleId).toBe("deprecation/root-extensions");
    expect(d!.fix).toBeUndefined();
  });

  test("a first member with a comment before its comma leaves valid JSONC", async () => {
    const text = '{\n  "settings": {} /* c */, "name": "x", "image": "node:22"\n}';
    const [d] = await runCase(rootSettings, text);
    const out = fixed(text, d!);
    expect(parse("f", out).errors).toEqual([]);
    expect(out).toContain("/* c */");
  });

  test("a comma inside a comment isn't taken for the property's own", async () => {
    const text = '{\n  "name": "x",\n  "settings": {} // a, b\n  , "image": "node:22"\n}';
    const [d] = await runCase(rootSettings, text);
    const out = fixed(text, d!);
    expect(parse("f", out).errors).toEqual([]);
    expect(out).toContain("// a, b");
  });

  test("merging extensions keeps the comments in the existing list", async () => {
    const text = `{
  "image": "x",
  "extensions": ["a.b", "c.d"],
  "customizations": {
    "vscode": {
      "extensions": [
        // needed for CI lint
        "c.d"
      ]
    }
  }
}`;
    const [d] = await runCase(rootExtensions, text);
    const out = fixed(text, d!);
    expect(out).toContain("// needed for CI lint");
    expect(parse("f", out).errors).toEqual([]);
    const value = JSON.parse(out.replace(/\/\/.*$/gm, ""));
    expect(value.customizations.vscode.extensions).toEqual(["c.d", "a.b"]);
  });

  test("merging settings keeps the comments in the existing object", async () => {
    const text = `{
  "image": "x",
  "settings": { "a": 1, "b": 2 },
  "customizations": { "vscode": { "settings": {
    // why b is 3
    "b": 3
  } } }
}`;
    const [d] = await runCase(rootSettings, text);
    const out = fixed(text, d!);
    expect(out).toContain("// why b is 3");
    const value = JSON.parse(out.replace(/\/\/.*$/gm, ""));
    expect(value.customizations.vscode.settings).toEqual({ b: 3, a: 1 });
  });

  test("a moved value keeps its own comments, re-indented to where it lands", async () => {
    const text = `{
  "image": "x",
  "settings": {
    // two, for the linter
    "editor.tabSize": 2
  }
}`;
    const [d] = await runCase(rootSettings, text);
    const out = fixed(text, d!);
    expect(parse("f", out).errors).toEqual([]);
    expect(out).toContain('\n        // two, for the linter\n        "editor.tabSize": 2\n      }');
  });

  test("app-port has no automatic fix", async () => {
    const [d] = await runCase(appPort, '{"image": "x", "appPort": 3000}');
    expect(d!.fix).toBeUndefined();
  });
});

describe("rules that read a referenced file stay inside the workspace", () => {
  const outside = {
    "../etc/Dockerfile": "ARG LEAKED",
    "../etc/compose.yml": "services: {leaked: {}}",
  };

  test("build-arg-not-declared doesn't read a Dockerfile outside it", async () => {
    const found = await runCase(
      buildArgNotDeclared,
      '{"name": "x", "build": {"dockerfile": "../../etc/Dockerfile", "args": {"LEAKE": "1"}}}',
      outside,
    );
    expect(found).toEqual([]);
  });

  test("compose-service-not-found doesn't list services from a file outside it", async () => {
    const found = await runCase(
      composeServiceNotFound,
      '{"name": "x", "dockerComposeFile": "../../etc/compose.yml", "service": "app", "workspaceFolder": "/w"}',
      outside,
    );
    expect(found).toEqual([]);
  });
});
