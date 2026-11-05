import type { Rule } from "../rule";
import {
  deprecated,
  duplicate,
  invalidOptionValue,
  invalidReference,
  missingDependency,
  overrideOrderUnknown,
  unknownOption,
  unpinnedVersion,
} from "./rules";

export const featureRules: Rule[] = [
  invalidReference,
  unpinnedVersion,
  duplicate,
  overrideOrderUnknown,
  unknownOption,
  invalidOptionValue,
  deprecated,
  missingDependency,
];
