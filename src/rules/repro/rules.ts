import { rangeOf } from "../../jsonc/jsonc";
import { members } from "../../model/model";
import { isPinned, parseOci } from "../../model/ref";
import type { Pass } from "../rule";
import { REFERENCE, rule } from "../util";

const DOCS = `${REFERENCE}#image-specific`;

/** `image`, parsed; nothing for a value with a `${...}` in it, which isn't known yet. */
function image(pass: Pass) {
  const f = pass.model.string("image");
  if (!f || f.value.includes("${")) return undefined;
  const ref = parseOci(f.value.trim());
  return ref && { field: f, ref };
}

export const unpinnedImage = rule({
  id: "repro/unpinned-image",
  description: '"image" has no tag, or uses ":latest"',
  explain: `An image with no tag means ":latest", which is whatever was pushed most
recently. Two people building the same config a week apart can get different base
images, and a rebuild can break with nothing in the repo having changed.

    "image": "mcr.microsoft.com/devcontainers/typescript-node"        // latest
    "image": "mcr.microsoft.com/devcontainers/typescript-node:1-22"   // pinned

A version tag is usually enough; repro/image-no-digest (off by default) asks for a
digest too.`,
  defaultSeverity: "warning",
  check(pass) {
    const i = image(pass);
    if (!i || isPinned(i.ref)) return;
    pass.report({
      range: rangeOf(i.field.node),
      message: i.ref.tag
        ? `Image "${i.field.value}" uses ":latest", which moves`
        : `Image "${i.field.value}" has no tag, so it means ":latest"`,
      help: "pin a version tag",
      docsUrl: DOCS,
    });
  },
});

export const imageNoDigest = rule({
  id: "repro/image-no-digest",
  description: 'Require "@sha256:" digest pinning for "image"',
  explain: `A tag can be re-pushed; a digest can't. Pinning "image" by digest means every
build uses exactly the same bytes, which some teams require for supply-chain reasons.

    "image": "node:22@sha256:<64 hex digits>"

Off by default: digests have to be bumped by hand (or by a bot), and most teams find a
version tag enough.`,
  defaultSeverity: "off",
  check(pass) {
    const i = image(pass);
    if (!i || i.ref.digest) return;
    pass.report({
      range: rangeOf(i.field.node),
      message: `Image "${i.field.value}" isn't pinned by digest`,
      help: 'append "@sha256:..." with the digest of the image you tested',
      docsUrl: DOCS,
    });
  },
});

export const mutableBuildArg = rule({
  id: "repro/mutable-build-arg",
  description: '"build.args" value interpolates a host env var',
  explain: `A build arg taken from the host's environment builds differently on each
machine: whatever that variable holds there, or nothing. Sometimes that's the point
(a proxy setting, a user ID); often it's an accident that makes images differ.

    "build": { "args": { "NODE_VERSION": "${"$"}{localEnv:NODE_VERSION}" } }   // differs per machine
    "build": { "args": { "NODE_VERSION": "22" } }`,
  defaultSeverity: "info",
  check(pass) {
    const args = pass.model.build?.args;
    if (!args) return;
    for (const { name, field } of members(args.node)) {
      if (typeof field.value !== "string" || !field.value.includes("${localEnv:")) continue;
      pass.report({
        range: rangeOf(field.node),
        message: `Build arg "${name}" comes from the host environment, so it can differ per machine`,
        help: "use a fixed value, unless differing per machine is the point",
        docsUrl: DOCS,
      });
    }
  },
});
