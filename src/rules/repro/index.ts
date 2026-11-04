import type { Rule } from "../rule";
import { imageNoDigest, mutableBuildArg, unpinnedImage } from "./rules";

export const reproRules: Rule[] = [unpinnedImage, imageNoDigest, mutableBuildArg];
