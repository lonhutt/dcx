import { LIFECYCLE } from "../model/lifecycle";
import { definitionKeys } from "./generated/devContainer.scenarios.validator.js";

export const REFERENCE = "https://containers.dev/implementors/json_reference/";

const LIFECYCLE_DOCS = new Set<string>([...LIFECYCLE, "waitFor"]);
const COMPOSE = new Set(
  definitionKeys.compose.filter((k) => !definitionKeys.nonCompose.includes(k)),
);
const IMAGE = new Set([
  ...definitionKeys.nonCompose,
  ...definitionKeys.image,
  ...definitionKeys.dockerfile,
]);

/**
 * The containers.dev reference section for a property path. The reference has an anchor
 * per section, not per property, so this links the section the property is listed in.
 */
export function docsUrl(path: readonly string[]): string {
  const [top] = path;
  if (top === undefined) return REFERENCE;
  if (LIFECYCLE_DOCS.has(top)) return `${REFERENCE}#lifecycle-scripts`;
  if (top === "portsAttributes" || top === "otherPortsAttributes")
    return `${REFERENCE}#port-attributes`;
  if (top === "hostRequirements") return `${REFERENCE}#min-host-reqs`;
  if (COMPOSE.has(top)) return `${REFERENCE}#compose-specific`;
  if (IMAGE.has(top)) return `${REFERENCE}#image-specific`;
  return `${REFERENCE}#general-properties`;
}
