import { sortDiagnostics, type Diagnostic, type Severity } from "../diagnostic/diagnostic";
import type { Finding, Pass, Rule } from "./rule";

/** A pass without `report`; the engine gives each rule its own. */
export type PassInput = Omit<Pass, "report">;

/**
 * Runs `rules` over one document, each at the severity `severity` gives it (`off` skips
 * it). Offline rules go one at a time, yielding to the event
 * loop between them so a pending cancellation gets seen; network rules run together,
 * since they spend their time waiting. A rule that throws becomes one error finding of
 * its own and costs nobody else theirs. Never throws. The findings come back sorted:
 * whatever was collected before the signal aborted, if it did.
 */
export async function runRules(
  rules: readonly Rule[],
  input: PassInput,
  severity: (rule: Rule) => Severity = (rule) => rule.defaultSeverity,
): Promise<Diagnostic[]> {
  const found: Diagnostic[] = [];
  const active = rules
    .map((rule) => ({ rule, severity: severity(rule) }))
    .filter((r) => r.severity !== "off");

  for (const r of active.filter((r) => !r.rule.requiresNetwork)) {
    if (input.signal.aborted) return sortDiagnostics(found);
    await runRule(r.rule, r.severity, input, found);
    // setImmediate, not a microtask: I/O callbacks (a didChange) only run between
    // macrotasks; and not setTimeout, whose ~1ms floor adds up over every rule
    await new Promise((resolve) => setImmediate(resolve));
  }
  const network = active.filter((r) => r.rule.requiresNetwork);
  if (network.length && !input.signal.aborted) {
    await Promise.allSettled(network.map((r) => runRule(r.rule, r.severity, input, found)));
  }
  return sortDiagnostics(found);
}

async function runRule(rule: Rule, severity: Severity, input: PassInput, into: Diagnostic[]) {
  let open = true;
  const report = (finding: Finding) => {
    // a report after check returned would land against whatever's current by then
    if (open && !input.signal.aborted) into.push({ ...finding, ruleId: rule.id, severity });
  };
  try {
    await untilAborted(Promise.resolve(rule.check({ ...input, report })), input.signal);
  } catch (err) {
    if (!input.signal.aborted) {
      into.push({
        ruleId: rule.id,
        severity: "error",
        range: { start: 0, end: 0 },
        message: `Internal error in rule ${rule.id}: ${(err as Error)?.message ?? String(err)}`,
        help: "this is a bug in dcx; please report it",
      });
    }
  } finally {
    open = false;
  }
}

/** Settles with `work`, or as soon as `signal` aborts; a rule that never settles can't hang a run. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
