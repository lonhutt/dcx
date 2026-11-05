import { describe, expect, test } from "bun:test";
import { parse, rangeOf, textOf } from "../jsonc/jsonc";
import { lower } from "./lower";
import type { Field, Scenario } from "./model";

const model = (text: string) => lower(parse("u", text));
const spell = (text: string, f: Field<unknown>) =>
  text.slice(rangeOf(f.node).start, rangeOf(f.node).end);

describe("scenario", () => {
  test.each<[string, Scenario["kind"]]>([
    ['{"image": "x"}', "image"],
    ['{"build": {"dockerfile": "D"}}', "dockerfile"],
    ['{"dockerFile": "D"}', "dockerfile"],
    ['{"dockerComposeFile": "c.yml", "service": "s"}', "compose"],
    ['{"dockerComposeFile": ["a.yml", "b.yml"]}', "compose"],
    ['{"image": "x", "dockerComposeFile": "c.yml"}', "ambiguous"],
    ['{"name": "x"}', "metadataOnly"],
    ["{}", "unknown"],
    ["[1]", "unknown"],
    ["", "unknown"],
    ['{"image": 1}', "unknown"],
  ])("%s is %s", (text, kind) => {
    expect(model(text).scenario.kind).toBe(kind);
  });

  test("ambiguous carries every conflicting source with its span", () => {
    const text = '{"image": "x", "build": {"dockerfile": "D"}, "dockerComposeFile": "c"}';
    const s = model(text).scenario;
    if (s.kind !== "ambiguous") throw new Error(s.kind);
    expect(s.sources.map((f) => spell(text, f))).toEqual(['"x"', '"D"', '"c"']);
  });

  test("legacy dockerFile is flagged legacy; build.dockerfile isn't", () => {
    const legacy = model('{"dockerFile": "D"}').scenario;
    const modern = model('{"build": {"dockerfile": "D"}}').scenario;
    expect(legacy.kind === "dockerfile" && legacy.legacy).toBe(true);
    expect(modern.kind === "dockerfile" && modern.legacy).toBe(false);
  });

  test("compose with a list of files and a service", () => {
    const s = model('{"dockerComposeFile": ["a", 2, "b"], "service": "app"}').scenario;
    if (s.kind !== "compose") throw new Error(s.kind);
    expect(s.files.map((f) => f.value)).toEqual(["a", "b"]);
    expect(s.service?.value).toBe("app");
  });
});

describe("build", () => {
  test("legacy dockerFile/context lowers to the same shape as build.*, with its own spans", () => {
    const text = '{"dockerFile": "D", "context": ".."}';
    const legacy = model(text).build!;
    const modern = model('{"build": {"dockerfile": "D", "context": ".."}}').build!;
    expect([legacy.dockerfile?.value, legacy.context?.value]).toEqual(["D", ".."]);
    expect([modern.dockerfile?.value, modern.context?.value]).toEqual(["D", ".."]);
    expect(textOf(parse("u", text), legacy.dockerfile!.key!)).toBe('"dockerFile"');
  });

  test("build without a dockerfile is still a build, with nothing to run", () => {
    const m = model('{"build": {"context": "."}}');
    expect(m.build?.context?.value).toBe(".");
    expect(m.scenario.kind).toBe("metadataOnly");
  });
});

describe("fields", () => {
  test("every present field has its value's span and its key's", () => {
    const text = '{"name": "n", "forwardPorts": [1, 2], "privileged": true}';
    const m = model(text);
    for (const [name, f] of m.properties) {
      expect(text.slice(rangeOf(f.key!).start, rangeOf(f.key!).end)).toBe(`"${name}"`);
      expect(rangeOf(f.node).end).toBeGreaterThan(rangeOf(f.node).start);
    }
  });

  test("an explicit null is a present field with a null value, not an absent one", () => {
    const f = model('{"image": "x", "name": null}').get("name");
    expect(f).toBeDefined();
    expect(f!.value).toBeNull();
  });

  test("typed accessors only return a field of the right type", () => {
    const m = model('{"name": 1, "privileged": true, "mounts": [], "containerEnv": {}}');
    expect(m.string("name")).toBeUndefined();
    expect(m.boolean("privileged")?.value).toBe(true);
    expect(m.array("mounts")?.value).toEqual([]);
    expect(m.object("containerEnv")?.value).toEqual({});
  });

  test("a duplicate key resolves to the last occurrence", () => {
    expect(model('{"name": "a", "name": "b"}').string("name")?.value).toBe("b");
  });
});
