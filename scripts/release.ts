#!/usr/bin/env bun
/** Builds a standalone dcx for every platform, plus SHA256SUMS, into dist/release: `bun scripts/release.ts`. */
import { $ } from "bun";
import { join } from "node:path";

export const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
  "bun-windows-arm64",
] as const;

/** `bun-windows-x64` → `dcx-windows-x64.exe`. */
export function assetName(target: string): string {
  const name = target.replace(/^bun-/, "dcx-");
  return target.startsWith("bun-windows-") ? `${name}.exe` : name;
}

/** The same lines `sha256sum` prints, so `sha256sum -c` can check them. */
export function sha256sums(files: { name: string; bytes: Uint8Array }[]): string {
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((f) => `${new Bun.CryptoHasher("sha256").update(f.bytes).digest("hex")}  ${f.name}\n`)
    .join("");
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const out = join(root, "dist", "release");
  const commit = (await $`git rev-parse --short HEAD`.cwd(root).nothrow().text()).trim() || "dev";
  const date = new Date().toISOString().slice(0, 10);
  await $`rm -rf ${out}`;

  // one at a time: each target downloads its own Bun runtime first
  const files = [];
  for (const target of TARGETS) {
    const outfile = join(out, assetName(target));
    await $`bun build ./index.ts --compile --minify --sourcemap --bytecode --target=${target} --define DCX_COMMIT=${`'${commit}'`} --define DCX_BUILD_DATE=${`'${date}'`} --outfile ${outfile}`.cwd(
      root,
    );
    // --compile embeds the sourcemap; the loose .map would just end up in the release
    await $`rm -f ${outfile}.map`;
    files.push({ name: assetName(target), bytes: await Bun.file(outfile).bytes() });
  }
  await Bun.write(join(out, "SHA256SUMS"), sha256sums(files));
}
