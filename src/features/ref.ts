import { parseOci, type OciRef } from "../model/ref";

/** A `features` key: an OCI reference, an HTTPS tarball, or a path relative to the config. */
export type FeatureRef =
  | ({ readonly kind: "oci" } & OciRef)
  | { readonly kind: "tarball"; readonly url: string }
  | { readonly kind: "local"; readonly path: string };

/**
 * Undefined for anything that's none of the three forms, including the bare legacy IDs
 * (`"docker-in-docker"`) from before features were published to registries.
 */
export function parseFeatureRef(s: string): FeatureRef | undefined {
  if (s.startsWith("./") || s.startsWith("../")) return { kind: "local", path: s };
  if (/^https:\/\/[^\s/]+\/\S+\.tgz$/i.test(s)) return { kind: "tarball", url: s };
  const oci = parseOci(s);
  // registry/namespace/name at least; a bare name isn't something the CLI can fetch
  if (!oci?.registry || !oci.repository.includes("/")) return undefined;
  return { kind: "oci", ...oci };
}
