import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { assertNoSplitSurrogate, LineIndex } from "../position/position";
import { findNodeAtLocation, parse, rangeOf, type Node } from "./jsonc";

// real-world and mixed-script fixtures; borrowed from the position tests until there's a corpus
const positionFixtures = join(import.meta.dir, "..", "position", "testdata");
const fixture = (name: string) => Bun.file(join(positionFixtures, name)).text();

/** Every node in the tree, parents before children. */
function nodes(root: Node | undefined): Node[] {
  if (!root) return [];
  return [root, ...(root.children ?? []).flatMap(nodes)];
}

/**
 * Checks every node's span against the source and its neighbours, and returns the first
 * problem (or undefined) so a failure names the node instead of printing `expected true`.
 * With `exact`, leaf spans also have to parse back to the node's own value.
 */
function firstBadSpan(text: string, root: Node | undefined, exact: boolean) {
  for (const node of nodes(root)) {
    const { start, end } = rangeOf(node);
    const span = text.slice(start, end);
    const where = { type: node.type, start, end, span: span.slice(0, 40) };
    if (start < 0 || end > text.length || start > end)
      return { ...where, problem: "out of bounds" };
    try {
      assertNoSplitSurrogate(text, { start, end });
    } catch {
      return { ...where, problem: "splits a surrogate pair" };
    }
    let previousEnd = start;
    for (const child of node.children ?? []) {
      const r = rangeOf(child);
      if (r.start < previousEnd || r.end > end)
        return { ...where, problem: "child outside parent or overlapping" };
      previousEnd = r.end;
    }
    if (!exact) continue;
    if (node.type === "object" && !(span.startsWith("{") && span.endsWith("}"))) return where;
    if (node.type === "array" && !(span.startsWith("[") && span.endsWith("]"))) return where;
    if (
      node.type === "property" &&
      node.children?.[0] &&
      rangeOf(node.children[0]).start !== start
    ) {
      return { ...where, problem: "property doesn't start at its key" };
    }
    if (
      ["string", "number", "boolean", "null"].includes(node.type) &&
      JSON.parse(span) !== node.value
    ) {
      return { ...where, problem: "leaf span doesn't parse back to its value" };
    }
  }
  return undefined;
}

describe("parse", () => {
  test("returns the uri, the text, and a LineIndex over it", () => {
    const doc = parse("file:///w/.devcontainer.json", '{\n  "image": "x"\n}\n');
    expect(doc.uri).toBe("file:///w/.devcontainer.json");
    expect(doc.text).toBe('{\n  "image": "x"\n}\n');
    expect(doc.lines).toBeInstanceOf(LineIndex);
    expect(doc.lines.lineCount).toBe(4);
    expect(doc.errors).toEqual([]);
    expect(doc.root?.type).toBe("object");
  });

  test("the document is frozen", () => {
    expect(Object.isFrozen(parse("u", "{}"))).toBe(true);
  });

  test.each<[string, string]>([
    ["empty", ""],
    ["whitespace", "   "],
    ["only a comment", "// just a comment"],
    ["garbage", "@@@"],
    ["a lone closing brace", "}"],
  ])("root is undefined for %s, and the error is still reported", (_, text) => {
    const doc = parse("u", text);
    expect(doc.root).toBeUndefined();
    expect(doc.errors.length).toBeGreaterThan(0);
  });

  test("broken JSON still gets a root; the parser recovers and reports what it skipped", () => {
    const doc = parse("u", '{"a": }');
    expect(doc.root?.type).toBe("object");
    expect(doc.errors.length).toBeGreaterThan(0);
    expect(doc.errors[0]!.offset).toBe(6);
  });

  test("errors are collected, not dropped (the parser takes them as an out-parameter)", () => {
    expect(parse("u", "{").errors.length).toBeGreaterThan(0);
    expect(parse("u", "1 2").errors.length).toBeGreaterThan(0);
  });

  test.each<[string, string, number]>([
    ["object", '{"a": 1,}', 1],
    ["array", "[1, 2,]", 2],
    ["nested", '{"a": [1,], "b": {"c": 1,},}', 2],
  ])("a trailing comma in an %s isn't an error and costs nothing", (_, text, children) => {
    const doc = parse("u", text);
    expect(doc.errors).toEqual([]);
    expect(doc.root?.children?.length).toBe(children);
  });

  test("duplicate keys stay as separate properties, in source order", () => {
    const root = parse("u", '{"a": 1, "a": 2}').root!;
    expect(root.children?.map((p) => p.children?.[1]?.value)).toEqual([1, 2]);
  });
});

