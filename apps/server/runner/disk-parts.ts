import { execFile } from "node:child_process";
import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AGENT_WORKER_HOMES, GROK_ACCOUNT_HOMES, SYSTEM_RUNNER_HOME } from "@agenteschat/adapters/command-policy";
import { DISK_PARTS, type DiskPart, type DiskParts } from "@agenteschat/adapters/machine-protocol";
import { ACCOUNT_STORES, GIT_CACHE_DIR } from "./agent-users";
import { readJson, writeJson } from "./json-file";
import { AGENT_DISK_TMP_ROOT, AGENT_TMP_ROOT } from "./service";
import { SHARED_ROOT } from "./shared-folder";

/**
 * What takes the workspace's disk by kind, like a computer's own storage view (system mode on Linux): one `du` over
 * known paths, at the lowest CPU and IO priority, every `DISK_PARTS_MS`, kept in `disk-parts.json` so a restart doesn't
 * walk the disk again.
 */

export const DISK_PARTS_FILE = "disk-parts.json";

/** Inside each home: tools' download caches first, then the tools themselves. */
const HOME_CACHES = [".cache", ".npm", ".bun/install/cache"];
const HOME_APPS = [".local", ".bun", ".nvm", ".cargo", ".rustup", "go", ".pyenv"];
/** A checkout deeper than this under a home or the workspace counts with the folder it is in. */
const REPO_DEPTH = 3;
/** The most folders read looking for checkouts, so a home of a million folders can't hold the walk up. */
const REPO_DIRS_MAX = 5000;

export interface DiskLayout {
  workspace: string;
  /** Every agent's and person's home on the computer. */
  homes: string[];
  /** Git checkouts in the workspace and the homes. */
  repos: string[];
}

/**
 * Each path a kind covers, the narrowest first: GNU `du` counts what two of its arguments share once, for the first,
 * so a checkout in an agent's folder is a project and the rest of that folder the agent's.
 */
export function diskPartPaths({ workspace, homes, repos }: DiskLayout): [DiskPart, string][] {
  const inHomes = (part: DiskPart, subs: string[]) =>
    homes.flatMap((h) => subs.map((s): [DiskPart, string] => [part, path.join(h, s)]));
  const of = (part: DiskPart, paths: string[]) => paths.map((p): [DiskPart, string] => [part, p]);
  return [
    ...of("projects", [GIT_CACHE_DIR, ...repos]),
    ...inHomes("caches", HOME_CACHES),
    ...of("caches", [AGENT_DISK_TMP_ROOT, AGENT_TMP_ROOT, "/var/cache", "/var/tmp", "/tmp"]),
    ...inHomes("apps", HOME_APPS),
    ...of("apps", [SYSTEM_RUNNER_HOME, "/usr/local", "/opt", "/var/lib/docker", "/var/lib/containers", "/snap"]),
    ...of("agents", [workspace, AGENT_WORKER_HOMES, GROK_ACCOUNT_HOMES, ACCOUNT_STORES, "/home", "/root"]),
    ...of("system", ["/usr", "/boot", "/etc", "/var"]),
  ];
}

const dirsIn = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
};

/** The folders under `roots`, `REPO_DEPTH` deep at most, that hold a `.git`: hidden folders and node_modules skipped. */
export function findRepos(roots: string[]): string[] {
  const repos: string[] = [];
  let read = 0;
  let level = roots;
  for (let depth = 0; depth <= REPO_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (++read > REPO_DIRS_MAX) return repos;
      const subs = dirsIn(dir);
      if (depth > 0 && subs.some((d) => d.name === ".git")) {
        repos.push(dir);
        continue;
      }
      for (const d of subs) if (!d.name.startsWith(".") && d.name !== "node_modules") next.push(path.join(dir, d.name));
    }
    level = next;
  }
  return repos;
}

/** The computer's layout as `diskPartPaths` takes it. */
export function diskLayout(workspace: string): DiskLayout {
  const homeRoots = [AGENT_WORKER_HOMES, GROK_ACCOUNT_HOMES, "/home"];
  const homes = [...homeRoots.flatMap((r) => dirsIn(r).map((d) => path.join(r, d.name))), "/root"];
  return { workspace, homes, repos: findRepos([...new Set([workspace, SHARED_ROOT, ...homeRoots])]) };
}

const devOf = (p: string) => {
  try {
    return statSync(p).dev;
  } catch {
    return null;
  }
};

const realOf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

const execFileAsync = promisify(execFile);

/** `du -skx`'s output for `paths`; what it couldn't read (exit 1) still leaves the rest's totals. */
async function du(paths: string[]): Promise<string | null> {
  try {
    const args = ["-c3", "nice", "-n", "19", "du", "-skx", "--", ...paths];
    return (await execFileAsync("ionice", args, { timeout: 30 * 60_000, maxBuffer: 4 << 20 })).stdout;
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    return typeof out === "string" && out.length > 0 ? out : null;
  }
}

/**
 * What takes the workspace's disk, by kind, in GB (one decimal): only paths on that disk count (an own host's VM keeps
 * the workspace on a data disk, the system on another). Null when nothing could be measured.
 */
export async function measureDiskParts(layout: DiskLayout, run = du): Promise<DiskParts | null> {
  const dev = devOf(layout.workspace);
  if (dev === null) return null;
  const owner = new Map<string, DiskPart>();
  for (const [part, p] of diskPartPaths(layout)) {
    const real = realOf(p);
    if (real && !owner.has(real) && devOf(real) === dev) owner.set(real, part);
  }
  if (owner.size === 0) return null;
  const out = await run([...owner.keys()]);
  if (out === null) return null;
  const kb = Object.fromEntries(DISK_PARTS.map((k) => [k, 0])) as DiskParts;
  for (const line of out.split("\n")) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    const part = m?.[2] === undefined ? undefined : owner.get(m[2]);
    if (m && part) kb[part] += Number(m[1]);
  }
  return Object.fromEntries(DISK_PARTS.map((k) => [k, Math.round((kb[k] / 2 ** 20) * 10) / 10])) as DiskParts;
}

/** The last measure kept in the runner's home, while it is newer than `DISK_PARTS_MS`. */
export function keptDiskParts(home: string, maxAgeMs: number, now = Date.now()): DiskParts | null {
  const kept = readJson<{ at?: unknown; parts?: unknown }>(path.join(home, DISK_PARTS_FILE));
  if (typeof kept?.at !== "number" || now - kept.at >= maxAgeMs) return null;
  const parts = kept.parts as Partial<DiskParts> | undefined;
  return parts && DISK_PARTS.every((k) => typeof parts[k] === "number") ? (parts as DiskParts) : null;
}

export function keepDiskParts(home: string, parts: DiskParts, now = Date.now()) {
  try {
    writeJson(path.join(home, DISK_PARTS_FILE), { at: now, parts });
  } catch {
    // a read-only home: measured again after a restart
  }
}
