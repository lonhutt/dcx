import type { Rule } from "../rule";
import {
  composeMissingService,
  composeMissingWorkspaceFolder,
  composeServiceNotFound,
  conflictingSource,
  noContainerSource,
  nonComposeProperty,
  shutdownActionMismatch,
} from "./rules";

export const scenarioRules: Rule[] = [
  noContainerSource,
  conflictingSource,
  composeMissingService,
  composeMissingWorkspaceFolder,
  composeServiceNotFound,
  nonComposeProperty,
  shutdownActionMismatch,
];
