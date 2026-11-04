import { expect, test } from "bun:test";
import { parse, textOf } from "../jsonc/jsonc";
import { parseSubstitutions } from "./subst";

const spans = (raw: string) =>
  parseSubstitutions(raw, 0).map(
    (s) => `${raw.slice(s.range.start, s.range.end)} = ${s.scope}|${s.name}|${s.default ?? "-"}`,
  );

test("the range covers the reference, not the whole string", () => {
  expect(spans('"PATH=${localEnv:HOME}/bin"')).toEqual(["${localEnv:HOME} = localEnv|HOME|-"]);
});

test("plain variables, scoped ones, and defaults", () => {
  expect(
    spans('"${localWorkspaceFolder} ${containerEnv:PATH:/usr/bin} ${devcontainerId}"'),
  ).toEqual([
    "${localWorkspaceFolder} = localWorkspaceFolder||-",
    "${containerEnv:PATH:/usr/bin} = containerEnv|PATH|/usr/bin",
    "${devcontainerId} = devcontainerId||-",
  ]);
});

test("a default holding a nested reference; both are found", () => {
  expect(spans('"${localEnv:A:${localEnv:B}}"')).toEqual([
    "${localEnv:A:${localEnv:B}} = localEnv|A|${localEnv:B}",
    "${localEnv:B} = localEnv|B|-",
  ]);
});

test("spans survive escapes before the reference", () => {
  const text = '{"x": "say \\"hi\\" to ${localEnv:USER}"}';
  const node = parse("u", text).root!.children![0]!.children![1]!;
  const [s] = parseSubstitutions(textOf(parse("u", text), node), node.offset);
  expect(text.slice(s!.range.start, s!.range.end)).toBe("${localEnv:USER}");
});

test("an unclosed reference and a lone $ are ignored", () => {
  expect(spans('"${localEnv:A and $5"')).toEqual([]);
});
