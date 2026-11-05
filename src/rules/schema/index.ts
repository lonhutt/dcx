import type { Rule } from "../rule";
import { invalidEnumValue, missingRequired, typeMismatch, unknownProperty } from "./rules";

export const schemaRules: Rule[] = [
  unknownProperty,
  typeMismatch,
  invalidEnumValue,
  missingRequired,
];
