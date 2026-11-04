/** Bad flags or arguments; exit 2, with the help text. */
export class UsageError extends Error {}

/** dcx couldn't do its job: no config found, an unreadable file, a broken .dcx.yaml. Exit 2. */
export class ToolError extends Error {}
