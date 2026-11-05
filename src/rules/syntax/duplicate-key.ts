import { rangeOf, type Node } from "../../jsonc/jsonc";
import { rule } from "../util";

export const duplicateKey = rule({
  id: "syntax/duplicate-key",
  description: "Key appears twice; later value silently wins",
  explain: `A key that appears twice in the same object is legal JSON, but only the last
value counts; the first is silently thrown away. That's almost always a merge accident or
a copy-paste, and the value someone is editing may be the one that's ignored.

    {
      "image": "node:20",
      "image": "node:22"   // this one wins
    }

Delete one of the two, keeping the value you meant. Keys are compared after decoding
escapes, so "a\\u0062" and "ab" are the same key.`,
  defaultSeverity: "error",
  justification:
    "the earlier value is dropped without a word, so part of what the author wrote never applies",
  check({ doc, report }) {
    const walk = (node: Node) => {
      if (node.type === "object") {
        const first = new Map<string, Node>();
        for (const property of node.children ?? []) {
          // decoded, so "a\\u0062" and "ab" collide; never getNodeValue, which collapses them
          const key = property.children?.[0];
          if (typeof key?.value !== "string") continue;
          const original = first.get(key.value);
          if (!original) {
            first.set(key.value, key);
            continue;
          }
          report({
            range: rangeOf(key),
            message: `Duplicate key "${key.value}"; only the last one takes effect`,
            help: "delete one of them, keeping the value you meant",
            related: [
              { range: rangeOf(original), message: `"${key.value}" is first defined here` },
            ],
          });
        }
      }
      node.children?.forEach(walk);
    };
    if (doc.root) walk(doc.root);
  },
});
