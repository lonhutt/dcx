import { expect, test } from "bun:test";
import { parseFeatureRef } from "../features/ref";
import { canonical, identity, isPinned, parseOci } from "./ref";

const D = "sha256:" + "a".repeat(64);

test.each<[string, ReturnType<typeof parseOci>]>([
  ["alpine", { repository: "alpine" }],
  ["library/alpine:3.19", { repository: "library/alpine", tag: "3.19" }],
  [
    "docker.io/library/alpine:3.19",
    { registry: "docker.io", repository: "library/alpine", tag: "3.19" },
  ],
  [
    "ghcr.io/devcontainers/features/go:1",
    { registry: "ghcr.io", repository: "devcontainers/features/go", tag: "1" },
  ],
  ["localhost:5000/ns/f", { registry: "localhost:5000", repository: "ns/f" }],
  // the trap: a port and a tag, both behind a colon
  ["localhost:5000/foo/bar:tag", { registry: "localhost:5000", repository: "foo/bar", tag: "tag" }],
  [
    `localhost:5000/foo/bar:tag@${D}`,
    { registry: "localhost:5000", repository: "foo/bar", tag: "tag", digest: D },
  ],
  [`alpine@${D}`, { repository: "alpine", digest: D }],
  ["Alpine", undefined],
  ["ghcr.io/a b/c", undefined],
  ["alpine:", undefined],
  ["alpine@sha256:xyz", undefined],
  ["", undefined],
])("parseOci(%s)", (s, want) => {
  expect(parseOci(s)).toEqual(want);
});

test("pinned means a digest or a tag that isn't latest", () => {
  expect(["alpine", "alpine:latest"].map((s) => isPinned(parseOci(s)!))).toEqual([false, false]);
  expect(["alpine:3", `alpine@${D}`].map((s) => isPinned(parseOci(s)!))).toEqual([true, true]);
});

test("identity ignores the tag and case; canonical is stable", () => {
  expect(identity(parseOci("GHCR.io/a/b:1")!)).toBe(identity(parseOci("ghcr.io/a/b")!));
  expect(canonical(parseOci("ghcr.io/a/b")!)).toBe(canonical(parseOci("ghcr.io/a/b")!));
  expect(canonical(parseOci("ghcr.io/a/b")!)).toBe("ghcr.io/a/b:latest");
});

test.each<[string, string | undefined]>([
  ["ghcr.io/devcontainers/features/go:1", "oci"],
  [`localhost:5000/ns/f@${D}`, "oci"],
  ["https://example.com/features/f.tgz", "tarball"],
  ["./local-feature", "local"],
  ["../shared/feature", "local"],
  ["docker-in-docker", undefined],
  ["ghcr.io/go", undefined],
  ["http://example.com/f.tgz", undefined],
])("parseFeatureRef(%s) is %s", (s, kind) => {
  expect(parseFeatureRef(s)?.kind).toBe(kind as never);
});
