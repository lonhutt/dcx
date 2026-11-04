import type { Rule } from "../rule";
import {
  extensionDeprecated,
  extensionNotAllowed,
  extensionNotFound,
  extensionNotPortable,
  extensionVersionNotAllowed,
  ineffectiveApplicationSetting,
  invalidExtensionId,
} from "./rules";

export const vscodeRules: Rule[] = [
  invalidExtensionId,
  extensionNotAllowed,
  extensionVersionNotAllowed,
  extensionNotFound,
  extensionNotPortable,
  extensionDeprecated,
  ineffectiveApplicationSetting,
];
