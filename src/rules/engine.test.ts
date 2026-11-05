import { expect, test } from "bun:test";
import { parse } from "../jsonc/jsonc";
import { passInput } from "../lint/analyze";
import { DEFAULTS } from "../lintconfig/config";
import { MemFS } from "../vfs/memfs";
import { runRules } from "./engine";
import type { Pass, Rule } from "./rule";
import { rule } from "./util";

const input = (signal = new AbortController().signal) =>
  passInput(
    parse("/w/.devcontainer.json", '{"image": "x"}'),
    "/w/.devcontainer.json",
    { fs: new MemFS() },
    DEFAULTS,
    signal,
  );

const make = (id: string, check: Rule["check"], extra: Partial<Rule> = {}) =>
  ({
    ...rule({
      id,
      description: "d",
      explain: "explained at length",
      defaultSeverity: "warning",
      check,
    }),
    ...extra,
  }) as Rule;

const reportsN = (id: string, n: number) =>
  make(id, ({ report }) => {
    for (let i = 0; i < n; i++) report({ range: { start: i, end: i + 1 }, message: `${id} ${i}` });
  });

test("100 runs produce identical output", async () => {
  const rules = [
    reportsN("a/a", 3),
    reportsN("b/b", 2),
    make("c/c", async ({ report }) => {
      await Bun.sleep(0);
      report({ range: { start: 0, end: 1 }, message: "async" });
    }),
  ];
  const first = JSON.stringify(await runRules(rules, input()));
  for (let i = 0; i < 100; i++) expect(JSON.stringify(await runRules(rules, input()))).toBe(first);
});

test("a throwing rule yields an internal finding naming it, and everyone else's findings", async () => {
  const got = await runRules(
    [
      make("a/boom", () => {
        throw new Error("kaboom");
      }),
      make("a/reject", async () => {
        throw new Error("rejected");
      }),
      reportsN("b/fine", 1),
    ],
    input(),
  );
  expect(got.map((d) => `${d.ruleId}: ${d.message}`)).toEqual([
    "a/boom: Internal error in rule a/boom: kaboom",
    "a/reject: Internal error in rule a/reject: rejected",
    "b/fine: b/fine 0",
  ]);
});

test("a rule that never settles: aborting returns promptly with nothing more reported", async () => {
  const controller = new AbortController();
  let late: Pass["report"] | undefined;
  const rules = [
    reportsN("a/first", 1),
    make("b/hang", ({ report }) => {
      late = report;
      return new Promise(() => {});
    }),
    reportsN("c/never", 1),
  ];
  const run = runRules(rules, input(controller.signal));
  setTimeout(() => controller.abort(), 5);
  const started = performance.now();
  const got = await run;
  expect(performance.now() - started).toBeLessThan(1000);
  late!({ range: { start: 0, end: 1 }, message: "after abort" });
  expect(got.map((d) => d.ruleId)).toEqual(["a/first"]);
});

test("a report after check returned is ignored, not attributed to a later run", async () => {
  let saved: Pass["report"] | undefined;
  const rules = [make("a/late", ({ report }) => void (saved = report))];
  const got = await runRules(rules, input());
  saved!({ range: { start: 0, end: 1 }, message: "late" });
  expect(got).toEqual([]);
});

test("a timer scheduled before a run still fires during it", async () => {
  let fired = false;
  let firedDuring = false;
  setTimeout(() => (fired = true), 0);
  const rules = Array.from({ length: 50 }, (_, i) =>
    make(`a/r${i}`, () => {
      if (fired) firedDuring = true;
      const end = performance.now() + 0.2;
      while (performance.now() < end);
    }),
  );
  await runRules(rules, input());
  expect(firedDuring).toBe(true);
});

test("off rules don't run; severity comes from the callback", async () => {
  let ran = false;
  const got = await runRules(
    [make("a/off", () => void (ran = true)), reportsN("b/on", 1)],
    input(),
    (r) => (r.id === "a/off" ? "off" : "error"),
  );
  expect(ran).toBe(false);
  expect(got.map((d) => d.severity)).toEqual(["error"]);
});

test("network rules run concurrently, after the offline ones", async () => {
  const order: string[] = [];
  const net = (id: string, ms: number) =>
    make(
      id,
      async () => {
        order.push(`${id} start`);
        await Bun.sleep(ms);
        order.push(`${id} end`);
      },
      { requiresNetwork: true },
    );
  await runRules(
    [net("n/slow", 20), net("n/fast", 1), make("a/offline", () => void order.push("offline"))],
    input(),
  );
  expect(order).toEqual(["offline", "n/slow start", "n/fast start", "n/fast end", "n/slow end"]);
});
