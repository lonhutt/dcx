import type { Rule } from "../rule";
import {
  buildArgNotDeclared,
  invalidSubstitution,
  localEnvNoDefault,
  remoteUserNotContainerUser,
  substitutionScope,
  updateRemoteUserUidNoop,
  waitForUnreachable,
  workspaceMountWithoutFolder,
} from "./rules";

export const semanticRules: Rule[] = [
  workspaceMountWithoutFolder,
  waitForUnreachable,
  invalidSubstitution,
  substitutionScope,
  localEnvNoDefault,
  remoteUserNotContainerUser,
  updateRemoteUserUidNoop,
  buildArgNotDeclared,
];