describe("rangeOf", () => {
  const text = '{\n  // comment\n  "a": [1, "x😀"],\n}';
  // parsed per test, not here; a throw at collection time would hide these tests entirely
  const root = () => parse("u", text).root!;

  test("covers exactly the node's source text", () => {
    const value = findNodeAtLocation(root(), ["a", 1])!;
    expect(text.slice(rangeOf(value).start, rangeOf(value).end)).toBe('"x😀"');
  });

  test("a property's range runs from its key to the end of its value", () => {
    const property = findNodeAtLocation(root(), ["a"])!.parent!;
    const { start, end } = rangeOf(property);
    expect(text.slice(start, end)).toBe('"a": [1, "x😀"]');
  });

  test("the root's range skips leading comments and whitespace, not the braces", () => {
    const { start, end } = rangeOf(parse("u", "  // x\n  {}  ").root!);
    expect([start, end]).toEqual([9, 11]);
  });
});

// every node's span has to line up with the source, or every diagnostic drawn from it is off
describe("node spans reconstruct the source", () => {
  test("inline sample with comments, trailing commas and astral characters", () => {
    const text =
      '/* top */ {"name": "开发 🐳", "n": -1.5e3, "ok": true, "x": null, "arr": [1, {"k": "v"},],}';
    const doc = parse("u", text);
    expect(doc.errors).toEqual([]);
    expect(firstBadSpan(text, doc.root, true)).toBeUndefined();
  });

  test.each(["mixed-script.jsonc", "large-commented.jsonc"])("%s", async (name) => {
    const text = await fixture(name);
    const doc = parse(name, text);
    expect(doc.errors).toEqual([]);
    expect(nodes(doc.root).length).toBeGreaterThan(10);
    expect(firstBadSpan(text, doc.root, true)).toBeUndefined();
  });
});

// An editor parses on every keystroke, so half-typed text is the normal case. Truncating a
// real file at every offset is a cheap way to get every kind of half-typed.
describe("truncated input never throws, and spans stay in bounds", () => {
  function firstFailure(text: string, offsets: Iterable<number>) {
    for (const cut of offsets) {
      const prefix = text.slice(0, cut);
      try {
        const bad = firstBadSpan(prefix, parse("u", prefix).root, false);
        if (bad) return { cut, ...bad };
      } catch (err) {
        return { cut, threw: String(err) };
      }
    }
    return undefined;
  }
  const every = (n: number, step = 1) =>
    Array.from({ length: Math.ceil((n + 1) / step) }, (_, i) => i * step);

  test("mixed-script fixture, every offset", async () => {
    const text = await fixture("mixed-script.jsonc");
    expect(firstFailure(text, every(text.length))).toBeUndefined();
  });

  test("large fixture; every offset of the first 4,000 units, then every 97th", async () => {
    const text = await fixture("large-commented.jsonc");
    const offsets = [...every(4000), ...every(text.length, 97).filter((o) => o > 4000)];
    expect(firstFailure(text, offsets)).toBeUndefined();
  });
});

// The parser should only be imported here; anywhere else and replacing it means hunting
// through the codebase. Mentions in comments are fine, imports aren't.
test("nothing outside src/jsonc imports jsonc-parser", async () => {
  const src = join(import.meta.dir, "..");
  const importsParser = /(?:from|import)\s*\(?\s*["']jsonc-parser["']/;
  const offenders: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: src, absolute: true })) {
    if (relative(src, path).startsWith("jsonc")) continue;
    if (importsParser.test(await Bun.file(path).text())) offenders.push(relative(src, path));
  }
  expect(offenders).toEqual([]);
});
