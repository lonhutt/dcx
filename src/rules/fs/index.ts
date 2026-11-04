import type { Rule } from "../rule";
import {
  composeFileNotFound,
  contextNotFound,
  dockerfileNotFound,
  localFeatureNotFound,
  pathEscapesWorkspace,
} from "./rules";

export const fsRules: Rule[] = [
  dockerfileNotFound,
  contextNotFound,
  composeFileNotFound,
  localFeatureNotFound,
  pathEscapesWorkspace,
];
