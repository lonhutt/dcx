import { expect, test } from "bun:test";
import { MemFS } from "../vfs/memfs";
import { readServices } from "./compose";

const read = (files: Record<string, string>, names = Object.keys(files)) =>
  readServices(
    new MemFS(Object.fromEntries(Object.entries(files).map(([k, v]) => [`/w/${k}`, v]))),
    "/w",
    names,
  );

test("service names, unioned across files in order", async () => {
  expect(
    await read({
      "a.yml": "services:\n  app: {}\n  db: {}\n",
      "b.yml": "services:\n  db: {}\n  tools: {}\n",
    }),
  ).toEqual(["app", "db", "tools"]);
});

test("anchors, merge keys and extends inside service bodies don't matter", async () => {
  expect(
    await read({
      "c.yml": "x: &x {restart: always}\nservices:\n  app:\n    <<: *x\n    extends: base\n",
    }),
  ).toEqual(["app"]);
});

test.each<[string, string]>([
  ["a 0-byte file", ""],
  ["a binary file", "\u0000\u0001\u0002�\u0000"],
  ["malformed YAML", "services: [unclosed"],
  ["no services key", "version: '3'\n"],
  ["a merge key at the services level", "x: &x {app: {}}\nservices:\n  <<: *x\n"],
])("%s is undefined, never a throw", async (_, text) => {
  expect(await read({ "c.yml": text })).toBeUndefined();
});

test("a missing file is undefined", async () => {
  expect(await read({}, ["nope.yml"])).toBeUndefined();
});

test("the read goes through the FileSystem, not the disk", async () => {
  const fs = new MemFS({ "/w/c.yml": "services: {app: {}}" });
  await readServices(fs, "/w", ["c.yml"]);
  expect(fs.calls.map((p) => p.replace(/\\/g, "/").replace(/^[A-Z]:/, ""))).toEqual(["/w/c.yml"]);
});
