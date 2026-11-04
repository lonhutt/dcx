import { expect, test } from "bun:test";
import { parseRunArgs } from "./run-args";
import { entropy, looksLikeSecret } from "./secrets";

test("both flag syntaxes parse the same", () => {
  const a = parseRunArgs(["--cap-add=SYS_ADMIN"]);
  const b = parseRunArgs(["--cap-add", "SYS_ADMIN"]);
  expect(a.map((r) => [r.flag, r.value])).toEqual(b.map((r) => [r.flag, r.value]));
  expect(parseRunArgs(["--privileged", "--init"]).map((r) => r.flag)).toEqual([
    "--privileged",
    "--init",
  ]);
});

// fake credentials of the right shape, built at runtime so no scanner trips over this file
const fake = {
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  github: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  slack: "xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKl",
  generic: "Zq8Rk2Lm9Xw4Vt7Pb3Nc6Hy1Js5Gd0FaQe8Ur2Wo",
};

test.each(Object.entries(fake))("a planted %s is caught", (_, value) => {
  expect(looksLikeSecret("X", value)).toBeDefined();
});

test.each<[string, string]>([
  ["GITHUB_TOKEN", "${localEnv:GITHUB_TOKEN}"],
  ["PASSWORD", "vscode"],
  ["NODE_VERSION", "20.11.1"],
  ["COMMIT", "3f786850e387550fdab836ed7e6dc881de23001b"],
  ["PATH", "/usr/local/bin:/usr/bin:/bin"],
  ["URL", "https://registry.npmjs.org/some/long/path/segment"],
  ["SSH_AUTH_SOCK", "/tmp/ssh-agent.sock"],
  ["JAVA_OPTS", "-Xmx2g -XX:+UseG1GC -Dfile.encoding=UTF-8"],
])("%s=%s is not a secret", (key, value) => {
  expect(looksLikeSecret(key, value)).toBeUndefined();
});

test.each<[string, number, number]>([
  ["aaaaaaaa", 0, 0.01],
  ["abcdabcd", 2, 2.01],
  ["Zq8Rk2Lm9Xw4Vt7Pb3Nc6Hy1Js5Gd0FaQe8Ur2Wo", 4.2, 5.5],
  ["3f786850e387550fdab836ed7e6dc881de23001b", 3.5, 4.0],
])("entropy(%s) is in [%d, %d)", (s, lo, hi) => {
  expect(entropy(s)).toBeGreaterThanOrEqual(lo);
  expect(entropy(s)).toBeLessThan(hi);
});
