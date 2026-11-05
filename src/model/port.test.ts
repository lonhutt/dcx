import { expect, test } from "bun:test";
import { covers, inRange, isPattern, parsePort } from "./port";

test.each<[unknown, boolean, ReturnType<typeof parsePort>]>([
  [3000, false, { host: "localhost", port: 3000 }],
  ["3000", false, { host: "localhost", port: 3000 }],
  ["db:5432", false, { host: "db", port: 5432 }],
  ["3000-3010", true, { host: "localhost", port: 3000, end: 3010 }],
  ["3000-3010", false, undefined],
  [3000.5, false, undefined],
  ["abc", false, undefined],
  ["db:", false, undefined],
  [":80", false, undefined],
  [true, false, undefined],
  [99999, false, { host: "localhost", port: 99999 }],
])("parsePort(%p, ranges: %p)", (v, ranges, want) => {
  expect(parsePort(v, ranges)).toEqual(want);
});

test.each([
  [0, false],
  [1, true],
  [65535, true],
  [65536, false],
  [-1, false],
  [99999, false],
  [80.5, false],
])("inRange(%p) is %p", (n, want) => {
  expect(inRange(n)).toBe(want);
});

test("a range covers the ports inside it", () => {
  const range = parsePort("3000-3010", true)!;
  expect(covers(range, parsePort(3005)!)).toBe(true);
  expect(covers(range, parsePort(3011)!)).toBe(false);
  expect(covers(parsePort("db:5432")!, parsePort(5432)!)).toBe(true);
  expect(covers(parsePort("db:5432")!, parsePort("cache:5432")!)).toBe(false);
});

test("patterns are keys with regex syntax that compiles", () => {
  expect(isPattern(".+\\.js")).toBe(true);
  expect(isPattern("3000")).toBe(false);
  expect(isPattern("(")).toBe(false);
});
