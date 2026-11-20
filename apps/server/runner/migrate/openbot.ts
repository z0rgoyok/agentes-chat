import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSecretFile } from "@agenteschat/tokens/names";
import {
  Budget,
  type Collected,
  type Entry,
  FILE_MAX_BYTES,
  MigrateError,
  noCounts,
  noLeft,
  tilde,
  walk,
} from "./collect";
import { scrubSettings } from "./folders";
import { readZip } from "./zip";

/**
 * OpenBot.run (github.com/nightly-labs/openbot) on this computer, written as the file its own Server settings ›
 * Transfer makes (`openbot-instance-transfer` v1, `docs/architecture/agents.md`, "Instance transfer"), which the
 * import page already reads (`packages/client/src/lib/import/openbotrun.ts`). Read from where the app keeps it:
 * `openbot.db` in its data folder (SQLite; `src/backend/openbot-database-schema.ts`, `channel-schema.ts`,
 * `mcp-schema.ts`) and each agent's workspace folder. The app's own files are only read (see `openDatabase`).
 *
 * Also its workflows (`workflows`, `workflow_nodes`, `workflow_edges`: `src/backend/workflows/workflow-schema.ts`),
 * written as its transfer writes them (`settings.workflows`, agents and channels by their keys in the file, a
 * messaging connection emptied), what hands a routine's answer to another agent (`settings.routineFlows`, from
 * `routine_flow_links`), and the skills of its library that no agent has (`<data>/local-skills/<id>/<revision>/
 * bundle.zip`, the latest revision, as `sharedSkills` in `library/<slug>/`). Its messaging connections are named only
 * (`settings.messagingConnections`, this command's own): they have nothing to connect to on agentes.chat.
 *
 * Never read: the values of MCP variables and headers, a webhook's address and secret, provider sign-ins, browser
 * data, chats. An MCP address keeps only its origin, as the app's own export does (a path can hold a key). A value a
 * workflow step keeps under a name that says it is a key is emptied.
 */

type Row = Record<string, unknown>;
/** Runs one statement with no parameters and gives its rows. */
type Query = (sql: string) => Row[];

/** OpenBot's data folder (Electron's `userData`), by platform. */
export function openbotDataDir(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "OpenBot");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "OpenBot");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "OpenBot");
}

/**
 * A reader for the database, with what this runtime has: Bun's or Node's own SQLite (the names are built at run
 * time, so a bundle for one runtime never resolves the other's), else the `sqlite3` command. The app keeps it in WAL
 * mode, which SQLite can't open read-only unless the files beside it exist (it would make them in the app's folder,
 * and it can't), so a copy is read: the database and its log, in a temporary folder only this user can open, removed
 * on close. The app's own files are never written.
 */
