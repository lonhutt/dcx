import { expect, test } from "bun:test";
import { normalisedTarget, objectMount, parseMount, splitMount } from "./mount";

test.each<[string, string[]]>([
  ["type=bind,source=a,target=b", ["type=bind", "source=a", "target=b"]],
  ['source="a,b",target=c', ["source=a,b", "target=c"]],
  ["source=a\\,b,target=c", ["source=a,b", "target=c"]],
  ["a,", ["a", ""]],
])("splitMount(%s)", (s, want) => {
  expect(splitMount(s)).toEqual(want);
});

test("normal, reordered and aliased keys agree", () => {
  const a = parseMount("type=bind,source=/a,target=/b");
  const b = parseMount("target=/b,src=/a,type=bind");
  expect(a.problems).toEqual([]);
  expect([a.mount.source, a.mount.target]).toEqual([b.mount.source, b.mount.target]);
});

test("the string and object forms of one mount match bar fromString", () => {
  const { mount } = parseMount("type=volume,source=cache,target=/cache");
  const obj = objectMount({ type: "volume", source: "cache", target: "/cache" });
  expect({ ...mount, fromString: false, options: {} }).toEqual({ ...obj, options: {} });
});

test.each<[string, string]>([
  ["type=bind,source", "needs a value"],
  ["type=bind,=x,target=/a", "is missing a key"],
  ["type=bind,sauce=/a,target=/b", 'has an unknown key "sauce"'],
  ["type=nfs,target=/a", "isn't a mount type"],
])("%s: %s", (s, reason) => {
  expect(parseMount(s).problems.map((p) => p.reason)).toContain(reason);
});

test("a trailing comma, readonly flag and empty value are fine", () => {
  expect(parseMount("type=bind,source=/a,target=/b,readonly,").problems).toEqual([]);
  expect(parseMount("type=volume,source=,target=/b").problems).toEqual([]);
});

test("targets compare as POSIX paths", () => {
  expect(normalisedTarget("/var/run/")).toBe(normalisedTarget("/var//run"));
  expect(normalisedTarget("/")).toBe("/");
});
