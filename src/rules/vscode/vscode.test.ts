import { expect, test } from "bun:test";
import { parse } from "../../jsonc/jsonc";
import { analyze } from "../../lint/analyze";
import { stubSources } from "../../registry/stub";
import { MemFS } from "../../vfs/memfs";
import { APPLICATION_SCOPED, isApplicationScoped } from "./app-scope";
import { parseExtensionId } from "./extensions";

test.each(["golang", "a.b.c", ".go", "golang.", "go lang.go", "ESLint", ""])(
  "%p isn't an ID",
  (s) => {
    expect(parseExtensionId(s)).toBeUndefined();
  },
);

test.each<[string, object]>([
  ["golang.go", { publisher: "golang", name: "go", excluded: false }],
  ["-ms-python.python", { publisher: "ms-python", name: "python", excluded: true }],
  ["ms-python.python@2024.1.0", { publisher: "ms-python", name: "python", version: "2024.1.0" }],
  ["ms-vscode.cpptools_ext", { name: "cpptools_ext" }],
])("%s parses", (s, want) => {
  expect(parseExtensionId(s)).toMatchObject(want);
});

test("the application-scoped table stays sorted", () => {
  expect([...APPLICATION_SCOPED]).toEqual([...APPLICATION_SCOPED].sort());
});

test("prefix entries match their family", () => {
  expect(isApplicationScoped("extensions.gallery.serviceUrl")).toBe(true);
  expect(isApplicationScoped("extensions.ignoreRecommendations")).toBe(false);
});

test("the network rules share one lookup per extension and source", async () => {
  const asked: string[] = [];
  const { sources } = stubSources({ sources: [{ id: "a", extensions: { "golang.go": {} } }] });
  const counting = sources.map((s) => ({
    ...s,
    source: {
      ...s.source,
      lookup: (p: string, n: string, sig: AbortSignal) => (
        asked.push(`${p}.${n}`),
        s.source.lookup(p, n, sig)
      ),
    },
  }));
  const text =
    '{"name": "x", "image": "node:22", "customizations": {"vscode": {"extensions": ["golang.go", "ms-python.python"]}}}';
  const path = "/w/.devcontainer.json";
  await analyze(parse(path, text), path, {
    fs: new MemFS({ [path]: text }),
    config: { online: true },
    extensions: { satisfy: "all", sources: counting },
  });
  expect(asked.sort()).toEqual(["golang.go", "ms-python.python"]);
});