export async function openDatabase(file: string): Promise<{ query: Query; close: () => void }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentes-migrate-"));
  const removeCopy = () => rmSync(dir, { recursive: true, force: true });
  const copy = path.join(dir, "openbot.db");
  try {
    copyFileSync(file, copy);
    // The log holds what the app wrote last and hasn't moved into the database yet (only while it runs).
    if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
  } catch (error) {
    removeCopy();
    throw new MigrateError(
      "unreadable",
      `Couldn't read ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const load = async (name: string) => (await import(name)) as Record<string, unknown>;
  type Db = { prepare: (sql: string) => { all: () => Row[] }; close: () => void };
  let db: Db | null = null;
  try {
    if (process.versions.bun) {
      const { Database } = await load(["bun", "sqlite"].join(":"));
      db = new (Database as new (file: string) => Db)(copy);
    } else {
      const { DatabaseSync } = await load(["node", "sqlite"].join(":"));
      db = new (DatabaseSync as new (file: string) => Db)(copy);
    }
  } catch {
    db = null;
  }
  if (db) {
    const open = db;
    return {
      query: (sql) => open.prepare(sql).all(),
      close: () => {
        open.close();
        removeCopy();
      },
    };
  }
  const query: Query = (sql) => {
    const out = execFileSync("sqlite3", ["-json", copy, sql], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() ? (JSON.parse(out) as Row[]) : [];
  };
  try {
    query("SELECT 1 AS ok");
  } catch {
    removeCopy();
    throw new MigrateError(
      "tool_missing",
      "Reading OpenBot's database needs Bun, Node.js 22.5 or newer, or the sqlite3 command on this computer.",
    );
  }
  return { query, close: removeCopy };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const json = (v: unknown): unknown => {
  try {
    return JSON.parse(str(v));
  } catch {
    return null;
  }
};

/** A name as a key the transfer file takes: lowercase letters, digits and hyphens. */
export function keyOf(name: string, taken: Set<string>, fallback: string): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || fallback;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/** Only where a server answers: a path, a query or a user in an address can hold its key. */
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

const SKILL_FOLDERS = [".agents/skills", ".claude/skills"];
/** In a skill folder OpenBot installed itself: it installs them again, so they are not the person's. */
const MANAGED_MARK = ".openbot-managed.json";
/** OpenBot's own folders in a workspace, compared without case (a disk that ignores it writes `.OpenBot`). */
const OWN = [".openbot", ...SKILL_FOLDERS];
const own = (rel: string) => {
  const lower = rel.toLowerCase();
  return OWN.some((o) => lower === o || lower.startsWith(`${o}/`));
};

interface Routine {
  key: string;
  name: string;
  instruction: string;
  active: boolean;
  timezone: string;
  schedule?: unknown;
  eventType?: string | null;
}

/** An owner's routines, by how they start: on a schedule, once, or by a webhook (never its address: it gets a new one). */
function routinesOf(rows: Row[], triggers: Map<string, unknown>, webhooks: Map<string, Row>) {
  const scheduled: Routine[] = [];
  const once: Routine[] = [];
  const hooks: Routine[] = [];
  for (const r of rows) {
    const id = str(r.routine_id);
    const base = {
      key: id,
      name: str(r.name),
      instruction: str(r.instruction),
      active: r.active === 1 || r.active === true,
      timezone: str(r.timezone),
    };
    const schedule = triggers.get(id);
    const hook = webhooks.get(id);
    if (schedule) (str(obj(schedule).kind) === "once" ? once : scheduled).push({ ...base, schedule });
    else if (hook) hooks.push({ ...base, eventType: str(hook.event_type) || null });
  }
  return { scheduled, once, hooks };
}

export interface OpenBotOptions {
  /** OpenBot's data folder, when it isn't the usual one. */
  dataDir: string;
  home: string;
  /** Leaves the agents' workspace files on the computer. */
  noFiles?: boolean;
}

export async function collectOpenBot(options: OpenBotOptions): Promise<Collected> {
  const file = path.join(options.dataDir, "openbot.db");
  if (!existsSync(file)) {
    throw new MigrateError("not_found", `OpenBot isn't on this computer (no ${tilde(file, options.home)}).`);
  }
  const db = await openDatabase(file);
  try {
    return read(db.query, options);
  } finally {
    db.close();
  }
}

