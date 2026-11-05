import { expect, test } from "bun:test";
import { readServices } from "./compose";

const read = (files: Record<string, string>, names = Object.keys(files)) =>
  readServices(async (f) => files[f], names);

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

test("each file is read through the reader it's given, once", async () => {
  const asked: string[] = [];
  await readServices(async (f) => (asked.push(f), "services: {app: {}}"), ["a.yml", "b.yml"]);
  expect(asked).toEqual(["a.yml", "b.yml"]);
});
