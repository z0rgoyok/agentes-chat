import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Budget, type Collected, type Entry, MigrateError, noCounts, noLeft, tilde, walk } from "./collect";

/**
 * Hermes Agent and OpenClaw on this computer: their own folders, with only the files the import page reads
 * (`packages/client/src/lib/import/hermes.ts`, `openclaw.ts`) and, for OpenClaw, what each agent made in its
 * workspace. Their settings files can hold a key (a header, a bot token), so those are written with every value
 * whose name says it is one emptied; `.env`, `auth.json` and the like are never read (`isSecretFile`).
 */

/** A key or a header whose name says it holds a credential. */
const SECRET_NAME = "(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization|auth[-_]?key|bearer)";
/** `name: value`, `"name": "value"`, `name = value` on one line, in YAML, JSON and JSON5. */
const SECRET_LINE = new RegExp(
  `((?:["']?)[\\w.-]*${SECRET_NAME}[\\w.-]*(?:["']?)\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,{}\\[\\]#][^,{}\\[\\]\\n#]*)`,
  "gi",
);
/** A user and a password in an address. */
const URL_LOGIN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+(?::[^\s/@"']*)?@/gi;

/** A settings file's text with the values that can be credentials emptied. */
export function scrubSettings(text: string): string {
  return text.replace(SECRET_LINE, '$1""').replace(URL_LOGIN, "$1");
}

const text = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const isDir = (dir: string) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
const bytes = (value: string) => new TextEncoder().encode(value);

/** Settings files: read whole, written scrubbed. Anything larger is no settings file. */
const SETTINGS_MAX = 2 * 1024 * 1024;

function settings(file: string, name: string, entries: Entry[]): string | null {
  if (!existsSync(file) || statSync(file).size > SETTINGS_MAX) return null;
  const raw = text(file);
  if (raw === null) return null;
  const clean = scrubSettings(raw);
  entries.push({ name, source: { bytes: bytes(clean) } });
  return clean;
}

export function collectHermes(options: { dir: string; home: string }): Collected {
  const root = options.dir;
  if (!isDir(root)) {
    throw new MigrateError("not_found", `Hermes isn't on this computer (no ${tilde(root, options.home)}).`);
  }
  const left = noLeft();
  const counts = noCounts();
  const entries: Entry[] = [];
  const budget = new Budget();
  const top = path.basename(root) || "hermes";
  const profiles = ["", ...walkNames(path.join(root, "profiles")).map((n) => `profiles/${n}`)];
  for (const profile of profiles) {
    const dir = path.join(root, ...profile.split("/").filter(Boolean));
    const at = (name: string) => [top, profile, name].filter(Boolean).join("/");
    const soul = path.join(dir, "SOUL.md");
    const dist = path.join(dir, "distribution.yaml");
    if (!existsSync(dist) && !(existsSync(soul) && existsSync(path.join(dir, "config.yaml")))) continue;
    counts.agents++;
    for (const name of ["config.yaml", "profile.yaml", "distribution.yaml", "mcp.json"]) {
      settings(path.join(dir, name), at(name), entries);
    }
    const jobs = settings(path.join(dir, "cron", "jobs.json"), at("cron/jobs.json"), entries);
    if (jobs) {
      try {
        const parsed = JSON.parse(jobs) as { jobs?: unknown };
        if (Array.isArray(parsed.jobs)) counts.routines += parsed.jobs.length;
      } catch {}
    }
    for (const name of ["SOUL.md", "MEMORY.md", "USER.md", "memories/MEMORY.md", "memories/USER.md"]) {
      const file = path.join(dir, ...name.split("/"));
      const body = existsSync(file) && statSync(file).size <= SETTINGS_MAX ? text(file) : null;
      if (body === null || !budget.take(body.length)) continue;
      entries.push({ name: at(name), source: { file } });
      if (name !== "SOUL.md") counts.memories += body.split("§").filter((e) => e.trim()).length;
    }
    for (const f of walk(path.join(dir, "skills"), left, budget)) {
      entries.push({ name: at(`skills/${f.rel}`), source: { file: f.file } });
      if (/(^|\/)SKILL\.md$/.test(f.rel)) counts.skills++;
    }
  }
  if (counts.agents === 0) {
    throw new MigrateError(
      "nothing",
      `No Hermes profile in ${tilde(root, options.home)} (a SOUL.md and a config.yaml).`,
    );
  }
  return { source: "hermes", where: tilde(root, options.home), entries, counts, left, notes: [] };
}

const CLAW_CONFIGS = ["openclaw.json", "clawdbot.json", "moltbot.json"];

export function collectOpenClaw(options: { dir: string; home: string; noFiles?: boolean }): Collected {
  const root = options.dir;
  if (!isDir(root)) {
    throw new MigrateError("not_found", `OpenClaw isn't on this computer (no ${tilde(root, options.home)}).`);
  }
  const left = noLeft();
  const counts = noCounts();
  const entries: Entry[] = [];
  const notes: string[] = [];
  const budget = new Budget();
  const top = path.basename(root) || "openclaw";
  for (const name of CLAW_CONFIGS) settings(path.join(root, name), `${top}/${name}`, entries);
  const workspaces = walkNames(root).filter((n) => /^workspace(-|$)/.test(n));
  /** What the import reads of a workspace; the rest is what the agent made there. */
  const read = (rel: string) =>
    /^(SOUL|AGENTS|IDENTITY|USER|MEMORY|TOOLS|HEARTBEAT)\.md$/.test(rel) ||
    /^(memory|skills|\.agents\/skills)\//.test(rel);
  for (const name of workspaces) {
    counts.agents++;
    for (const f of walk(path.join(root, name), left, budget, (rel, dir) => !dir && !!options.noFiles && !read(rel))) {
      entries.push({ name: `${top}/${name}/${f.rel}`, source: { file: f.file } });
      if (/(^|\/)SKILL\.md$/.test(f.rel)) counts.skills++;
      else if (f.rel === "MEMORY.md" || f.rel.startsWith("memory/")) counts.memories++;
      else if (!read(f.rel)) {
        counts.files++;
        counts.bytes += f.size;
      }
    }
  }
  for (const f of walk(path.join(root, "skills"), left, budget)) {
    entries.push({ name: `${top}/skills/${f.rel}`, source: { file: f.file } });
    if (/(^|\/)SKILL\.md$/.test(f.rel)) counts.skills++;
  }
  if (counts.agents === 0) {
    throw new MigrateError("nothing", `No OpenClaw workspace in ${tilde(root, options.home)}.`);
  }
  if (existsSync(path.join(root, "cron"))) {
    notes.push("Scheduled jobs stay in OpenClaw: set them up again as routines on agentes.chat.");
  }
  return { source: "openclaw", where: tilde(root, options.home), entries, counts, left, notes };
}

/** The folders of a folder, by name; none when it isn't there. */
function walkNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
