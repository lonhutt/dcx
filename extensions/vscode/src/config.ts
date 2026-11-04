import * as vscode from "vscode";

/** The extension's settings, as `dcx.*` in settings.json. */
export interface DcxConfig {
  readonly enable: boolean;
  /** A local dcx checkout to load the analyser from; for working on dcx itself. */
  readonly path: string;
  readonly run: "onSave" | "onType";
  /** Unset unless the user set it, so .dcx.yaml and DCX_ONLINE still decide. */
  readonly online: boolean | undefined;
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
    online: explicit(c.inspect<boolean>("online")),
    configPath: c.get("configPath", ""),
    trace: c.get("trace.server", "off"),
  };
}

/** The value set at the narrowest scope; the manifest default doesn't count. */
function explicit<T>(
  i: { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined,
) {
  return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
}
