import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { MemFS } from "../vfs/memfs";
import { DEFAULTS, type Config } from "./config";
import { discoverConfig, userConfigPath } from "./discover";
import { ConfigError, parseConfig } from "./load";
import { fromEnv, merge } from "./merge";

const W = resolve("/w");

/** The ConfigError `fn` throws, as `spanned source text: message`. */
function errorOf(text: string, fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return err.diagnostics.map((d) => `${text.slice(d.range.start, d.range.end)}: ${d.message}`);
  }
  throw new Error("didn't throw");
}

describe("loading", () => {
  test("a full config maps onto the Config type", () => {
    const config = parseConfig(
      join(W, ".dcx.yaml"),
      `version: 1
fail-on: warning
online: true
rules:
  security/privileged: error
categories:
  style: off
exclude: ["examples/**"]
features:
  allow-unpinned: ["ghcr.io/devcontainers/features/common-utils"]
  cache-ttl: 2h
extension-sources:
  - id: corp-policy
    kind: policy
    path: policy.json
    required: true
extensions:
  satisfy: any
`,
      "project",
    );
    expect(config).toMatchObject({
      failOn: "warning",
      online: true,
      rules: { "security/privileged": "error" },
      categories: { style: "off" },
      exclude: ["examples/**"],
      allowUnpinned: ["ghcr.io/devcontainers/features/common-utils"],
      cacheTtl: 2 * 3_600_000,
      extensionSources: [
        { id: "corp-policy", kind: "policy", path: join(W, "policy.json"), required: true },
      ],
      satisfy: "any",
      base: W,
    });
  });

  test("the same config as YAML and as JSON produces identical objects", () => {
    const yaml = parseConfig(
      join(W, ".dcx.yaml"),
      "online: false\nrules:\n  style/missing-name: off\n",
      "project",
    );
    const json = parseConfig(
      join(W, ".dcx.json"),
      '{"online": false, "rules": {"style/missing-name": "off"}}',
      "project",
    );
    expect(yaml).toEqual(json);
  });

  test("a file of only comments is an empty config, not an error", () => {
    expect(parseConfig(join(W, ".dcx.yaml"), "# nothing yet\n", "project")).toEqual({
      base: W,
    } as Config);
  });

  test.each<[string, string, string[]]>([
    ["an unknown setting", "onlne: true\n", ['onlne: The config has unknown setting "onlne"']],
    [
      "a bad severity",
      "rules:\n  style/missing-name: loud\n",
      ['loud: "rules.style/missing-name" must be one of "error", "warning", "info", "off"'],
    ],
    [
      "a malformed rule ID",
      "rules:\n  Style: off\n",
      ['Style: "rules" has an invalid key "Style"'],
    ],
    ["a wrong type", "online: yes please\n", ['yes please: "online" must be a boolean']],
  ])("%s produces a diagnostic with a span, not a thrown TypeError", (_, text, want) => {
    expect(errorOf(text, () => parseConfig(join(W, ".dcx.yaml"), text, "project"))).toEqual(want);
  });

  test("malformed YAML is a ConfigError too", () => {
    const text = "rules: [unclosed\n";
    expect(() => parseConfig(join(W, ".dcx.yaml"), text, "project")).toThrow(ConfigError);
  });
});

describe("credentials", () => {
  const source = (env: string) =>
    `extension-sources:\n  - id: g\n    kind: vscode-gallery\n    token-env: ${env}\n`;

  test("token-env naming a variable is accepted", () => {
    expect(
      parseConfig(join(W, ".dcx.yaml"), source("GITHUB_TOKEN"), "project").extensionSources?.[0]
        ?.tokenEnv,
    ).toBe("GITHUB_TOKEN");
  });

  test.each(["ghp_abc123", "github_pat_11ABC", "glpat-xyz", "not an identifier"])(
    "token-env: %s is refused",
    (value) => {
      const text = source(value);
      const [line] = errorOf(text, () => parseConfig(join(W, ".dcx.yaml"), text, "project"));
      const message = line!.slice(value.length + 2);
      expect(line).toStartWith(`${value}: "token-env" must name an environment variable`);
      // the message shouldn't repeat the credential back into a CI log
      expect(message).not.toContain(value.slice(5));
    },
  );
});

