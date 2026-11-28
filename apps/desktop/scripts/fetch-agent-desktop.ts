/**
 * `bun apps/desktop/scripts/fetch-agent-desktop.ts <bin dir> <target triple>...` (.github/workflows/desktop.yml): the
 * pinned `agent-desktop` release archive for each triple, checked against `AGENT_DESKTOP_SHA256` (the one source of the
 * version and the hashes), unpacked into Tauri's sidecar names: `agent-desktop-<triple>[.exe]`, and on macOS its
 * helper `agent-desktop-macos-helper-<triple>` (the CLI finds it beside itself).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_DESKTOP_SHA256,
  type AgentDesktopTarget,
  agentDesktopUrl,
} from "../../../packages/adapters/src/machine-protocol";

const [binDir, ...triples] = process.argv.slice(2);
if (!binDir || triples.length === 0) throw new Error("usage: fetch-agent-desktop.ts <bin dir> <target triple>...");
mkdirSync(binDir, { recursive: true });

for (const triple of triples) {
  if (!Object.hasOwn(AGENT_DESKTOP_SHA256, triple)) throw new Error(`no agent-desktop build for ${triple}`);
  const target = triple as AgentDesktopTarget;
  const res = await fetch(agentDesktopUrl(target), { redirect: "follow" });
  if (!res.ok) throw new Error(`agent-desktop ${target}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== AGENT_DESKTOP_SHA256[target]) throw new Error(`agent-desktop ${target}: checksum ${got}`);
  const dir = mkdtempSync(path.join(tmpdir(), "agent-desktop-"));
  try {
    const archive = path.join(dir, "a.tar.gz");
    writeFileSync(archive, bytes);
    // Relative to `dir`: Git Bash's GNU tar on the Windows runners reads "C:\…" as a remote host.
    const tar = spawnSync("tar", ["-xzf", path.basename(archive)], { cwd: dir, stdio: "inherit" });
    if (tar.status !== 0) throw new Error(`agent-desktop ${target}: tar exited with ${tar.status}`);
    const exe = target.includes("windows") ? ".exe" : "";
    const files = [`agent-desktop${exe}`, ...(target.endsWith("apple-darwin") ? ["agent-desktop-macos-helper"] : [])];
    for (const file of files) {
      const out = path.join(binDir, `${file.replace(/\.exe$/, "")}-${triple}${exe}`);
      copyFileSync(path.join(dir, file), out);
      chmodSync(out, 0o755);
      console.log(out);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
