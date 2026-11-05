import { type ConfigurationScope, workspace } from "vscode";

/** The extension's settings, as `dcx.*` in settings.json. */
export interface DcxConfig {
  readonly enable: boolean;
  /** A local dcx checkout to run the server from, with bun; for working on dcx itself. */
  readonly path: string;
  readonly run: "onSave" | "onType";
  /** Unset unless the user set it, so .dcx.yaml and DCX_ONLINE still decide. */
  readonly online: boolean | undefined;
  /** An explicit `.dcx.yaml`, absolute or relative to the workspace folder. */
  readonly configPath: string;
}

export function readConfig(scope?: ConfigurationScope): DcxConfig {
  const c = workspace.getConfiguration("dcx", scope);
  return {
    enable: c.get("enable", true),
    path: c.get("path", ""),
    run: c.get<string>("run", "onSave") === "onType" ? "onType" : "onSave",
    online: explicit(c.inspect<boolean>("online")),
    configPath: c.get("configPath", ""),
  };
}

/** The value set at the narrowest scope; the manifest default doesn't count. */
function explicit<T>(
  i: { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined,
) {
  return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
}
