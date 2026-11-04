import { posix } from "node:path";
import type { Diagnostic, Severity } from "../diagnostic/diagnostic";
import type { LineIndex } from "../position/position";
import type { Rule } from "../rules/rule";
import type { FileResult } from "./report";
import { catalog } from "./rules";

type Level = "error" | "warning" | "note";

/** The SARIF 2.1.0 subset dcx emits. */
export interface SarifLog {
  readonly $schema: string;
  readonly version: "2.1.0";
  readonly runs: readonly SarifRun[];
}
interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: string;
      readonly version: string;
      readonly informationUri: string;
      readonly rules: readonly SarifRule[];
    };
  };
  readonly results: readonly SarifResult[];
}
interface SarifRule {
  readonly id: string;
  readonly shortDescription: { readonly text: string };
  readonly fullDescription: { readonly text: string };
  readonly helpUri: string;
  readonly defaultConfiguration: { readonly enabled: boolean; readonly level: Level };
}
interface SarifResult {
  readonly ruleId: string;
  readonly ruleIndex: number;
  readonly level: Level;
  readonly message: { readonly text: string };
  readonly locations: readonly {
    readonly physicalLocation: {
      readonly artifactLocation: { readonly uri: string };
      readonly region: {
        readonly startLine: number;
        readonly startColumn: number;
        readonly endLine: number;
        readonly endColumn: number;
      };
    };
  }[];
  readonly suppressions?: readonly { readonly kind: "inSource"; readonly justification?: string }[];
}

export function levelFor(severity: Exclude<Severity, "off">): Level {
  return severity === "info" ? "note" : severity;
}

/** `path` as a relative, forward-slashed URI, whatever platform produced it. */
export function artifactUri(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/")).split("/").map(encodeURIComponent).join("/");
}

/**
 * SARIF for one run. `rules[]` carries the whole registry, so code scanning can show a
 * description and help link for anything; results include suppressed findings, marked
 * as in-source suppressions.
 */
export function sarif(
  files: readonly FileResult[],
  rules: readonly Rule[],
  version: string,
): string {
  const info = catalog(rules);
  const index = new Map(info.map((r, i) => [r.id, i]));
  const results: SarifResult[] = [];
  for (const f of files) {
    const uri = artifactUri(f.path);
    for (const d of f.diagnostics) {
      if (d.severity === "off") continue;
      results.push(result(d, uri, f.lines, index.get(d.ruleId) ?? -1));
    }
  }
  const log: SarifLog = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "dcx",
            version,
            informationUri: "https://github.com/lonhutt/dcx",
            rules: info.map((r) => ({
              id: r.id,
              shortDescription: { text: r.description },
              fullDescription: { text: r.explain.trim() },
              helpUri: r.helpUri,
              defaultConfiguration: {
                enabled: r.defaultSeverity !== "off",
                level: levelFor(r.defaultSeverity === "off" ? "warning" : r.defaultSeverity),
              },
            })),
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(log, null, 2) + "\n";
}

function result(d: Diagnostic, uri: string, lines: LineIndex, ruleIndex: number): SarifResult {
  // SARIF columns count characters, not display width; UTF-16 offsets are the closest match
  const at = (offset: number) => {
    const p = lines.positionAt(offset);
    return { line: p.line + 1, column: p.character + 1 };
  };
  const start = at(d.range.start);
  const end = at(Math.max(d.range.end, d.range.start));
  return {
    ruleId: d.ruleId,
    ...(ruleIndex >= 0 && { ruleIndex }),
    level: levelFor(d.severity as Exclude<Severity, "off">),
    message: { text: d.help ? `${d.message}\n\n${d.help}` : d.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          region: {
            startLine: start.line,
            startColumn: start.column,
            endLine: end.line,
            endColumn: end.column,
          },
        },
      },
    ],
    ...(d.suppressed && {
      suppressions: [
        { kind: "inSource" as const, ...(d.suppressReason && { justification: d.suppressReason }) },
      ],
    }),
  } as SarifResult;
}
