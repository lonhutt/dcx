#!/bin/sh
# Runs the dcx release binary for this machine, downloading and verifying it on first use.
# Used by action.yml and the pre-commit hook, so neither needs Bun.
#
#   DCX_VERSION       the version to run; defaults to the one in this checkout's package.json
#   DCX_RELEASE_BASE  where releases live; for tests
set -eu

fail() {
  echo "dcx.sh: $*" >&2
  exit 2
}

here=$(cd "$(dirname "$0")" && pwd)
version=${DCX_VERSION:-}
[ -n "$version" ] || version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$here/../package.json")
[ -n "$version" ] || fail "no version in $here/../package.json"

ext=
case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ext=.exe ;;
  *) os=$(uname -s | tr '[:upper:]' '[:lower:]') ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) arch=$(uname -m) ;;
esac
case $os-$arch in
  linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 | windows-x64 | windows-arm64) ;;
  *) fail "no dcx binary for $os-$arch" ;;
esac
# NOTE: only Alpine gets the musl build; other musl distros get glibc and won't start.
[ "$os" = linux ] && [ -f /etc/alpine-release ] && arch=$arch-musl

asset=dcx-$os-$arch$ext
dir=${XDG_CACHE_HOME:-$HOME/.cache}/dcx/bin/$version
bin=$dir/$asset

if [ ! -x "$bin" ]; then
  url=${DCX_RELEASE_BASE:-https://github.com/lonhutt/dcx/releases/download}/v$version
  mkdir -p "$dir"
  tmp=$(mktemp -d "$dir/.download.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$url/$asset" -o "$tmp/$asset" || fail "couldn't download $url/$asset"
  curl -fsSL "$url/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "couldn't download $url/SHA256SUMS"
  grep "  $asset\$" "$tmp/SHA256SUMS" > "$tmp/want" || fail "$asset isn't in v$version's SHA256SUMS"
  if command -v sha256sum > /dev/null; then
    (cd "$tmp" && sha256sum -c --status want) || fail "checksum mismatch for $asset"
  else
    (cd "$tmp" && shasum -a 256 -c -s want) || fail "checksum mismatch for $asset"
  fi
  chmod +x "$tmp/$asset"
  # mv within one directory is atomic, so a killed download never leaves a bad binary cached
  mv "$tmp/$asset" "$bin"
  rm -rf "$tmp"
  trap - EXIT
fi

exec "$bin" "$@"
