import { elements, isString, members, type Field } from "../../model/model";
import { identity } from "../../model/ref";
import { parseFeatureRef, type FeatureRef } from "../../features/ref";
import type { Pass } from "../rule";

export interface FeatureEntry {
  readonly key: string;
  /** The key's node, as a field; where findings about the reference point. */
  readonly field: Field<unknown>;
  /** The options object (or the legacy version string) the key maps to. */
  readonly options: Field<unknown>;
  readonly ref: FeatureRef | undefined;
}

/** Every `features` entry, in source order, duplicate keys included. */
export function featureEntries(pass: Pass): FeatureEntry[] {
  const features = pass.model.object("features");
  if (!features) return [];
  return members(features.node).map(({ name, field }) => ({
    key: name,
    field: { value: name, node: field.key!, key: field.key },
    options: field,
    ref: parseFeatureRef(name),
  }));
}

/** What makes two references the same feature, whatever version each asks for. */
export function featureIdentity(entry: Pick<FeatureEntry, "key" | "ref">): string {
  const ref = entry.ref;
  if (ref?.kind === "oci") return identity(ref);
  if (ref?.kind === "tarball") return ref.url.toLowerCase();
  return entry.key.replace(/\/+$/, "").toLowerCase();
}

/** `overrideFeatureInstallOrder`'s string entries. */
export function installOrder(pass: Pass): Field<string>[] {
  const order = pass.model.array("overrideFeatureInstallOrder");
  return order ? elements(order.node).filter(isString) : [];
}

/** A bare pre-registry short ID like "docker-in-docker", which the CLI maps to a published feature. */
export const isLegacyId = (key: string): boolean => /^[a-z0-9-]+$/.test(key);