function read(query: Query, options: OpenBotOptions): Collected {
  const has = (table: string) =>
    query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).length > 0;
  const all = (table: string, order: string) => (has(table) ? query(`SELECT * FROM ${table} ORDER BY ${order}`) : []);
  if (!has("projection_agents")) {
    throw new MigrateError(
      "unsupported",
      "This OpenBot keeps its agents in a way this command doesn't read. In OpenBot, open Server settings › Transfer › Export from this server, and drop that .zip on agentes.chat instead.",
    );
  }
  const left = noLeft();
  const counts = noCounts();
  const notes: string[] = [];
  const entries: Entry[] = [];
  const budget = new Budget();

  const byOwner = (rows: Row[], column: string) => {
    const map = new Map<string, Row[]>();
    for (const r of rows) map.set(str(r[column]), [...(map.get(str(r[column])) ?? []), r]);
    return map;
  };
  const schedules = (table: string) =>
    new Map(all(table, "routine_id").map((t) => [str(t.routine_id), json(t.schedule_json)] as const));
  const hooksOf = (table: string) => new Map(all(table, "routine_id").map((w) => [str(w.routine_id), w] as const));
  const memories = byOwner(all("projection_agent_memories", "created_at, memory_id"), "agent_id");
  const routines = byOwner(all("projection_agent_routines", "created_at, routine_id"), "agent_id");
  const triggers = schedules("projection_routine_triggers");
  const webhooks = hooksOf("projection_routine_webhooks");

  const keys = new Map<string, string>();
  const taken = new Set<string>();
  const agents: Row[] = [];
  let hookCount = 0;
  for (const row of all("projection_agents", "sort_order, agent_id")) {
    const a = obj(json(row.agent_json));
    const id = str(row.agent_id);
    const name = str(a.name).trim();
    if (!id || !name) continue;
    const key = keyOf(name, taken, "agent");
    keys.set(id, key);
    const workspace = str(a.workspacePath);
    const prefix = `agents/${key}`;

    // The skills the person or a marketplace installed, each folder once (the first of the two folders wins).
    const skills: string[] = [];
    if (workspace) {
      const seen = new Set<string>();
      for (const folder of SKILL_FOLDERS) {
        for (const skill of skillFolders(path.join(workspace, ...folder.split("/")))) {
          if (seen.has(skill.slug)) continue;
          const files = walk(skill.dir, left, budget);
          if (files.some((f) => f.rel === MANAGED_MARK) || !files.some((f) => f.rel === "SKILL.md")) continue;
          seen.add(skill.slug);
          skills.push(`${prefix}/skills/${skill.slug}`);
          for (const f of files) {
            entries.push({ name: `${prefix}/skills/${skill.slug}/${f.rel}`, source: { file: f.file } });
          }
        }
      }
    }
    counts.skills += skills.length;

    let files: string | null = null;
    if (workspace && !options.noFiles) {
      const found = walk(workspace, left, budget, (rel) => own(rel));
      if (found.length > 0) files = `${prefix}/workspace`;
      for (const f of found) {
        entries.push({ name: `${prefix}/workspace/${f.rel}`, source: { file: f.file } });
        counts.files++;
        counts.bytes += f.size;
      }
    }

    const mine = routinesOf(routines.get(id) ?? [], triggers, webhooks);
    counts.routines += mine.scheduled.length + mine.once.length + mine.hooks.length;
    hookCount += mine.hooks.length;
    const notesOf = (memories.get(id) ?? []).map((m) => ({ text: str(m.text) })).filter((m) => m.text.trim());
    counts.memories += notesOf.length;
    agents.push({
      key,
      name,
      title: str(a.title),
      description: str(a.description),
      avatarSeed: str(a.avatarSeed),
      avatarHue: typeof a.avatarHue === "number" ? a.avatarHue : null,
      ...(str(a.avatarColor) ? { avatarColor: str(a.avatarColor) } : {}),
      avatar: null,
      provider: str(a.provider) || "codex",
      model: str(a.model) || str(row.model),
      reasoningEffort: str(a.reasoningEffort) || "medium",
      notifications: a.notifications !== false,
      skills,
      files,
      routines: mine.scheduled,
      ...(mine.once.length ? { oneTimeRoutines: mine.once } : {}),
      ...(mine.hooks.length ? { webhookRoutines: mine.hooks } : {}),
      memories: notesOf,
    });
  }
  counts.agents = agents.length;
  if (agents.length === 0) throw new MigrateError("nothing", "OpenBot has no agents on this computer yet.");

  // Channels, with the members that came along; one with none of them has nobody to bring.
  const channelMemories = byOwner(all("projection_channel_memories", "created_at, memory_id"), "channel_id");
  const channelRoutines = byOwner(all("projection_channel_routines", "created_at, routine_id"), "channel_id");
  const channelTriggers = schedules("projection_channel_routine_triggers");
  const channelHooks = hooksOf("projection_channel_routine_webhooks");
  const channelKeys = new Set<string>();
  const channelKeyOf = new Map<string, string>();
  const channels: Row[] = [];
  for (const row of all("projection_channels", "channel_id")) {
    const c = obj(json(row.channel_json));
    const id = str(row.channel_id);
    const members = list(c.members).flatMap((m) => keys.get(str(obj(m).agentId)) ?? []);
    if (!id || members.length === 0) continue;
    const mine = routinesOf(channelRoutines.get(id) ?? [], channelTriggers, channelHooks);
    const texts = (channelMemories.get(id) ?? []).map((m) => str(m.text)).filter((t) => t.trim());
    const archived = c.archived === true;
    if (!archived) {
      counts.channels++;
      counts.routines += mine.scheduled.length + mine.once.length + mine.hooks.length;
      counts.memories += texts.length;
      hookCount += mine.hooks.length;
    }
    const key = keyOf(str(c.name) || id, channelKeys, "channel");
    channelKeyOf.set(id, key);
    channels.push({
      key,
      name: str(c.name) || id,
      title: str(c.title),
      instructions: str(c.instructions),
      members,
      lead: keys.get(str(c.leadAgentId)) ?? null,
      image: null,
      archived,
      memories: texts,
      routines: [...mine.scheduled, ...mine.once],
      ...(mine.hooks.length ? { webhookRoutines: mine.hooks } : {}),
    });
  }

  // MCP servers by name, and where an http one answers. Never a command, a variable or a header.
  const mcpServers = all("projection_mcp_servers", "position, mcp_server_id").map((s) => {
    const http = str(s.transport) === "http";
    return {
      id: str(s.mcp_server_id),
      name: str(s.name),
      transport: http ? "http" : "stdio",
      enabled: s.enabled === 1 || s.enabled === true,
      command: "",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      url: http ? originOf(str(s.url)) : "",
      headers: [],
    };
  });
  if (mcpServers.length === 1) {
    notes.push("1 MCP server comes by name only: connect it again on agentes.chat.");
  } else if (mcpServers.length > 1) {
    notes.push(`${mcpServers.length} MCP servers come by name only: connect them again on agentes.chat.`);
  }

  const workflows = workflowsOf(all, keys, channelKeyOf);
  counts.workflows = workflows.length;
  const hookFlows = workflows.filter((w) =>
    list(obj(w.graph).nodes).some(
      (n) => str(obj(n).kind) === "trigger" && str(obj(obj(n).fields).trigger) === "webhook",
    ),
  ).length;
  hookCount += hookFlows;
  if (hookCount === 1) notes.push("1 routine starts from a webhook: it gets a new address on agentes.chat.");
  else if (hookCount > 1)
    notes.push(`${hookCount} routines start from a webhook: each gets a new address on agentes.chat.`);

  // What hands a routine's answer on: only between agents that came.
  const routineFlows = all("routine_flow_links", "created_at, link_id").flatMap((l) => {
    const from = keys.get(str(l.from_agent_id));
    const to = keys.get(str(l.to_agent_id));
    return from && to
      ? [{ routineKey: str(l.routine_id), fromAgentKey: from, toAgentKey: to, instruction: str(l.instruction) }]
      : [];
  });

  const library = librarySkills(path.join(options.dataDir, "local-skills"), left, budget);
  counts.skills += library.skills.length;
  entries.push(...library.entries);

  // Messaging connections, by platform and name: there is nothing to connect them to on agentes.chat.
  const messagingConnections = all("projection_messaging_connections", "created_at, connection_id").map((m) => ({
    platform: str(m.platform),
    name: str(m.workspace_name),
  }));
  if (messagingConnections.length === 1)
    notes.push("1 messaging connection is named only: it has no match on agentes.chat.");
  else if (messagingConnections.length > 1) {
    notes.push(
      `${messagingConnections.length} messaging connections are named only: they have no match on agentes.chat.`,
    );
  }

  const manifest = {
    format: "openbot-instance-transfer",
    version: 1,
    source: { appVersion: "", exportedAt: new Date().toISOString() },
    agents,
    settings: {
      mcpServers,
      customProviders: [],
      customAgents: [],
      sidebarSections: [],
      routineFlows,
      workflows,
      ...(messagingConnections.length ? { messagingConnections } : {}),
    },
    shared: null,
    signedIn: [],
    channels,
    ...(library.skills.length ? { sharedSkills: library.skills } : {}),
  };
  entries.unshift({
    name: "openbot-transfer.json",
    source: { bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) },
  });
  return { source: "openbot", where: tilde(options.dataDir, options.home), entries, counts, left, notes };
}

