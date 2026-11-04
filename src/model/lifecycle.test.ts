import { expect, test } from "bun:test";
import { parse } from "../jsonc/jsonc";
import { lifecycleCommands, shellOperators } from "./lifecycle";
import { lower } from "./lower";

test("all six properties and the parallel form's entries are visited", () => {
  const text = JSON.stringify({
    image: "x",
    initializeCommand: "a",
    onCreateCommand: ["b"],
    updateContentCommand: "c",
    postCreateCommand: { one: "d", two: ["e"] },
    postStartCommand: "f",
    postAttachCommand: "g",
  });
  const cmds = lifecycleCommands(lower(parse("u", text)));
  expect(cmds.map((c) => `${c.property}${c.name ? `.${c.name}` : ""}:${c.form}`)).toEqual([
    "initializeCommand:string",
    "onCreateCommand:array",
    "updateContentCommand:string",
    "postCreateCommand.one:string",
    "postCreateCommand.two:array",
    "postStartCommand:string",
    "postAttachCommand:string",
  ]);
});

test.each<[string, string[]]>([
  ["a && b", ["&&"]],
  ["a | b > c", ["|", ">"]],
  ["echo 'a && b'", []],
  ['echo "a | b"', []],
  [String.raw`echo a\;b`, []],
  ["a; b", [";"]],
  ["npm test", []],
])("shellOperators(%s)", (s, want) => {
  expect(shellOperators(s)).toEqual(want);
});
