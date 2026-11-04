import { elements, isObject, isString, type Field } from "../../model/model";
import { objectMount, parseMount, type MountProblem, type MountSpec } from "../../model/mount";
import type { Pass } from "../rule";

export interface MountEntry {
  readonly field: Field<unknown>;
  readonly mount: MountSpec;
  readonly problems: readonly MountProblem[];
  /** `mounts`, or `workspaceMount`. */
  readonly property: string;
}

/** Every mount the config declares, both properties, both forms. */
export function mountEntries(pass: Pass): MountEntry[] {
  const out: MountEntry[] = [];
  const mounts = pass.model.array("mounts");
  for (const field of mounts ? elements(mounts.node) : []) {
    if (isString(field)) out.push({ field, ...parseMount(field.value), property: "mounts" });
    else if (isObject(field))
      out.push({ field, mount: objectMount(field.value), problems: [], property: "mounts" });
  }
  const workspace = pass.model.string("workspaceMount");
  // an empty workspaceMount means "don't mount the workspace"
  if (workspace && workspace.value.trim())
    out.push({ field: workspace, ...parseMount(workspace.value), property: "workspaceMount" });
  return out;
}

/** Contains a `${...}` substitution; its value is only known when the container's created. */
export const substituted = (s: string) => s.includes("${");