/** The workflows, as the app's transfer writes them (`src/main/instance-transfer-workflows.ts`). */
function workflowsOf(
  all: (table: string, order: string) => Row[],
  agentKeys: ReadonlyMap<string, string>,
  channelKeys: ReadonlyMap<string, string>,
): Row[] {
  const byWorkflow = (rows: Row[]) => {
    const map = new Map<string, Row[]>();
    for (const r of rows) map.set(str(r.workflow_id), [...(map.get(str(r.workflow_id)) ?? []), r]);
    return map;
  };
  const nodes = byWorkflow(all("workflow_nodes", "workflow_id, position"));
  const edges = byWorkflow(all("workflow_edges", "workflow_id, position"));
  return all("workflows", "created_at, workflow_id").flatMap((w) => {
    const id = str(w.workflow_id);
    const title = str(w.title).trim();
    if (!id || !title) return [];
    let relink = false;
    const graphNodes = (nodes.get(id) ?? []).map((n) => {
      const fields = obj(json(scrubSettings(str(n.fields_json) || "{}")));
      const kind = str(n.kind);
      if (kind === "agent") fields.agentId = agentKeys.get(str(fields.agentId)) ?? "";
      if (kind === "output" && fields.target === "chat-channel")
        fields.channelId = channelKeys.get(str(fields.channelId)) ?? "";
      // A messaging connection belongs to that computer; "trigger" names the trigger's own and stays.
      if (str(fields.connectionId) && fields.connectionId !== "trigger") {
        fields.connectionId = "";
        relink = true;
      }
      const schedule = json(n.schedule_json);
      return {
        id: str(n.node_id),
        kind,
        at: { x: Number(n.x) || 0, y: Number(n.y) || 0 },
        fields,
        ...(schedule ? { schedule } : {}),
      };
    });
    const graphEdges = (edges.get(id) ?? []).map((e) => ({
      id: str(e.edge_id),
      from: str(e.from_node_id),
      to: str(e.to_node_id),
      type: str(e.port_type) || "text",
      ...(str(e.branch) ? { branch: str(e.branch) } : {}),
    }));
    return [
      { title, graph: { nodes: graphNodes, edges: graphEdges, strokes: [] }, ...(relink ? { relink: true } : {}) },
    ];
  });
}

