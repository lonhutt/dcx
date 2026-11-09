import { expect, test } from "bun:test";
import { assetName, sha256sums, TARGETS } from "./release";

test("asset names", () => {
  expect(assetName("bun-linux-x64")).toBe("dcx-linux-x64");
  expect(assetName("bun-linux-arm64-musl")).toBe("dcx-linux-arm64-musl");
  expect(assetName("bun-darwin-arm64")).toBe("dcx-darwin-arm64");
  expect(assetName("bun-windows-x64")).toBe("dcx-windows-x64.exe");
});

test("every target gets a distinct asset", () => {
  expect(new Set(TARGETS.map(assetName)).size).toBe(TARGETS.length);
});

test("SHA256SUMS matches sha256sum's format, sorted by name", () => {
  const out = sha256sums([
    { name: "b", bytes: new TextEncoder().encode("b") },
    { name: "a", bytes: new TextEncoder().encode("a") },
  ]);
  expect(out).toBe(
    "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a\n" +
      "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b\n",
  );
});