describe("ownership", () => {
  test("a user config can't set required, with a message naming the field", () => {
    const text = "extension-sources:\n  - id: openvsx\n    kind: openvsx\n    required: false\n";
    expect(
      errorOf(text, () => parseConfig("/home/u/.config/dcx/config.yaml", text, "user")),
    ).toEqual(['false: "required" can only be set in the project config']);
  });

  test("a user config can't set satisfy", () => {
    const text = "extensions:\n  satisfy: any\n";
    expect(errorOf(text, () => parseConfig("/u/config.yaml", text, "user"))).toEqual([
      'any: "extensions.satisfy" can only be set in the project config',
    ]);
  });

  test("a user config can add sources; a project's required survives a user redefinition", () => {
    const user = parseConfig(
      "/u/config.yaml",
      "extension-sources:\n  - {id: openvsx, kind: openvsx, url: https://mirror}\n  - {id: mine, kind: openvsx}\n",
      "user",
    );
    const project = parseConfig(
      join(W, ".dcx.yaml"),
      "extension-sources:\n  - {id: openvsx, kind: openvsx, required: true}\n",
      "project",
    );
    const sources = merge(merge(DEFAULTS, user), project).extensionSources!;
    expect(sources.map((s) => [s.id, s.required])).toEqual([
      ["openvsx", true],
      ["mine", undefined],
    ]);
  });
});

describe("precedence: defaults → user → project → env → flags", () => {
  const layers: [string, Config][] = [
    ["default", DEFAULTS],
    ["user", { failOn: "info" }],
    ["project", { failOn: "warning" }],
    ["env", { failOn: "error" }],
    ["flags", { failOn: "info" }],
  ];
  test.each(layers.slice(1).map((l, i) => [layers[i]![0], l[0], i + 1] as const))(
    "%s is overridden by %s",
    (_, __, upTo) => {
      const merged = layers.slice(0, upTo + 1).reduce((acc, [, c]) => merge(acc, c), {} as Config);
      expect(merged.failOn).toBe(layers[upTo]![1].failOn!);
    },
  );

  test("false from a higher layer beats true from a lower one", () => {
    expect(merge({ online: true }, { online: false }).online).toBe(false);
    expect(merge({ online: true }, {}).online).toBe(true);
  });

  test("rule maps merge key by key", () => {
    expect(
      merge({ rules: { "a/b": "off", "c/d": "info" } }, { rules: { "a/b": "error" } }).rules,
    ).toEqual({
      "a/b": "error",
      "c/d": "info",
    });
  });

  test("the environment layer reads DCX_ONLINE and DCX_FAIL_ON", () => {
    expect(fromEnv({ DCX_ONLINE: "1", DCX_FAIL_ON: "warning" })).toEqual({
      online: true,
      failOn: "warning",
    });
    expect(fromEnv({ DCX_ONLINE: "false" })).toEqual({ online: false });
    expect(fromEnv({})).toEqual({});
  });
});

describe("discovery", () => {
  test("walks upward and takes the first config found", async () => {
    const fs = new MemFS({
      "/r/.git/HEAD": "",
      "/r/.dcx.yaml": "",
      "/r/a/b/devcontainer.json": "",
    });
    expect(await discoverConfig(fs, resolve("/r/a/b"))).toBe(join(resolve("/r"), ".dcx.yaml"));
  });

  test("stops at the repository root", async () => {
    const fs = new MemFS({ "/.dcx.yaml": "", "/r/.git/HEAD": "", "/r/a/devcontainer.json": "" });
    expect(await discoverConfig(fs, resolve("/r/a"))).toBeUndefined();
  });

  test("the user config lives under XDG_CONFIG_HOME, falling back to ~/.config", () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe(join("/x", "dcx", "config.yaml"));
    expect(userConfigPath({}, "/h")).toBe(join("/h", ".config", "dcx", "config.yaml"));
  });
});
