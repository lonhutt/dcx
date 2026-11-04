import type { Rule } from "../rule";
import {
  appPort,
  rootExtensions,
  legacyFeatureId,
  rootSettings,
  topLevelDockerfile,
} from "./rules";

export const deprecationRules: Rule[] = [
  topLevelDockerfile,
  appPort,
  rootExtensions,
  rootSettings,
  legacyFeatureId,
];
