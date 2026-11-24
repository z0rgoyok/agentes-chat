import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newerVersion } from "./executors";

/*
 * A code session's turn (ADR 0215): the worktree's own Claude Code agents, skills and commands (`.claude/agents`,
 * `.claude/skills`, `.claude/commands`) copied into a plugin folder the turn loads with `--plugin-dir`, since the
 * checkout's settings are never read (`--setting-sources ""`, ADR 0117: the agent can edit them). What could act
 * outside the turn's checks is taken out of each file's frontmatter: hooks, MCP servers, a permission mode and tools
 * allowed ahead of time. The plugin has no `hooks/` or `.mcp.json` of its own: only those three folders are copied.
 */

const PARTS = ["agents", "skills", "commands"] as const;
/** A frontmatter key a repository's file may not carry into the turn (any case, with `-` or not). */
const DROPPED_KEY = /^["']?(hooks|mcp[-_]?servers|permission[-_]?mode|allowed[-_]?tools)["']?\s*:/i;
export const REPO_PLUGIN_MAX_FILES = 400;
export const REPO_PLUGIN_MAX_BYTES = 4 * 1024 * 1024;
/** How deep a skill's own folders are copied. */
const MAX_DEPTH = 6;
/** Claude Code that takes `--plugin-dir` (and calls its subagent tool `Agent`). */
export const REPO_PLUGIN_MIN_CLAUDE = "2.1.63";

/** Whether the `--version` line `version` (null: not known) is `min` or newer. */
export function claudeAtLeast(version: string | null | undefined, min: string): boolean {
  return Boolean(version) && !newerVersion(min, version ?? "");
}

/**
 * A Markdown file without the frontmatter keys that act outside the turn's rules, and the lines under them (indented,
 * or a list at the key's own level).
 */
export function safeFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text;
  const lines = text.slice(0, end).split("\n");
  const kept: string[] = [lines[0] ?? "---"];
  let dropping = false;
  for (const line of lines.slice(1)) {
    const key = /^[^\s#-]/.test(line);
    if (key) dropping = DROPPED_KEY.test(line);
    if (!dropping) kept.push(line);
  }
  return `${kept.join("\n")}${text.slice(end)}`;
}

/**
 * The worktree's agents, skills and commands as a plugin folder at `into` (made anew), or null when it has none:
 * regular files only, never through a link, Markdown with a safe frontmatter and anything else (a skill's scripts) as
 * it is, at most `REPO_PLUGIN_MAX_FILES` files and `REPO_PLUGIN_MAX_BYTES` in all.
 */
export function repoPlugin(worktree: string, into: string, fileMode = 0o600): string | null {
  rmSync(into, { recursive: true, force: true });
  let files = 0;
  let bytes = 0;
  const copy = (from: string, to: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(from).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (files >= REPO_PLUGIN_MAX_FILES) return;
      const src = path.join(from, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(src);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const dst = path.join(to, name);
      if (st.isDirectory()) {
        copy(src, dst, depth + 1);
        continue;
      }
      if (!st.isFile() || bytes + st.size > REPO_PLUGIN_MAX_BYTES) continue;
      let data: Buffer;
      try {
        data = readFileSync(src);
      } catch {
        continue;
      }
      mkdirSync(to, { recursive: true });
      writeFileSync(dst, name.toLowerCase().endsWith(".md") ? safeFrontmatter(data.toString("utf8")) : data, {
        mode: fileMode,
      });
      files += 1;
      bytes += st.size;
    }
  };
  for (const part of PARTS) copy(path.join(worktree, ".claude", part), path.join(into, part), 0);
  return files > 0 ? into : null;
}

/**
 * What the worktree's agents, skills and commands are now, cheaply: their paths, sizes and times, nothing read ("":
 * none). A process started on another print never saw what the agent or a person added since (ADR 0215).
 */
export function repoPluginPrint(worktree: string): string {
  const seen: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || seen.length >= REPO_PLUGIN_MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (seen.length >= REPO_PLUGIN_MAX_FILES) return;
      const at = path.join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(at);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(at, depth + 1);
      else if (st.isFile()) seen.push(`${path.relative(worktree, at)}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  };
  for (const part of PARTS) walk(path.join(worktree, ".claude", part), 0);
  return seen.length > 0 ? createHash("sha256").update(seen.join("\n")).digest("hex").slice(0, 16) : "";
}
