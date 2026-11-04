import * as vscode from "vscode";

/** The extension's settings, as `dcx.*` in settings.json. */
export interface DcxConfig {
  readonly enable: boolean;
  /** A local dcx checkout to load the analyser from; for working on dcx itself. */
  readonly path: string;
  readonly run: "onSave" | "onType";
  readonly online: boolean;
  /** An explicit `.dcx.yaml`, absolute or relative to the workspace folder. */
  readonly configPath: string;
  /** For the language server; nothing reads it until the extension uses one. */
  readonly trace: "off" | "messages" | "verbose";
}

/** Settings that only apply after a reload; changing one says so instead of half-applying. */
export const NEEDS_RELOAD: readonly (keyof DcxConfig)[] = ["path"];

export function readConfig(scope?: vscode.ConfigurationScope): DcxConfig {
  const c = vscode.workspace.getConfiguration("dcx", scope);
  return {
    enable: c.get("enable", true),
    path: c.get("path", ""),
    run: c.get<string>("run", "onSave") === "onType" ? "onType" : "onSave",
    online: c.get("online", false),
    configPath: c.get("configPath", ""),
    trace: c.get("trace.server", "off"),
  };
}
