import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { migrate } from "../../runner/migrate";
import { scrubSettings } from "../../runner/migrate/folders";
import { keyOf } from "../../runner/migrate/openbot";
import { crc32, readZip } from "../../runner/migrate/zip";
import { migrateScript, migrateScriptPowerShell } from "../../runner/migrate-script";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migrate-test-"));
  made.push(dir);
  return dir;
}

/** The entries of a stored zip, by name. */
function unzip(file: string): Map<string, Uint8Array> {
  const bytes = new Uint8Array(readFileSync(file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const localName = view.getUint16(offset + 26, true);
    const data = bytes.subarray(offset + 30 + localName, offset + 30 + localName + size);
    // The local header carries the same sizes and CRC, written back after the file was copied.
    expect(view.getUint32(offset + 14, true)).toBe(crc);
    expect(view.getUint32(offset + 18, true)).toBe(size);
    expect(crc32(data)).toBe(crc);
    entries.set(name, data);
    at += 46 + nameLength;
  }
  return entries;
}

function io(home: string, extra: Partial<Parameters<typeof migrate>[1]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      home,
      env: {} as NodeJS.ProcessEnv,
      platform: "linux" as NodeJS.Platform,
      interactive: false,
      ask: async () => "",
      out: (line: string) => void out.push(line),
      err: (line: string) => void err.push(line),
      ...extra,
    },
  };
}

