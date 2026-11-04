import type { Node } from "jsonc-parser/lib/esm/main.js";
import type { Offset } from "../position/position";

/** A `,` with nothing after it but the closing `}` or `]`. */
export interface TrailingComma {
  readonly offset: Offset;
  /** The object or array the comma sits in. */
  readonly container: Node;
}

/** Objects and arrays by their opening offset; how a visitor event finds its node. */
export function containersByOffset(root: Node | undefined): Map<Offset, Node> {
  const out = new Map<Offset, Node>();
  const walk = (node: Node) => {
    if (node.type === "object" || node.type === "array") out.set(node.offset, node);
    node.children?.forEach(walk);
  };
  if (root) walk(root);
  return out;
}
