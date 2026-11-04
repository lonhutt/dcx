import { describe, expect, test } from "bun:test";
import { parse, textOf, type Document } from "./jsonc";

/** Each comment as `comment text -> what it's attached to (leading|trailing)`. */
function attachments(doc: Document) {
  return doc.comments.map((c) => {
    const text = doc.text.slice(c.range.start, c.range.end);
    if (!c.attached) return `${text} -> nothing`;
    return `${text} -> ${textOf(doc, c.attached)} (${c.trailing ? "trailing" : "leading"})`;
  });
}

describe("attachment", () => {
  test("a comment on the line above a property leads it", () => {
    expect(attachments(parse("u", '{\n  // c\n  "a": 1\n}'))).toEqual(['// c -> "a": 1 (leading)']);
  });

  test("a stack of comments above a property all lead it", () => {
    expect(attachments(parse("u", '{\n  // one\n  /* two */\n  "a": 1\n}'))).toEqual([
      '// one -> "a": 1 (leading)',
      '/* two */ -> "a": 1 (leading)',
    ]);
  });

  test("a same-line comment trails the property on its line, even with another below", () => {
    expect(attachments(parse("u", '{\n  "a": 1, // c\n  "b": 2\n}'))).toEqual([
      '// c -> "a": 1 (trailing)',
    ]);
  });

  test("a trailing comment belongs to the property, not the last element inside it", () => {
    expect(attachments(parse("u", '{\n  "a": [1, 2], // c\n}'))).toEqual([
      '// c -> "a": [1, 2] (trailing)',
    ]);
  });

  test("a blank line breaks attachment", () => {
    expect(attachments(parse("u", '{\n  // c\n\n  "a": 1\n}'))).toEqual(["// c -> nothing"]);
  });

  test("comments in arrays attach to elements", () => {
    expect(attachments(parse("u", "[\n  // x\n  1,\n  2 // y\n]"))).toEqual([
      "// x -> 1 (leading)",
      "// y -> 2 (trailing)",
    ]);
  });

  test("comments between : and a value, after the last property, or at EOF are unattached", () => {
    expect(attachments(parse("u", '{\n  "a": /* mid */ 1\n  // after\n}\n// eof'))).toEqual([
      "/* mid */ -> nothing",
      "// after -> nothing",
      "// eof -> nothing",
    ]);
  });

  test("a block comment spanning lines leads by its end line, trails by its start line", () => {
    const doc = parse("u", '{\n  "a": 1, /* starts here\n  ends here */\n  "b": 2\n}');
    expect(attachments(doc)).toEqual(['/* starts here\n  ends here */ -> "a": 1 (trailing)']);
    const leading = parse("u", '{\n  /* one\n  two */\n  "b": 2\n}');
    expect(attachments(leading)).toEqual(['/* one\n  two */ -> "b": 2 (leading)']);
  });

  test("block and line comments are told apart", () => {
    expect(parse("u", "// a\n/* b */ {}").comments.map((c) => c.block)).toEqual([false, true]);
  });
});

describe("leading block", () => {
  const leading = (text: string) => {
    const doc = parse("u", text);
    return doc.leadingComments.map((c) => doc.text.slice(c.range.start, c.range.end));
  };

  test("comments before the first property, above or inside the brace", () => {
    expect(leading('// a\n{\n  // b\n  "x": 1, // not this\n}')).toEqual(["// a", "// b"]);
  });

  test("ends at the first blank line", () => {
    expect(leading('// a\n// b\n\n// c\n{"x": 1}')).toEqual(["// a", "// b"]);
  });

  test("an empty object or a document with no value keeps all its comments", () => {
    expect(leading("// a\n{}")).toEqual(["// a"]);
    expect(leading("// a")).toEqual(["// a"]);
  });
});
