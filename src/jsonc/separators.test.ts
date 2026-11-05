import { expect, test } from "bun:test";
import { parse } from "./jsonc";

/** Each trailing comma as `offset in container-type`. */
const trailing = (text: string) =>
  parse("u", text).trailingCommas.map((c) => {
    expect(text[c.offset]).toBe(",");
    return `${c.offset} in ${c.container.type}`;
  });

test("an object and an array each with a trailing comma, in the same document", () => {
  expect(trailing('{"a": [1, 2,], "b": 1,}')).toEqual(["11 in array", "21 in object"]);
});

test("a trailing comma at depth is attributed to the innermost container", () => {
  expect(trailing('{"a": {"b": {"c": [1,],},}}')).toEqual([
    "20 in array",
    "22 in object",
    "24 in object",
  ]);
});

test("a comment between the comma and the bracket doesn't hide it", () => {
  expect(trailing('{"a": 1, // last\n}')).toEqual(["7 in object"]);
});

test("ordinary separators are never trailing", () => {
  expect(trailing('{"a": [1, 2], "b": {"c": 1, "d": 2}}')).toEqual([]);
  expect(trailing("[1, 2, 3]")).toEqual([]);
});
