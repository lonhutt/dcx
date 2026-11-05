import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTests } from "@vscode/test-electron";

// The extension running in a real VS Code: activation, the language client, IPC to the
// bundled server, and restarting it. Downloads VS Code into .vscode-test on first run.
const extensionDir = join(import.meta.dir, "..");
const build = Bun.spawnSync([process.execPath, "run", "build"], {
  cwd: extensionDir,
  stdio: ["ignore", "inherit", "inherit"],
});
if (build.exitCode) process.exit(build.exitCode);
const suite = await Bun.build({
  entrypoints: [join(import.meta.dir, "suite.ts")],
  target: "node",
  format: "cjs",
  external: ["vscode"],
});
if (!suite.success) throw new AggregateError(suite.logs, "couldn't build the e2e suite");
const suitePath = join(extensionDir, "dist", "e2e.js");
await Bun.write(suitePath, suite.outputs[0]!);

const workspace = mkdtempSync(join(tmpdir(), "dcx-e2e-"));
mkdirSync(join(workspace, ".devcontainer"));
writeFileSync(
  join(workspace, ".devcontainer", "devcontainer.json"),
  '{\n  "name": "x",\n  "image": "node:22",\n  "nmae": "y",\n  "extensions": ["a.b"]\n}\n',
);

try {
  process.exitCode = await runTests({
    // the oldest VS Code package.json's engines field claims to support
    version: "1.90.0",
    extensionDevelopmentPath: extensionDir,
    extensionTestsPath: suitePath,
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust"],
  });
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
