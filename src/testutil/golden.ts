import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** True under `UPDATE=1 bun test`, which rewrites golden files instead of comparing. */
export const updating = process.env.UPDATE === "1";

/**
 * Compares `actual` to the golden file at `path`, or (re)writes it under `UPDATE=1`.
 * Strings are compared as-is; anything else as two-space JSON with a trailing newline.
 */
export function expectGolden(path: string, actual: unknown): void {
  const text = typeof actual === "string" ? actual : JSON.stringify(actual, null, 2) + "\n";
  if (updating || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    // a missing golden outside UPDATE is a failure, or a typo'd path passes forever
    expect(updating, `wrote missing golden file ${path}; rerun to compare`).toBe(true);
    return;
  }
  expect(text).toBe(readFileSync(path, "utf8"));
}
