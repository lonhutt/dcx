import { expect, test } from "bun:test";
import { parsePolicyFile, Policy, PolicyError, policySource } from "./policy";

const policy = (o: Record<string, unknown>) => new Policy(Object.entries(o));
const verdict = (p: Policy, id: string) => {
  const [pub, name] = id.split(".");
  return p.lookup(pub!, name!);
};

test.each<[string, Record<string, unknown>, string, boolean]>([
  ["a publisher allows all its extensions", { microsoft: true }, "microsoft.vscode-js", true],
  ["unlisted is denied once a policy exists", { microsoft: true }, "golang.go", false],
  ['"*": true allows anything', { "*": true }, "golang.go", true],
  ['"*": false with one allowed', { "*": false, "golang.go": true }, "golang.go", true],
  [
    '"*": false denies the rest',
    { "*": false, "golang.go": true },
    "rust-lang.rust-analyzer",
    false,
  ],
  ["an empty policy allows everything", {}, "golang.go", true],
  ['"stable" allows, stable releases only', { "golang.go": "stable" }, "golang.go", true],
  ["matching ignores case", { "golang.go": true }, "GOLANG.Go", true],
])("%s", (_, o, id, allowed) => {
  expect(verdict(policy(o), id).allowed).toBe(allowed);
});

test('"microsoft": true with "microsoft.cplusplus": false allows all but that one', () => {
  const p = policy({ microsoft: true, "microsoft.cplusplus": false });
  expect(verdict(p, "microsoft.vscode-js").allowed).toBe(true);
  expect(verdict(p, "microsoft.cplusplus").allowed).toBe(false);
});

test("key order never decides specificity", () => {
  const a = new Policy([
    ["microsoft.cplusplus", false],
    ["microsoft", true],
  ]);
  const b = new Policy([
    ["microsoft", true],
    ["microsoft.cplusplus", false],
  ]);
  expect(verdict(a, "microsoft.cplusplus")).toEqual(verdict(b, "microsoft.cplusplus"));
});

test("pinned versions, platform-qualified ones too", () => {
  const v = verdict(
    policy({ "ms-python.python": ["2024.1.0", "5.0.0@win32-x64"] }),
    "ms-python.python",
  );
  expect(v.versions).toEqual(["2024.1.0", "5.0.0"]);
  expect(verdict(policy({ "a.b": [] }), "a.b")).toMatchObject({ allowed: true, versions: [] });
});

test.each<[string, Record<string, unknown> | [string, unknown][]]>([
  ["a bad value", { "a.b": 1 }],
  ["a publisher with versions", { microsoft: ["1.0.0"] }],
  [
    "the same key twice, two values",
    [
      ["golang.go", true],
      ["Golang.Go", false],
    ],
  ],
])("%s is a PolicyError", (_, o) => {
  expect(() => new Policy(Array.isArray(o) ? o : Object.entries(o))).toThrow(PolicyError);
});

test("a policy file, bare or inside settings.json, with comments; duplicates caught", () => {
  expect(verdict(parsePolicyFile('{ "golang.go": true }'), "golang.go").allowed).toBe(true);
  expect(
    verdict(
      parsePolicyFile('{ // org policy\n "extensions.allowed": { "*": false } }'),
      "golang.go",
    ).allowed,
  ).toBe(false);
  expect(() => parsePolicyFile('{ "golang.go": true, "golang.go": false }')).toThrow("twice");
});

test("as a source, a denied extension is absent and evaluation is stable", async () => {
  const source = policySource("org", policy({ "*": false, "golang.go": ["0.40.0"] }));
  expect(
    await source.lookup("rust-lang", "rust-analyzer", new AbortController().signal),
  ).toBeUndefined();
  const runs = await Promise.all(
    Array.from({ length: 100 }, () => source.lookup("golang", "go", new AbortController().signal)),
  );
  expect(new Set(runs.map((r) => JSON.stringify(r))).size).toBe(1);
});
