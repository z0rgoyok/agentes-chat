#!/usr/bin/env bash
# The sherpa-onnx static libraries sherpa-onnx-sys would download for <target>, fetched with retries into <dir>, so
# a passing 5xx from GitHub doesn't fail the build. Prints the SHERPA_ONNX_ARCHIVE_DIR line for $GITHUB_ENV.
set -euo pipefail
target=$1 dir=$2
version=$(grep -A1 'name = "sherpa-onnx-sys"' "$(dirname "$0")/Cargo.lock" | sed -n 's/^version = "\(.*\)"/\1/p')
case $target in
  x86_64-unknown-linux-gnu) name=linux-x64-static-lib ;;
  aarch64-unknown-linux-gnu) name=linux-aarch64-static-lib ;;
  x86_64-apple-darwin) name=osx-x64-static-lib ;;
  aarch64-apple-darwin) name=osx-arm64-static-lib ;;
  x86_64-pc-windows-msvc) name=win-x64-static-MT-Release-lib ;;
  *) echo "no sherpa-onnx build for $target" >&2; exit 1 ;;
esac
archive="sherpa-onnx-v$version-$name.tar.bz2"
mkdir -p "$dir"
curl -fsSL --retry 8 --retry-all-errors --retry-delay 10 -o "$dir/$archive" \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$version/$archive" >&2
echo "SHERPA_ONNX_ARCHIVE_DIR=$dir"
