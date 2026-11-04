import type { Rule } from "../rule";
import { duplicateKey } from "./duplicate-key";
import { parseError } from "./parse-error";
import { trailingComma } from "./trailing-comma";

export const syntaxRules: Rule[] = [parseError, duplicateKey, trailingComma];
