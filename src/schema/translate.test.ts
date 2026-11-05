import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../jsonc/jsonc";
import { lower } from "../model/lower";
import { expectGolden } from "../testutil/golden";
import { suggest } from "./suggest";
import { schemaErrors } from "./translate";

const fixtures = join(import.meta.dir, "testdata", "translate");

/** Each error as `class @ the source it points at: message`, in order. */
function check(text: string) {
  return schemaErrors(lower(parse("u", text))).map(
    (e) => `${e.class} @ ${text.slice(e.range.start, e.range.end)}: ${e.message}`,
  );
}

const cases = readdirSync(fixtures).filter((f) => f.endsWith(".jsonc"));

// written first: a branch name or JSON Pointer in a message means the filter leaked
test("no translated message mentions a schema branch or a JSON Pointer", () => {
  for (const name of cases) {
    for (const line of check(readFileSync(join(fixtures, name), "utf8"))) {
      expect(line, name).not.toMatch(/oneOf|anyOf|allOf|#\/|instancePath|\/\d/);
    }
  }
});

describe("one fixture per error class, golden-compared", () => {
  test.each(cases)("%s", (name) => {
    const text = readFileSync(join(fixtures, name), "utf8");
    const errors = schemaErrors(lower(parse(name, text))).map((e) => ({
      class: e.class,
      at: text.slice(e.range.start, e.range.end),
      message: e.message,
      ...(e.help && { help: e.help }),
      docsUrl: e.docsUrl,
    }));
    expectGolden(join(fixtures, name.replace(/\.jsonc$/, ".golden.json")), errors);
  });
});

test("a Compose document with a stray image is left to the scenario rules, not a branch failure", () => {
  expect(
    check('{"dockerComposeFile": "c", "service": "s", "workspaceFolder": "/w", "image": "x"}'),
  ).toEqual([]);
});

test("a property the scenario doesn't take says so, rather than calling it unknown", () => {
  expect(check('{"image": "x", "service": "s"}')).toEqual([
    'unknown-property @ "service": "service" doesn\'t apply to an image-based config',
  ]);
});

test("a typo inside build blames the build object, not the legacy dockerFile form", () => {
  expect(check('{"build": {"dockerfle": "D"}}')).toEqual([
    'missing-required @ "build": "build" is missing required property "dockerfile"',
    'unknown-property @ "dockerfle": Unknown property "dockerfle"',
  ]);
});

test("a mistyped source isn't reported as no source at all", () => {
  expect(check('{"image": 1}')).toEqual(['type-mismatch @ 1: "image" must be a string']);
});

test("the range covers the offending key or value, not the enclosing object", () => {
  expect(check('{"image": "x", "mounts": [{"type": "bind", "target": 1}]}')).toEqual([
    'type-mismatch @ 1: "mounts.0.target" must be a string',
  ]);
});

describe("suggest", () => {
  test.each<[string, string, string | undefined]>([
    ["postCreateComand", "postCreateCommand", "one deletion"],
    ["nmae", "name", "one swap"],
    ["imag", "image", "short key, one edit"],
    ["colour", undefined, "unrelated"],
    ["xyz", undefined, "short and unrelated"],
  ] as never)("%s -> %s (%s)", (word, want) => {
    expect(suggest(word, ["postCreateCommand", "name", "image", "mounts"])).toBe(want);
  });
});