/** The app's own skills (`src/main/managed-skill-service.ts`): it installs them again, so they are not the person's. */
const MANAGED_LIBRARY = new Set(["openbot-site-hosting", "openbot-skill-creator", "openbot-data"]);

/**
 * The library's skills, each its latest revision's files under `library/<slug>/` (`src/main/local-skill-library.ts`).
 * A file that holds a key stays, as in a folder walked.
 */
function librarySkills(root: string, left: Collected["left"], budget: Budget) {
  const skills: { slug: string; name: string; path: string; files: string[] }[] = [];
  const entries: Entry[] = [];
  let ids: string[];
  try {
    ids = readdirSync(root).sort();
  } catch {
    return { skills, entries };
  }
  const slugs = new Set<string>();
  for (const id of ids) {
    let revisions: number[];
    try {
      revisions = readdirSync(path.join(root, id))
        .filter((n) => /^[1-9]\d*$/.test(n))
        .map(Number);
    } catch {
      continue;
    }
    if (!revisions.length) continue;
    let files: Map<string, Uint8Array> | null = null;
    try {
      files = readZip(readFileSync(path.join(root, id, String(Math.max(...revisions)), "bundle.zip")), FILE_MAX_BYTES);
    } catch {
      files = null;
    }
    const md = files?.get("SKILL.md");
    if (!files || !md) continue;
    const name = /^name:\s*["']?(.+?)["']?\s*$/m.exec(new TextDecoder().decode(md))?.[1]?.trim() || id;
    const slug = keyOf(name, slugs, "skill");
    if (MANAGED_LIBRARY.has(slug)) continue;
    const kept: string[] = [];
    for (const [file, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      if (isSecretFile(file)) {
        left.secrets++;
        continue;
      }
      if (!budget.take(bytes.byteLength)) {
        left.over++;
        continue;
      }
      kept.push(file);
      entries.push({ name: `library/${slug}/${file}`, source: { bytes } });
    }
    if (kept.includes("SKILL.md")) skills.push({ slug, name, path: `library/${slug}`, files: kept });
  }
  return { skills, entries };
}

/** The folders of a skills folder; a link to a folder counts (`npx skills` links each skill to one copy). */
function skillFolders(root: string): { slug: string; dir: string }[] {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const found: { slug: string; dir: string }[] = [];
  for (const slug of names) {
    if (slug.startsWith(".") || slug.includes("/") || slug.includes("\\")) continue;
    const dir = path.join(root, slug);
    try {
      if (statSync(dir).isDirectory()) found.push({ slug, dir: realpathSync(dir) });
    } catch {}
  }
  return found;
}
