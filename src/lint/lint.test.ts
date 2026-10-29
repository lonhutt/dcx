import { describe, expect, test } from "bun:test";
import { parse } from "../jsonc/jsonc";
import { lint, suggest } from "./lint";

/** Each diagnostic as `rule @ the source text it points at: message`, in order. */
function check(text: string) {
  return lint(parse("u", text)).map(
    (d) => `${d.rule} @ ${text.slice(d.range.start, d.range.end)}: ${d.message}`,
  );
}

test("a valid config of each kind has no problems", () => {
  expect(check('{"image": "x", "forwardPorts": [3000], "postCreateCommand": ["a"]}')).toEqual([]);
  expect(check('{"build": {"dockerfile": "D", "context": ".."}}')).toEqual([]);
  expect(check('{"dockerFile": "D", "context": ".."}')).toEqual([]);
  expect(
    check('{"dockerComposeFile": "c.yml", "service": "app", "workspaceFolder": "/w"}'),
  ).toEqual([]);
});

describe("schema errors name the actual mistake, not the schema's branches", () => {
  test("a typo'd property suggests the right one", () => {
    expect(check('{"image": "x", "postCreateComand": "a"}')).toEqual([
      'schema/unknown-property @ "postCreateComand": Unknown property "postCreateComand"; did you mean "postCreateCommand"?',
    ]);
  });

  test("an image in a Compose config is a conflict, not an unknown property", () => {
    expect(
      check('{"dockerComposeFile": "c", "service": "s", "workspaceFolder": "/w", "image": "x"}'),
    ).toEqual([
      'schema/scenario-conflict @ "image": "image" doesn\'t apply to a Docker Compose config',
    ]);
  });

  test("a config with nothing to run says so once", () => {
    expect(check('{"name": "x"}')).toEqual([
      'schema/no-source @ {: Nothing to run: set "image", "build" or "dockerComposeFile"',
    ]);
  });

  test("a typo inside build blames the build object, not the legacy dockerFile form", () => {
    expect(check('{"build": {"dockerfle": "D"}}')).toEqual([
      'schema/missing-required @ "build": "build" is missing required property "dockerfile"',
      'schema/unknown-property @ "dockerfle": Unknown property "dockerfle"',
    ]);
  });

  test("enum, type and nested required errors point at the offending value", () => {
    expect(
      check(
        '{"image": "x", "shutdownAction": "no", "forwardPorts": "3000", "mounts": [{"type": "bind"}]}',
      ),
    ).toEqual([
      'schema/invalid-value @ "no": "shutdownAction" must be one of "none", "stopContainer"',
      'schema/wrong-type @ "3000": "forwardPorts" must be an array',
      'schema/missing-required @ {: "mounts.0" is missing required property "target"',
    ]);
  });

  test("a value no branch accepts lists every type that would do, once", () => {
    expect(check('{"image": "x", "postCreateCommand": 1}')).toEqual([
      'schema/wrong-type @ 1: "postCreateCommand" must be a string or array or object',
    ]);
  });

  test("numeric object keys resolve as keys, not array indexes", () => {
    expect(check('{"image": "x", "portsAttributes": {"3000": {"label": 4}}}')).toEqual([
      'schema/wrong-type @ 4: "portsAttributes.3000.label" must be a string',
    ]);
  });
});

test("duplicate keys are reported at the repeat", () => {
  expect(check('{"image": "x", "name": "a", "name": "b"}')).toEqual([
    'syntax/duplicate-key @ "name": Duplicate key "name"; only the last one takes effect',
  ]);
});

test("syntax errors are reported alone, one per spot", () => {
  expect(check('{"image": "x",')).toEqual(["syntax/parse-error @ : Property name expected"]);
});

test("suggest only offers a close match", () => {
  expect(suggest("imag", ["image", "name"])).toBe("image");
  expect(suggest("colour", ["image", "name"])).toBeUndefined();
});