/** An OpenBot data folder as the app keeps it: two agents, a channel, routines, memories, an MCP server. */
function openbot(home: string) {
  const data = path.join(home, ".config", "OpenBot");
  mkdirSync(data, { recursive: true });
  const scout = path.join(home, "OpenBot", "Agents", "scout");
  const otto = path.join(home, "OpenBot", "Agents", "otto");
  mkdirSync(path.join(scout, ".agents", "skills", "research"), { recursive: true });
  mkdirSync(path.join(scout, ".agents", "skills", "managed"), { recursive: true });
  mkdirSync(path.join(scout, ".openbot"), { recursive: true });
  mkdirSync(path.join(scout, "reports"), { recursive: true });
  mkdirSync(otto, { recursive: true });
  writeFileSync(path.join(scout, ".agents", "skills", "research", "SKILL.md"), "---\nname: research\n---\nLook it up.");
  writeFileSync(path.join(scout, ".agents", "skills", "managed", "SKILL.md"), "---\nname: managed\n---\n");
  writeFileSync(path.join(scout, ".agents", "skills", "managed", ".openbot-managed.json"), "{}");
  writeFileSync(path.join(scout, ".openbot", "state.json"), "{}");
  writeFileSync(path.join(scout, "reports", "week.md"), "# Week\n");
  writeFileSync(path.join(scout, ".env"), "API_KEY=sk-live-1234567890");
  symlinkSync(path.join(scout, "reports", "week.md"), path.join(scout, "link.md"));

  const db = new Database(path.join(data, "openbot.db"));
  // As the app keeps it: in WAL mode, which leaves no log beside it once closed (read-only, SQLite can't open that).
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, thread_id TEXT, model TEXT NOT NULL, updated_at TEXT,
      sort_order INTEGER NOT NULL, agent_json TEXT NOT NULL, last_event_sequence INTEGER NOT NULL);
    CREATE TABLE projection_agent_memories (memory_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL,
      normalized_text TEXT NOT NULL, origin TEXT NOT NULL, source_turn_id TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_event_sequence INTEGER NOT NULL);
    CREATE TABLE projection_agent_routines (routine_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL,
      instruction TEXT NOT NULL, active INTEGER NOT NULL, timezone TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_event_sequence INTEGER NOT NULL);
    CREATE TABLE projection_routine_triggers (trigger_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL,
      schedule_json TEXT NOT NULL, next_run_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_event_sequence INTEGER NOT NULL);
    CREATE TABLE projection_routine_webhooks (routine_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, event_type TEXT,
      filters_json TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_event_sequence INTEGER NOT NULL);
    CREATE TABLE projection_channels (channel_id TEXT PRIMARY KEY, channel_json TEXT NOT NULL);
    CREATE TABLE projection_channel_memories (memory_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL);
    CREATE TABLE projection_mcp_servers (mcp_server_id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL,
      enabled INTEGER NOT NULL, command TEXT NOT NULL, args_json TEXT NOT NULL, env_json TEXT NOT NULL,
      env_passthrough_json TEXT NOT NULL, working_directory TEXT NOT NULL, url TEXT NOT NULL, headers_json TEXT NOT NULL,
      position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  const agent = (id: string, order: number, value: object) =>
    db.run("INSERT INTO projection_agents VALUES (?, NULL, 'gpt', NULL, ?, ?, 1)", [id, order, JSON.stringify(value)]);
  agent("a1", 0, {
    name: "Scout",
    title: "Research",
    description: "You look things up.",
    provider: "claude",
    model: "claude-opus",
    reasoningEffort: "high",
    avatarSeed: "s1",
    avatarHue: 120,
    workspacePath: scout,
  });
  agent("a2", 1, { name: "Otto Ofertas", title: "", description: "Offers.", avatarSeed: "s2", workspacePath: otto });
  db.run(
    "INSERT INTO projection_agent_memories VALUES ('m1', 'a1', 'Likes short answers', 'x', 'manual', NULL, '1', '1', 1)",
  );
  const routine = (id: string, name: string, active: number) =>
    db.run("INSERT INTO projection_agent_routines VALUES (?, 'a1', ?, 'Do it', ?, 'America/Sao_Paulo', '1', '1', 1)", [
      id,
      name,
      active,
    ]);
  routine("r1", "Daily", 0);
  routine("r2", "Once", 1);
  routine("r3", "On push", 1);
  const trigger = (id: string, schedule: object) =>
    db.run("INSERT INTO projection_routine_triggers VALUES (?, ?, ?, '1', '1', '1', 1)", [
      `t-${id}`,
      id,
      JSON.stringify(schedule),
    ]);
  trigger("r1", { kind: "daily", time: "09:00" });
  trigger("r2", { kind: "once", date: "2030-01-01", time: "10:00" });
  db.run(
    "INSERT INTO projection_routine_webhooks VALUES ('r3', 'route', 'push', '[]', 'CIPHERTEXT', 'https://hooks.example/secret-path', '1', '1', 1)",
  );
  const channel = (id: string, value: object) =>
    db.run("INSERT INTO projection_channels VALUES (?, ?)", [id, JSON.stringify(value)]);
  channel("c1", {
    name: "Launch",
    title: "The launch",
    instructions: "Ship it.",
    members: [{ agentId: "a1" }, { agentId: "a2" }, { agentId: "gone" }],
    leadAgentId: "a1",
    archived: false,
  });
  channel("c2", { name: "Old", title: "", instructions: "", members: [{ agentId: "a2" }], archived: true });
  channel("c3", { name: "Empty", title: "", instructions: "", members: [{ agentId: "gone" }], archived: false });
  db.run("INSERT INTO projection_channel_memories VALUES ('cm1', 'c1', 'Launch is on Friday', '1')");
  db.run(
    `INSERT INTO projection_mcp_servers VALUES ('s1', 'HubSpot', 'http', 1, '', '[]', '[{"name":"TOKEN","value":"sk-secret"}]', '[]', '',
      'https://user:pw@mcp.example.com/key-in-path?token=abc', '[{"name":"Authorization","value":"Bearer zzz"}]', 0, '1', '1')`,
  );
  db.close();
  return data;
}

