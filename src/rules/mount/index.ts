import type { Rule } from "../rule";
import { absoluteHostPath, duplicateTarget, invalidStringSyntax, missingTarget } from "./rules";

export const mountRules: Rule[] = [
  invalidStringSyntax,
  missingTarget,
  duplicateTarget,
  absoluteHostPath,
];
