import { printParseErrorCode, rangeOf } from "../../jsonc/jsonc";
import { rule, sentence } from "../util";

export const parseError = rule({
  id: "syntax/parse-error",
  description: "Malformed JSONC",
  explain: `The file isn't valid JSONC (JSON with comments and trailing commas), so nothing
reading it can be sure what it says. The dev container CLI refuses to start, and every
other dcx rule is skipped until this is fixed, since checking a tree the parser had to
guess at mostly produces noise.

    { "image": "node:22" "name": "app" }   // missing comma

Fix the syntax at the reported spot. Comments and trailing commas are fine; a missing
comma, an unquoted key, or an unclosed brace isn't. A config must also be a JSON object
at the top level.`,
  defaultSeverity: "error",
  justification: "nothing reads a config that doesn't parse",
  check({ doc, report }) {
    // the parser often reports several errors at the spot it gave up; the first says it best
    const seen = new Set<number>();
    for (const e of doc.errors) {
      if (seen.has(e.offset)) continue;
      seen.add(e.offset);
      report({
        range: { start: e.offset, end: e.offset + e.length },
        message: sentence(printParseErrorCode(e.error)),
      });
    }
    if (!doc.errors.length && doc.root && doc.root.type !== "object") {
      report({
        range: rangeOf(doc.root),
        message: "Expected an object",
        help: "a devcontainer.json is one JSON object",
      });
    }
  },
});
