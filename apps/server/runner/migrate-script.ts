import { psQuote, RUNNER_BUN_SHA256, RUNNER_BUN_VERSION, RUNNER_BUN_WINDOWS_SHA256, shQuote } from "./install-script";

/** This server's address without the slashes it may end in (a loop: a pattern for it is slow on many slashes). */
function serverOf(publicUrl: string): string {
  let end = publicUrl.length;
  while (end > 0 && publicUrl[end - 1] === "/") end--;
  return publicUrl.slice(0, end);
}

/**
 * `curl -fsSL <publicUrl>/migrate.sh | sh -s -- [--from APP] [--out FOLDER] [--json]` (ADR 0055, addendum
 * 2026-11-16): runs `agentes-runner migrate` once, from a temporary folder, and removes it. Nothing is installed and
 * this computer isn't connected: the runner bundle is the one this server serves (`/runner/agentes-runner.mjs`), run
 * by this computer's Bun or Node.js 22+, else by the Bun the installer pins (`RUNNER_BUN_VERSION`, its download
 * checked against `RUNNER_BUN_SHA256`). Everything runs from `main`, so a download cut short runs nothing. On a
 * terminal the command's questions read the keyboard, not the pipe the script came through.
 */
export function migrateScript(publicUrl: string): string {
  const server = serverOf(publicUrl);
  const shaCases = Object.entries(RUNNER_BUN_SHA256)
    .map(([target, sha]) => `      ${target}) BUN_SHA256=${shQuote(sha)} ;;`)
    .join("\n");
  return `#!/bin/sh
# agentes.chat: reads the agents another app keeps on this computer and writes one .zip for the import screen.
# It only reads, and it sends nothing. Nothing is installed: what it downloads is removed when it ends.
# Usage: curl -fsSL ${server}/migrate.sh | sh -s -- [--from openbot|openmausbot|hermes|openclaw|paperclip] [--out FOLDER] [--json] [--no-files]
set -eu

SERVER=${shQuote(server)}
BUN_VERSION=${shQuote(RUNNER_BUN_VERSION)}
WORK=""

say() { printf '%s\\n' "$*" >&2; }
die() { say "$*"; exit 1; }
cleanup() { if [ -n "$WORK" ]; then rm -rf "$WORK"; fi; }

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --waitretry=2 -O "$2" "$1"
  else
    return 1
  fi
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
}
unpack() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$1" -d "$2"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$1" "$2"
  else
    return 1
  fi
}

# The pinned Bun into $WORK, for a computer with neither Bun nor Node.js 22 or newer.
fetch_bun() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64)
      BUN_TARGET=linux-x64
      grep -qw avx2 /proc/cpuinfo 2>/dev/null || BUN_TARGET=linux-x64-baseline ;;
    Linux-aarch64|Linux-arm64) BUN_TARGET=linux-aarch64 ;;
    Darwin-x86_64) BUN_TARGET=darwin-x64-baseline ;;
    Darwin-arm64) BUN_TARGET=darwin-aarch64 ;;
    *) return 1 ;;
  esac
  case "$BUN_TARGET" in
${shaCases}
  esac
  download "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$BUN_TARGET.zip" "$WORK/bun.zip" || return 1
  [ "$(sha256 "$WORK/bun.zip")" = "$BUN_SHA256" ] || return 1
  unpack "$WORK/bun.zip" "$WORK" || return 1
  chmod 755 "$WORK/bun-$BUN_TARGET/bun" || return 1
  RUNTIME="$WORK/bun-$BUN_TARGET/bun"
}

main() {
  WORK=$(mktemp -d) || die "No temporary folder to work in."
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT TERM

  RUNTIME=""
  if command -v bun >/dev/null 2>&1; then
    RUNTIME=$(command -v bun)
  elif [ -x "$HOME/.bun/bin/bun" ]; then
    RUNTIME="$HOME/.bun/bin/bun"
  elif command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v//; s/\\..*//')
    case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
    if [ "$NODE_MAJOR" -ge 22 ]; then RUNTIME=$(command -v node); fi
  fi
  if [ -z "$RUNTIME" ]; then
    fetch_bun || die "This needs Bun or Node.js 22 or newer, and neither could be had here. Install one (https://bun.sh or https://nodejs.org), then run this again."
  fi

  download "$SERVER/runner/agentes-runner.mjs" "$WORK/agentes-runner.mjs" || die "Couldn't download the command from $SERVER."

  # Node's own SQLite says it is experimental on every start.
  NODE_NO_WARNINGS=1
  export NODE_NO_WARNINGS
  CODE=0
  if [ -t 1 ] && [ -r /dev/tty ]; then
    "$RUNTIME" "$WORK/agentes-runner.mjs" migrate "$@" </dev/tty || CODE=$?
  else
    "$RUNTIME" "$WORK/agentes-runner.mjs" migrate "$@" || CODE=$?
  fi
  exit "$CODE"
}

main "$@"
`;
}

