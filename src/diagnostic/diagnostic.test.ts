import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectGolden } from "../testutil/golden";
import { sortDiagnostics, type Diagnostic } from "./diagnostic";

const d = (start: number, ruleId: string, message = "m", end = start + 1): Diagnostic => ({
  ruleId,
  severity: "error",
  range: { start, end },
  message,
});

function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

test("sorting is total: any two shuffles of the same findings sort identically", () => {
  const all = [
    d(5, "b/x"),
    d(5, "a/x"),
    d(5, "a/x", "n"),
    d(5, "a/x", "m", 9),
    d(1, "z/z"),
    d(9, "a/a"),
  ];
  const label = (x: Diagnostic) => `${x.range.start}-${x.range.end} ${x.ruleId} ${x.message}`;
  for (const seed of [1, 7, 42, 1234]) {
    expect(sortDiagnostics(shuffle(all, seed)).map(label)).toEqual([
      "1-2 z/z m",
      "5-6 a/x m",
      "5-6 a/x n",
      "5-6 b/x m",
      "5-9 a/x m",
      "9-10 a/a m",
    ]);
  }
});

test("sorting keeps fully identical findings in insertion order", () => {
  const a = { ...d(1, "a/a"), help: "first" };
  const b = { ...d(1, "a/a"), help: "second" };
  expect(sortDiagnostics([a, b]).map((x) => x.help)).toEqual(["first", "second"]);
  expect(sortDiagnostics([b, a]).map((x) => x.help)).toEqual(["second", "first"]);
});

test("the serialised shape omits unset optional fields rather than emitting null", () => {
  expectGolden(join(import.meta.dir, "testdata", "diagnostic.golden.json"), [
    d(0, "style/missing-name"),
    {
      ruleId: "deprecation/app-port",
      severity: "warning",
      range: { start: 3, end: 12 },
      message: '"appPort" is superseded by "forwardPorts"',
      help: 'move the ports to "forwardPorts"',
      docsUrl: "https://containers.dev/implementors/json_reference/",
      fix: { title: "Use forwardPorts", edits: [{ range: { start: 3, end: 12 }, newText: "x" }] },
      related: [{ range: { start: 0, end: 1 }, message: "first defined here" }],
      suppressed: true,
      suppressReason: "legacy",
    } satisfies Diagnostic,
  ]);
});