test("OpenBot on this computer becomes its own transfer file, with nothing that holds a key", async () => {
  const home = temp();
  const data = openbot(home);
  const out = path.join(home, "out");
  const run = io(home);
  // Nothing may be written in the app's folder: its database in WAL mode is read from a copy.
  chmodSync(data, 0o555);
  const code = await migrate({ from: "openbot", out, json: true, noFiles: false }, run.io).finally(() =>
    chmodSync(data, 0o755),
  );
  expect(run.err).toEqual([]);
  expect(code).toBe(0);
  expect(readdirSync(data)).toEqual(["openbot.db"]);
  const result = JSON.parse(run.out.join("")) as {
    ok: boolean;
    file: string;
    counts: Record<string, number>;
    left: Record<string, number>;
  };
  expect(result.ok).toBe(true);
  expect(result.file).toBe(path.join(out, "agentes-chat-import-openbot.zip"));
  expect(existsSync(`${result.file}.part`)).toBe(false);
  expect(result.counts).toMatchObject({ agents: 2, routines: 3, memories: 2, skills: 1, channels: 1, files: 1 });
  expect(result.left).toMatchObject({ secrets: 1, links: 1 });

  const zip = unzip(result.file);
  expect([...zip.keys()].sort()).toEqual([
    "agents/scout/skills/research/SKILL.md",
    "agents/scout/workspace/reports/week.md",
    "openbot-transfer.json",
  ]);
  const text = new TextDecoder().decode(zip.get("openbot-transfer.json"));
  // No value that can be a credential, anywhere in the file.
  for (const secret of [
    "sk-secret",
    "Bearer zzz",
    "CIPHERTEXT",
    "secret-path",
    "key-in-path",
    "token=abc",
    "user:pw",
  ]) {
    expect(text).not.toContain(secret);
  }
  const manifest = JSON.parse(text);
  expect(manifest.format).toBe("openbot-instance-transfer");
  expect(manifest.version).toBe(1);
  const [scout, otto] = manifest.agents;
  expect(scout).toMatchObject({
    key: "scout",
    name: "Scout",
    title: "Research",
    description: "You look things up.",
    provider: "claude",
    model: "claude-opus",
    skills: ["agents/scout/skills/research"],
    files: "agents/scout/workspace",
    memories: [{ text: "Likes short answers" }],
  });
  expect(scout.routines).toEqual([
    {
      key: "r1",
      name: "Daily",
      instruction: "Do it",
      active: false,
      timezone: "America/Sao_Paulo",
      schedule: { kind: "daily", time: "09:00" },
    },
  ]);
  expect(scout.oneTimeRoutines.map((r: { name: string }) => r.name)).toEqual(["Once"]);
  expect(scout.webhookRoutines).toEqual([
    {
      key: "r3",
      name: "On push",
      instruction: "Do it",
      active: true,
      timezone: "America/Sao_Paulo",
      eventType: "push",
    },
  ]);
  expect(otto).toMatchObject({ key: "otto-ofertas", files: null, skills: [] });
  // Members that came along only; a channel with none of them is left; an archived one says so.
  expect(manifest.channels.map((c: { name: string }) => c.name)).toEqual(["Launch", "Old"]);
  expect(manifest.channels[0]).toMatchObject({
    key: "launch",
    members: ["scout", "otto-ofertas"],
    lead: "scout",
    archived: false,
    memories: ["Launch is on Friday"],
  });
  expect(manifest.channels[1].archived).toBe(true);
  expect(manifest.settings.mcpServers).toEqual([
    {
      id: "s1",
      name: "HubSpot",
      transport: "http",
      enabled: true,
      command: "",
      args: [],
      env: [],
      envPassthrough: [],
      workingDirectory: "",
      url: "https://mcp.example.com",
      headers: [],
    },
  ]);
});

/** A zip with deflated entries, as an app writes one (the runner itself only stores). */
function deflatedZip(entries: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const dir: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = new TextEncoder().encode(text);
    const packed = new Uint8Array(deflateRawSync(raw));
    const encoded = new TextEncoder().encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, 8, true);
    local.setUint32(14, crc32(raw), true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, encoded.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(10, 8, true);
    central.setUint32(16, crc32(raw), true);
    central.setUint32(20, packed.length, true);
    central.setUint32(24, raw.length, true);
    central.setUint16(28, encoded.length, true);
    central.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), encoded, packed);
    dir.push(new Uint8Array(central.buffer), encoded);
    offset += 30 + encoded.length + packed.length;
  }
  const count = Object.keys(entries).length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(
    12,
    dir.reduce((sum, d) => sum + d.length, 0),
    true,
  );
  end.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...parts, ...dir, new Uint8Array(end.buffer)]));
}

test("a zip in hand: deflated or stored, a name that climbs out left out, a file past the limit too", () => {
  const zip = deflatedZip({ "SKILL.md": "---\nname: x\n---\nHi", "../out.md": "no", "big.md": "x".repeat(50) });
  const files = readZip(zip, 40);
  expect([...(files?.keys() ?? [])]).toEqual(["SKILL.md"]);
  expect(new TextDecoder().decode(files?.get("SKILL.md"))).toBe("---\nname: x\n---\nHi");
  expect(readZip(new TextEncoder().encode("not a zip"), 40)).toBeNull();
});

