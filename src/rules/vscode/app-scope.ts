/**
 * Settings VS Code registers with application scope, which it ignores anywhere but user
 * settings, including `customizations.vscode.settings`. A trailing `.` marks a prefix.
 *
 * Partial, and data that drifts: from VS Code's configuration registrations, read
 * 2026-11-04. Keep it sorted.
 */
export const APPLICATION_SCOPED: readonly string[] = [
  "extensions.allowed",
  "extensions.autoCheckUpdates",
  "extensions.autoUpdate",
  "extensions.gallery.",
  "security.workspace.trust.",
  "telemetry.telemetryLevel",
  "update.enableWindowsBackgroundUpdates",
  "update.mode",
  "update.showReleaseNotes",
  "window.nativeFullScreen",
  "window.nativeTabs",
  "window.newWindowDimensions",
  "window.restoreWindows",
  "window.titleBarStyle",
];

export function isApplicationScoped(key: string): boolean {
  return APPLICATION_SCOPED.some((s) => (s.endsWith(".") ? key.startsWith(s) : key === s));
}
