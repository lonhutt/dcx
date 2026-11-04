import { rule } from "../util";

export const trailingComma = rule({
  id: "syntax/trailing-comma",
  description: "Legal per spec, but some third-party parsers reject it",
  explain: `The dev container spec allows trailing commas, and VS Code and the dev
container CLI accept them. Some other tools that read devcontainer.json (a strict JSON
parser in a script, an older CI action) don't. Off by default; turn it on if a tool in
your pipeline chokes on them.

    { "forwardPorts": [3000, 8080,], }   // two trailing commas

Delete the comma before the closing bracket or brace.`,
  defaultSeverity: "off",
  check({ doc, report }) {
    for (const c of doc.trailingCommas) {
      report({
        range: { start: c.offset, end: c.offset + 1 },
        message: `Trailing comma in ${c.container.type === "array" ? "an array" : "an object"}`,
        help: "delete the comma",
      });
    }
  },
});
