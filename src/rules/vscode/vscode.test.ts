import { expect, test } from "bun:test";
import { APPLICATION_SCOPED, isApplicationScoped } from "./app-scope";
import { normaliseId, parseExtensionId } from "./extensions";

test("IDs that differ only in case look up the same", () => {
  expect(new Set(["golang.Go", "GOLANG.go", "golang.go"].map(normaliseId)).size).toBe(1);
});

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
