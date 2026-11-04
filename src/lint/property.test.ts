import { expect, test } from "bun:test";
import fc from "fast-check";
import { parse } from "../jsonc/jsonc";
import { assertNoSplitSurrogate } from "../position/position";
import { MemFS } from "../vfs/memfs";
import { analyze } from "./analyze";

const PATH = "/w/.devcontainer/devcontainer.json";
const KEYS = [
  "image",
  "build",
  "dockerFile",
  "dockerComposeFile",
  "service",
  "features",
  "mounts",
  "forwardPorts",
  "portsAttributes",
  "runArgs",
  "containerEnv",
  "postCreateCommand",
  "customizations",
  "name",
  "workspaceFolder",
  "appPort",
  "extensions",
  "settings",
];

/** JSON-ish values biased toward devcontainer.json's own keys, so rules actually run. */
const value = fc.letrec((tie) => ({
  v: fc.oneof(
    { depthSize: "small" },
    fc.string(),
    fc.integer({ min: -10, max: 70_000 }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("v"), { maxLength: 4 }),
    fc.dictionary(fc.oneof(fc.constantFrom(...KEYS), fc.string()), tie("v"), { maxKeys: 4 }),
  ),
})).v;

const config = fc
  .dictionary(fc.constantFrom(...KEYS), value, { maxKeys: 8 })
  .map((o) => JSON.stringify(o, null, 2));

/** Valid-ish text, then damaged: a slice cut out, or a random string spliced in. */
const damaged = fc
  .tuple(config, fc.nat(), fc.nat(20), fc.string({ unit: "binary", maxLength: 8 }))
  .map(([text, at, cut, insert]) => {
    const i = at % (text.length + 1);
    return text.slice(0, i) + insert + text.slice(i + cut);
  });

async function check(text: string) {
  const doc = parse(PATH, text);
  const { diagnostics } = await analyze(doc, PATH, { fs: new MemFS({ [PATH]: text }) });
  for (const d of diagnostics) {
    for (const r of [
      d.range,
      ...(d.related ?? []).map((x) => x.range),
      ...(d.fix?.edits ?? []).map((e) => e.range),
    ]) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(text.length);
      expect(r.start).toBeLessThanOrEqual(r.end);
      assertNoSplitSurrogate(text, r);
    }
    expect(d.ruleId).not.toBe("internal");
    expect(d.message).not.toStartWith("Internal error");
  }
}

test("any well-formed config: no throw, no internal error, every range in bounds", async () => {
  await fc.assert(fc.asyncProperty(config, check), { numRuns: 300 });
});

test("any damaged config: the same", async () => {
  await fc.assert(fc.asyncProperty(damaged, check), { numRuns: 300 });
});