/**
 * The same on Windows: `& ([scriptblock]::Create((irm <publicUrl>/migrate.ps1))) -From APP -Out FOLDER [-Json]`
 * (a script piped to `iex` takes no arguments). This computer's Bun or Node.js 22+, else the pinned Bun, checked
 * against `RUNNER_BUN_WINDOWS_SHA256`, in a temporary folder removed at the end.
 */
export function migrateScriptPowerShell(publicUrl: string): string {
  const server = serverOf(publicUrl);
  const sha = RUNNER_BUN_WINDOWS_SHA256;
  return `# agentes.chat: reads the agents another app keeps on this computer and writes one .zip for the import screen.
# It only reads, and it sends nothing. Nothing is installed: what it downloads is removed when it ends.
# Usage: & ([scriptblock]::Create((irm ${server}/migrate.ps1))) -From openbot -Out "$HOME\\Downloads"
param(
  [string]$From,
  [string]$Out,
  [string]$Data,
  [string]$Company,
  [switch]$Json,
  [switch]$NoFiles
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Server = ${psQuote(server)}
$BunVersion = ${psQuote(RUNNER_BUN_VERSION)}
$Work = Join-Path ([IO.Path]::GetTempPath()) ('agentes-migrate-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Work | Out-Null
$Code = 1
try {
  $Runtime = $null
  $Bun = Get-Command bun -ErrorAction SilentlyContinue
  $Node = Get-Command node -ErrorAction SilentlyContinue
  if ($Bun) {
    $Runtime = $Bun.Source
  } elseif ($Node -and ((& $Node.Source -v) -match '^v(\\d+)') -and ([int]$Matches[1] -ge 22)) {
    $Runtime = $Node.Source
  } else {
    $Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($Arch) {
      'AMD64' { $Target = 'windows-x64-baseline'; $Sha = ${psQuote(sha["windows-x64-baseline"])} }
      'ARM64' { $Target = 'windows-aarch64'; $Sha = ${psQuote(sha["windows-aarch64"])} }
      default { throw "This needs Bun or Node.js 22 or newer. Install one (https://bun.sh or https://nodejs.org), then run this again." }
    }
    $Zip = Join-Path $Work 'bun.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-$Target.zip" -OutFile $Zip
    if ((Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLower() -ne $Sha) {
      throw "The Bun download didn't match its checksum, so it was not used."
    }
    Expand-Archive -Path $Zip -DestinationPath $Work -Force
    $Runtime = Join-Path $Work "bun-$Target\\bun.exe"
  }
  $Bundle = Join-Path $Work 'agentes-runner.mjs'
  Invoke-WebRequest -UseBasicParsing -Uri "$Server/runner/agentes-runner.mjs" -OutFile $Bundle
  $Pass = @('migrate')
  if ($From) { $Pass += @('--from', $From) }
  if ($Out) { $Pass += @('--out', $Out) }
  if ($Data) { $Pass += @('--data', $Data) }
  if ($Company) { $Pass += @('--company', $Company) }
  if ($Json) { $Pass += '--json' }
  if ($NoFiles) { $Pass += '--no-files' }
  $env:NODE_NO_WARNINGS = '1'
  & $Runtime $Bundle @Pass
  $Code = $LASTEXITCODE
} finally {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
# No exit here: run as a script block in someone's own window, that would close it.
$global:LASTEXITCODE = $Code
`;
}
