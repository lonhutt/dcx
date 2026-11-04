/**
 * OCI references, `[registry/]repository[:tag][@digest]`, after the distribution spec's
 * grammar. Shared by feature references and `image`.
 */
export interface OciRef {
  /** Absent for a Docker Hub shorthand like `alpine` or `library/alpine`. */
  readonly registry?: string;
  readonly repository: string;
  readonly tag?: string;
  readonly digest?: string;
}

const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[A-Fa-f0-9]{32,}$/;
const HOST =
  /^(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?$/;

/**
 * Parses right to left: the digest after the last `@`, then a tag only after a `:` past
 * the last `/`. Left to right, `localhost:5000/ns/f` reads as the tag `5000/ns/f`.
 */
export function parseOci(s: string): OciRef | undefined {
  let rest = s;
  let digest: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return undefined;
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return undefined;
  }
  const parts = rest.split("/");
  // the first part is a registry only if it looks like a host; `library/alpine` has none
  const first = parts[0]!;
  const hasRegistry =
    parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasRegistry && !HOST.test(first)) return undefined;
  const path = hasRegistry ? parts.slice(1) : parts;
  if (!path.length || !path.every((p) => COMPONENT.test(p))) return undefined;
  return {
    ...(hasRegistry && { registry: first }),
    repository: path.join("/"),
    ...(tag !== undefined && { tag }),
    ...(digest !== undefined && { digest }),
  };
}

/** A digest, or a tag other than `latest`. */
export const isPinned = (r: OciRef) => !!r.digest || (r.tag !== undefined && r.tag !== "latest");

/** Registry and repository, lowercased: the same thing whatever its tag. */
export const identity = (r: OciRef) =>
  `${(r.registry ?? "docker.io").toLowerCase()}/${r.repository.toLowerCase()}`;

/** A stable cache key: identity plus the digest, or the tag (`latest` when there's none). */
export const canonical = (r: OciRef) =>
  `${identity(r)}${r.digest ? `@${r.digest}` : `:${r.tag ?? "latest"}`}`;
