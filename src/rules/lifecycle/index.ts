import type { Rule } from "../rule";
import {
  emptyCommand,
  initializeRunsOnHost,
  parallelNonStringValue,
  shellSyntaxInArrayForm,
} from "./rules";

export const lifecycleRules: Rule[] = [
  shellSyntaxInArrayForm,
  parallelNonStringValue,
  initializeRunsOnHost,
  emptyCommand,
];