test("workflows, answers handed on, the library's skills and messaging connections come too", async () => {
  const home = temp();
  const data = openbot(home);
  const db = new Database(path.join(data, "openbot.db"));
  db.exec(`
    CREATE TABLE workflows (workflow_id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE workflow_nodes (workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL, x REAL NOT NULL,
      y REAL NOT NULL, fields_json TEXT NOT NULL, schedule_json TEXT, position INTEGER NOT NULL);
    CREATE TABLE workflow_edges (workflow_id TEXT NOT NULL, edge_id TEXT NOT NULL, from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL, port_type TEXT NOT NULL, branch TEXT, position INTEGER NOT NULL);
    CREATE TABLE routine_flow_links (link_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL, instruction TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE projection_messaging_connections (connection_id TEXT PRIMARY KEY, platform TEXT NOT NULL,
      workspace_name TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  db.run("INSERT INTO workflows VALUES ('w1', 'Weekly prices', '1'), ('w2', '  ', '2')");
  const node = (id: string, kind: string, fields: object, at: number, schedule?: object) =>
    db.run("INSERT INTO workflow_nodes VALUES ('w1', ?, ?, ?, 0, ?, ?, ?)", [
      id,
      kind,
      at * 100,
      JSON.stringify(fields),
      schedule ? JSON.stringify(schedule) : null,
      at,
    ]);
  node("t", "trigger", { trigger: "schedule", timezone: "UTC" }, 0, { kind: "weekly", weekday: 1, time: "09:00" });
  node("a", "agent", { agentId: "a2", task: "Write the offer" }, 1);
  node("l", "llm", { prompt: "Sum it up", apiKey: "sk-live-abcdefghijklmnop" }, 2);
  node("o", "output", { target: "chat-channel", channelId: "c1" }, 3);
  node("s", "output", { target: "slack", connectionId: "conn-7", action: "post" }, 4);
  const edge = (id: string, from: string, to: string, at: number) =>
    db.run("INSERT INTO workflow_edges VALUES ('w1', ?, ?, ?, 'text', NULL, ?)", [id, from, to, at]);
  edge("e1", "t", "a", 0);
  edge("e2", "a", "l", 1);
  edge("e3", "l", "o", 2);
  edge("e4", "l", "s", 3);
  db.run("INSERT INTO routine_flow_links VALUES ('k1', 'r1', 'a1', 'a2', 'Turn it into an offer', '1')");
  db.run("INSERT INTO routine_flow_links VALUES ('k2', 'r1', 'a1', 'gone', 'Nobody', '2')");
  db.run("INSERT INTO projection_messaging_connections VALUES ('mc1', 'whatsapp', 'Support line', '1')");
  db.close();
  // The library keeps each skill zipped, a folder per revision: only the latest comes, and the app's own never.
  const library = path.join(data, "local-skills");
  mkdirSync(path.join(library, "lib-1", "1"), { recursive: true });
  mkdirSync(path.join(library, "lib-1", "2"), { recursive: true });
  mkdirSync(path.join(library, "lib-2", "1"), { recursive: true });
  writeFileSync(path.join(library, "lib-1", "1", "bundle.zip"), deflatedZip({ "SKILL.md": "---\nname: Old\n---\n" }));
  writeFileSync(
    path.join(library, "lib-1", "2", "bundle.zip"),
    deflatedZip({
      "SKILL.md": "---\nname: Price check\n---\nCompare the prices.",
      "notes.md": "Use EUR.",
      ".env": "TOKEN=sk-live-zzzzzzzzzzzzzzzz",
      "../escape.md": "no",
    }),
  );
  writeFileSync(
    path.join(library, "lib-2", "1", "bundle.zip"),
    deflatedZip({ "SKILL.md": "---\nname: openbot-data\n---\n" }),
  );

  const run = io(home);
  expect(await migrate({ from: "openbot", out: home, json: true, noFiles: true }, run.io)).toBe(0);
  const result = JSON.parse(run.out.join("")) as { counts: Record<string, number> };
  expect(result.counts).toMatchObject({ workflows: 1, skills: 2 });
  const zip = unzip(path.join(home, "agentes-chat-import-openbot.zip"));
  expect([...zip.keys()].sort()).toEqual([
    "agents/scout/skills/research/SKILL.md",
    "library/price-check/SKILL.md",
    "library/price-check/notes.md",
    "openbot-transfer.json",
  ]);
  const text = new TextDecoder().decode(zip.get("openbot-transfer.json"));
  expect(text).not.toContain("sk-live");
  expect(text).not.toContain("conn-7");
  const manifest = JSON.parse(text);
  // Agents and channels by their keys in the file; a messaging connection emptied, so it is chosen again.
  expect(manifest.settings.workflows).toEqual([
    {
      title: "Weekly prices",
      graph: {
        nodes: [
          {
            id: "t",
            kind: "trigger",
            at: { x: 0, y: 0 },
            fields: { trigger: "schedule", timezone: "UTC" },
            schedule: { kind: "weekly", weekday: 1, time: "09:00" },
          },
          {
            id: "a",
            kind: "agent",
            at: { x: 100, y: 0 },
            fields: { agentId: "otto-ofertas", task: "Write the offer" },
          },
          { id: "l", kind: "llm", at: { x: 200, y: 0 }, fields: { prompt: "Sum it up", apiKey: "" } },
          { id: "o", kind: "output", at: { x: 300, y: 0 }, fields: { target: "chat-channel", channelId: "launch" } },
          {
            id: "s",
            kind: "output",
            at: { x: 400, y: 0 },
            fields: { target: "slack", connectionId: "", action: "post" },
          },
        ],
        edges: [
          { id: "e1", from: "t", to: "a", type: "text" },
          { id: "e2", from: "a", to: "l", type: "text" },
          { id: "e3", from: "l", to: "o", type: "text" },
          { id: "e4", from: "l", to: "s", type: "text" },
        ],
        strokes: [],
      },
      relink: true,
    },
  ]);
  expect(manifest.settings.routineFlows).toEqual([
    { routineKey: "r1", fromAgentKey: "scout", toAgentKey: "otto-ofertas", instruction: "Turn it into an offer" },
  ]);
  expect(manifest.settings.messagingConnections).toEqual([{ platform: "whatsapp", name: "Support line" }]);
  expect(manifest.sharedSkills).toEqual([
    { slug: "price-check", name: "Price check", path: "library/price-check", files: ["notes.md", "SKILL.md"] },
  ]);
});

test("--no-files leaves the workspaces, and the skills still come", async () => {
  const home = temp();
  openbot(home);
  const run = io(home);
  expect(await migrate({ from: "openbot", out: home, json: true, noFiles: true }, run.io)).toBe(0);
  const zip = unzip(path.join(home, "agentes-chat-import-openbot.zip"));
  expect([...zip.keys()].sort()).toEqual(["agents/scout/skills/research/SKILL.md", "openbot-transfer.json"]);
});

test("with no terminal it asks nothing: the only app found, into Downloads", async () => {
  const home = temp();
  openbot(home);
  mkdirSync(path.join(home, "Downloads"));
  const run = io(home);
  expect(await migrate({ json: false, noFiles: false }, run.io)).toBe(0);
  expect(existsSync(path.join(home, "Downloads", "agentes-chat-import-openbot.zip"))).toBe(true);
  expect(run.out.join("\n")).toContain("2 agents · 3 routines · 2 memories · 1 skill · 1 channel");
  expect(run.out.join("\n")).toContain("Nothing was sent.");
});

test("what can't be done says why, with the exit code for it", async () => {
  const home = temp();
  const none = io(home);
  expect(await migrate({ json: true, noFiles: false }, none.io)).toBe(3);
  expect(JSON.parse(none.out.join(""))).toMatchObject({ ok: false, code: "not_found", exitCode: 3 });

  const wrong = io(home);
  expect(await migrate({ from: "notion", json: false, noFiles: false }, wrong.io)).toBe(2);
  expect(wrong.err.join("")).toContain("--from takes one of");

  // Two apps there and nobody to ask: it names them.
  openbot(home);
  mkdirSync(path.join(home, ".hermes"));
  const two = io(home);
  expect(await migrate({ json: false, noFiles: false }, two.io)).toBe(2);
  expect(two.err.join("")).toContain("Found openbot, hermes");

  // A database from a version that keeps its agents elsewhere: the app's own export is the way.
  const other = temp();
  mkdirSync(path.join(other, ".config", "OpenBot"), { recursive: true });
  new Database(path.join(other, ".config", "OpenBot", "openbot.db")).exec("CREATE TABLE something (id TEXT)");
  const old = io(other);
  expect(await migrate({ from: "openbot", out: other, json: false, noFiles: false }, old.io)).toBe(1);
  expect(old.err.join("")).toContain("Server settings › Transfer");
});

test("on a terminal it asks which app and where to save", async () => {
  const home = temp();
  openbot(home);
  mkdirSync(path.join(home, ".hermes", "skills", "notes"), { recursive: true });
  writeFileSync(path.join(home, ".hermes", "SOUL.md"), "You are kind.");
  writeFileSync(
    path.join(home, ".hermes", "config.yaml"),
    "model: gpt\nmcp_servers:\n  crm:\n    url: https://crm.example\n    headers:\n      Authorization: Bearer abc123\n",
  );
  writeFileSync(path.join(home, ".hermes", ".env"), "OPENAI_API_KEY=sk-123");
  writeFileSync(path.join(home, ".hermes", "skills", "notes", "SKILL.md"), "---\nname: notes\n---\n");
  mkdirSync(path.join(home, ".hermes", "memories"));
  writeFileSync(path.join(home, ".hermes", "memories", "MEMORY.md"), "One§Two");
  const asked: string[] = [];
  const answers = ["2", "~/exports"];
  const run = io(home, {
    interactive: true,
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
  });
  expect(await migrate({ json: false, noFiles: false }, run.io)).toBe(0);
  expect(asked).toEqual(["Which one? (1-2) ", "Where to save? (~) "]);
  const zip = unzip(path.join(home, "exports", "agentes-chat-import-hermes.zip"));
  expect([...zip.keys()].sort()).toEqual([
    ".hermes/SOUL.md",
    ".hermes/config.yaml",
    ".hermes/memories/MEMORY.md",
    ".hermes/skills/notes/SKILL.md",
  ]);
  const config = new TextDecoder().decode(zip.get(".hermes/config.yaml"));
  expect(config).toContain("url: https://crm.example");
  expect(config).not.toContain("abc123");
  expect(run.out.join("\n")).toContain("1 agent · 2 memories · 1 skill");
});

test("settings keep their shape and lose what can be a credential", () => {
  expect(
    scrubSettings('{ "botToken": "123:abc", "name": "bot", gateway: { auth: { mode: "token", token: \'t0p\' } } }'),
  ).toBe('{ "botToken": "", "name": "bot", gateway: { auth: { mode: "token", token: "" } } }');
  expect(scrubSettings("api_key: sk-live-1\nmodel: gpt\nurl: https://me:pw@host.example/x\n")).toBe(
    'api_key: ""\nmodel: gpt\nurl: https://host.example/x\n',
  );
});

test("an agent's key is its name, the same every time, and never twice", () => {
  const taken = new Set<string>();
  expect(keyOf("Otávio Ofertas", taken, "agent")).toBe("otavio-ofertas");
  expect(keyOf("otavio ofertas!", taken, "agent")).toBe("otavio-ofertas-2");
  expect(keyOf("日本", taken, "agent")).toBe("agent");
});

test("the scripts run the command once from a temporary folder, against this server", () => {
  const sh = migrateScript("https://app.example/");
  expect(sh).toContain("SERVER='https://app.example'");
  expect(sh).toContain('"$SERVER/runner/agentes-runner.mjs"');
  expect(sh).toContain('migrate "$@"');
  expect(sh.trimEnd().endsWith('main "$@"')).toBe(true);
  expect(spawnSync("sh", ["-n"], { input: sh }).status).toBe(0);
  const ps = migrateScriptPowerShell("https://app.example");
  expect(ps).toContain("$Server = 'https://app.example'");
  expect(ps).toContain("$Pass = @('migrate')");
  expect(ps).not.toMatch(/^exit /m);
});
