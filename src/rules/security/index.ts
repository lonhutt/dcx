import type { Rule } from "../rule";
import {
  capAddSysAdmin,
  dockerSocketMount,
  hardcodedSecret,
  privileged,
  privilegedRunArgs,
  seccompUnconfined,
} from "./rules";

export const securityRules: Rule[] = [
  privileged,
  dockerSocketMount,
  capAddSysAdmin,
  seccompUnconfined,
  privilegedRunArgs,
  hardcodedSecret,
];
