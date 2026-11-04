import type { Rule } from "../rule";
import {
  attributesOrphan,
  duplicateForward,
  invalidAttributeKey,
  outOfRange,
  privilegedWithoutElevate,
} from "./rules";

export const portRules: Rule[] = [
  outOfRange,
  duplicateForward,
  invalidAttributeKey,
  attributesOrphan,
  privilegedWithoutElevate,
];
