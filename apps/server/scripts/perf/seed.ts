/**
 * A busy workspace for the desktop app's bench (apps/desktop/scripts/bench.ts, run by the Desktop bench workflow), in
 * a new data folder of `agentes-server` (native mode, its database built in): 40 channels, 12 agents, 15 people, 18
 * DMs, 120 tasks, 88 calendar events and 40 documents, and #general with 2,400 messages over 45 days, 90 threads of 3
 * to 40 replies and a tenth of its messages with pictures and clips. About 12,000 messages in all, made-up names and
 * words only.
 *
 *   bash apps/server/scripts/perf/media.sh <media folder>
 *   bun apps/server/scripts/perf/seed.ts <new data folder> <media folder>
 *
 * The owner signs in with the folder's owner key (`owner-key`, kept as the desktop app keeps its own), and `seed.json`
 * names the workspace and its busiest channel. What a person does goes through the server's API; the bulk of the
 * messages is written straight into the database with the server stopped, and the jobs they queued are dropped, so a
 * server started on the folder has nothing left to do.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, createDatabase, eq, isNull, pgliteUrl, schema, sql } from "@agenteschat/db";
import { insertMessage, openDm, randomToken, sha256 } from "@agenteschat/engine";

const [dir, mediaDir] = process.argv.slice(2);
if (!dir || !mediaDir) {
  console.error("usage: bun apps/server/scripts/perf/seed.ts <new data folder> <media folder>");
  process.exit(2);
}
if (existsSync(dir) && readdirSync(dir).length > 0) {
  console.error(`${dir} isn't empty: the seed makes a new folder`);
  process.exit(2);
}

const PORT = 4310;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = { name: "Ana Souza", email: "ana@example.com" };

// The folder as the desktop app makes its own (local_server.rs `prepare`).
const ownerKey = randomToken(32);
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, "owner-key"), ownerKey, { mode: 0o600 });
const settings = {
  AGENTES_SECRET: randomToken(48),
  PORT: String(PORT),
  PUBLIC_URL: BASE,
  OWNER_KEY_SHA256: sha256(ownerKey),
  TELEMETRY: "off",
};
writeFileSync(
  join(dir, ".env"),
  Object.entries(settings)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(""),
  { mode: 0o600 },
);

/** The server on the folder, from this checkout and with none of this shell's settings; the result stops it. */
async function serve(): Promise<() => Promise<void>> {
  const entry = resolve(import.meta.dir, "../../src/native.ts");
  const server = Bun.spawn([process.execPath, "--no-env-file", entry, "--until-stdin-ends", "--data", dir as string], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LOG_LEVEL: "warn" },
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  const started = Date.now();
  const answers = () =>
    fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2_000) }).then(
      (r) => r.ok,
      () => false,
    );
  while (!(await answers())) {
    if (server.exitCode !== null) throw new Error(`the server stopped (exit ${server.exitCode})`);
    if (Date.now() - started > 180_000) throw new Error("the server didn't answer within 3 minutes");
    await Bun.sleep(500);
  }
  return async () => {
    server.stdin.end();
    const code = await server.exited;
    if (code !== 0) throw new Error(`the server stopped with exit ${code}`);
  };
}

/** Requests as one signed-in person: the cookies kept, a rate limit waited out. */
function session() {
  let cookie = "";
  return async (path: string, init: { method?: string; json?: unknown; form?: FormData } = {}) => {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { origin: BASE, "accept-language": "en" };
      if (cookie) headers.cookie = cookie;
      if (init.json !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(BASE + path, {
        method: init.method ?? (init.json !== undefined || init.form ? "POST" : "GET"),
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
      });
      for (const set of res.headers.getSetCookie()) {
        const [pair = ""] = set.split(";");
        const [name] = pair.split("=");
        cookie = [...cookie.split("; ").filter((p) => p && !p.startsWith(`${name}=`)), pair].join("; ");
      }
      if ((res.status === 429 || res.status === 503) && attempt < 20) {
        await Bun.sleep(Math.max(1, Number(res.headers.get("retry-after") ?? "2")) * 1000);
        continue;
      }
      if (res.status >= 400) throw new Error(`${init.method ?? "POST"} ${path}: ${res.status} ${await res.text()}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
  };
}

// ── Through the API, as people do ──
const stop = await serve();
const owner = session();
const { token } = await owner("/api/auth/owner-key", { json: { key: ownerKey, ...OWNER } });
await owner("/api/auth/sign-in/one-time-token", { json: { token } });
// Set up, as its owner left the onboarding: one never finished opens the onboarding instead of the workspace.
const created = await owner("/api/app/organizations", {
  json: { name: "Acme Labs", context: "Acme Labs builds developer tools. The team ships every week.", finished: true },
});
const orgId: string = created.organization.id;
const generalId: string = created.generalChannelId;
const o = (path: string) => `/api/app/organizations/${orgId}${path}`;

const AGENTS = ["Ada", "Atlas", "Theo", "Nina", "Orion", "Luna", "Milo", "Iris", "Felix", "Vera", "Hugo", "Zara"];
const agentIds: string[] = [];
for (const name of AGENTS) {
  const agent = await owner(o("/agents"), { json: { name, handle: name.toLowerCase(), monthlyBudgetUsd: 50 } });
  agentIds.push(agent.id);
}

const CHANNELS = [
  "engineering",
  "design",
  "product",
  "support",
  "sales",
  "marketing",
  "ops",
  "random",
  "releases",
  "incidents",
  "backend",
  "frontend",
  "mobile",
  "data",
  "infra",
  "security",
  "hiring",
  "finance",
  "legal",
  "docs",
  "growth",
  "partners",
  "qa",
  "research",
  "events",
  "office",
  "announcements",
  "feedback",
  "billing",
  "onboarding",
  "community",
  "ai-lab",
  "perf",
  "api",
  "desktop",
  "website",
  "brand",
  "customers",
  "roadmap",
];
const channelIds = [generalId];
for (const [i, name] of CHANNELS.entries()) {
  const channel = await owner(o("/channels"), {
    json: { name, topic: `Where ${name} happens.`, visibility: i % 9 === 8 ? "private" : "public" },
  });
  channelIds.push(channel.id);
}
// Every agent in #general, two to four in each other channel.
for (const [ci, channelId] of channelIds.entries()) {
  for (const [ai, agentId] of agentIds.entries()) {
    if (ci === 0 || (ai + ci) % 4 === 0) await owner(o(`/channels/${channelId}/members`), { json: { agentId } });
  }
}

// The pictures and clips, on #general.
for (const name of readdirSync(mediaDir)
  .filter((f) => /\.(jpg|png|mp4)$/.test(f))
  .sort()) {
  const type = name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".png") ? "image/png" : "image/jpeg";
  const form = new FormData();
  form.set("file", new File([readFileSync(join(mediaDir, name))], name, { type }));
  form.set("channelId", generalId);
  await owner(o("/artifacts/files"), { form });
}

for (let i = 1; i <= 40; i++) {
  await owner(o("/artifacts"), {
    json: {
      title: `Design note ${i}`,
      channelId: i % 2 ? generalId : null,
      content: {
        kind: "document",
        markdown: `# Design note ${i}\n\n${"A paragraph about the plan. ".repeat(40)}\n\n## Details\n\n- one\n- two\n- three\n`,
      },
    },
  });
}

const TASKS = [
  "Fix the login redirect",
  "Write the release notes",
  "Profile the sidebar",
  "Review the API docs",
  "Ship the new billing page",
];
for (let i = 1; i <= 120; i++) {
  await owner(o("/issues"), {
    json: {
      title: `Task ${i}: ${TASKS[i % TASKS.length]}`,
      description: "Steps to reproduce, what we expect, and what happens instead.\n\n".repeat(3),
      priority: (["low", "normal", "high"] as const)[i % 3],
      labels: [["bug"], ["docs"], ["perf"], ["api"], ["billing"]][i % 5],
    },
  });
}

// The calendar: the last week and the next two, four a day.
const today = new Date();
const EVENTS = ["Standup", "Design review", "1:1", "Planning", "Customer call"];
for (let d = -7; d <= 14; d++) {
  for (let k = 0; k < 4; k++) {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + d, 9 + k * 2));
    await owner(o("/calendar/events"), {
      json: {
        title: EVENTS[(d + k + 20) % EVENTS.length],
        start: start.toISOString(),
        end: new Date(start.getTime() + 45 * 60_000).toISOString(),
        timezone: "UTC",
        participants: [],
      },
    });
  }
}
writeFileSync(join(dir, "seed.json"), `${JSON.stringify({ orgId, channelId: generalId }, null, 2)}\n`);
await stop();
console.log(`seed: ${AGENTS.length} agents, ${channelIds.length} channels, the files and pages through the API`);

// ── Straight into the database, the server stopped ──
const { db, close } = createDatabase({ url: pgliteUrl(join(dir, "db")), poolMax: 1 });
const [ownerRow] = await db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(eq(schema.users.email, OWNER.email));
if (!ownerRow) throw new Error("no owner");
const ana: Person = ownerRow;
const agents = await db
  .select()
  .from(schema.agents)
  .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.deletedAt)));
const channels = await db
  .select()
  .from(schema.channels)
  .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.kind, "channel")));
const files = await db
  .select({
    id: schema.artifacts.id,
    title: schema.artifacts.title,
    version: schema.artifacts.currentVersion,
    width: schema.artifactVersions.width,
    height: schema.artifactVersions.height,
  })
  .from(schema.artifacts)
  .leftJoin(
    schema.artifactVersions,
    and(
      eq(schema.artifactVersions.artifactId, schema.artifacts.id),
      eq(schema.artifactVersions.version, schema.artifacts.currentVersion),
    ),
  )
  .where(
    and(
      eq(schema.artifacts.orgId, orgId),
      eq(schema.artifacts.channelId, generalId),
      eq(schema.artifacts.kind, "file"),
    ),
  );
const docs = await db
  .select({ id: schema.artifacts.id, title: schema.artifacts.title, version: schema.artifacts.currentVersion })
  .from(schema.artifacts)
  .where(
    and(
      eq(schema.artifacts.orgId, orgId),
      eq(schema.artifacts.channelId, generalId),
      eq(schema.artifacts.kind, "document"),
    ),
  );

const PEOPLE = [
  "Bruno Lima",
  "Chen Wei",
  "Divya Rao",
  "Erik Lund",
  "Fatima Zahra",
  "Gabriel Moreno",
  "Hana Sato",
  "Ivan Petrov",
  "Jonas Berg",
  "Kemi Adeyemi",
  "Lucia Ferrari",
  "Maya Cohen",
  "Noah Fischer",
  "Olga Novak",
];
type Person = { id: string };
const people: Person[] = [];
for (const name of PEOPLE) {
  const handle = (name.split(" ")[0] ?? name).toLowerCase();
  const id = `bench_${handle}`;
  await db
    .insert(schema.users)
    .values({ id, name, email: `${handle}@example.com`, emailVerified: true, locale: "en" })
    .onConflictDoNothing();
  await db
    .insert(schema.organizationMembers)
    .values({ orgId, userId: id, role: "member", handle })
    .onConflictDoNothing();
  people.push({ id });
}
for (const channel of channels) {
  for (const [i, person] of people.entries()) {
    if (channel.id !== generalId && (i + channel.name.length) % 3 !== 0) continue;
    await db
      .insert(schema.channelMembers)
      .values({ orgId, channelId: channel.id, userId: person.id })
      .onConflictDoNothing();
  }
}

// The same words every time.
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const SHORT = [
  "ok, on it",
  "nice",
  "can you take a look?",
  "merged",
  "deploying now",
  "thanks!",
  "lgtm 👍",
  "back in 10",
  "where are we on this?",
  "pushed a fix",
  "that worked",
  "I'll check after lunch",
  "agreed",
  "let's ship it",
  "the build is green again",
  "who owns this one?",
  "sounds good to me",
  "+1",
  "on my list for today",
  "done ✅",
];
const PARA = [
  "I looked into the slow page yesterday. Most of the time goes into the first request: it waits for the session, then the list, then the counts. If we start them together we save about a second on a cold load.",
  "Quick update on the release: the migration ran fine on staging, the new billing screen is behind the flag, and the docs are in review. I'd like to cut the tag tomorrow morning unless someone objects.",
  "Feedback from this week, in short: they love the threads, they want search to find files by name, and two teams asked for a way to mute a channel for a day.",
  "Heads up: the CI runner image changed. If your branch fails on the setup step, merge main and push again. Nothing else should be needed.",
];
const code = (n: number) =>
  `Here is the change:\n\n\`\`\`ts\n${Array.from({ length: n }, (_, i) => `export function step${i}(input: number): number {\n  return input * ${i} + ${i % 7};\n}`).join("\n")}\n\`\`\``;
const TABLE = `Summary of what I found:\n\n1. The list re-renders on every keystroke\n2. Images load at full size\n3. The sidebar draws every row\n\n| Screen | Before | After |\n| --- | --- | --- |\n| Channel | 900 ms | 300 ms |\n| Thread | 400 ms | 150 ms |\n\n> Measured on a mid-range laptop.\n\nNext: **windowing** and _thumbnails_. See https://example.com/notes for the details.`;
const body = (who: "person" | "agent") => {
  const r = rand();
  if (who === "agent") {
    if (r < 0.15) return code(3 + Math.floor(rand() * 40));
    if (r < 0.3) return TABLE;
    if (r < 0.75) return `${pick(PARA)}\n\n${pick(PARA)}`;
    return pick(PARA);
  }
  if (r < 0.03) return code(2 + Math.floor(rand() * 6));
  if (r < 0.1) return `@${pick(agents).handle} ${pick(PARA)}`;
  if (r < 0.14) return `@ana ${pick(SHORT)}`;
  if (r < 0.45) return pick(PARA);
  return pick(SHORT);
};

let written = 0;
async function post(
  channelId: string,
  at: Date,
  opts: { threadId?: string; agent?: boolean; from?: Person[]; files?: boolean; agents?: typeof agents } = {},
) {
  const asAgent = opts.agent ?? rand() < 0.4;
  const pool = opts.agents?.length ? opts.agents : agents;
  const meta: Record<string, unknown> = {};
  if (opts.files && files.length > 0) {
    const chosen = new Map<string, (typeof files)[number]>();
    for (let n = rand() < 0.6 ? 1 : 2 + Math.floor(rand() * 3); n > 0; n--) {
      const f = pick(files);
      chosen.set(f.id, f);
    }
    meta.artifacts = [...chosen.values()].map((f) => ({
      id: f.id,
      version: f.version,
      title: f.title,
      ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
    }));
  } else if (opts.files && docs.length > 0) {
    const d = pick(docs);
    meta.artifacts = [{ id: d.id, version: d.version, title: d.title }];
  }
  const message = await insertMessage(db, {
    orgId,
    channelId,
    threadId: opts.threadId ?? null,
    author: asAgent
      ? { type: "agent", agentId: pick(pool).id, runId: null, hop: 0, stretchId: null }
      : { type: "person", userId: pick(opts.from ?? [ana, ...people]).id },
    body: meta.artifacts && rand() < 0.5 ? "" : body(asAgent ? "agent" : "person"),
    meta,
    createdAt: at,
  });
  if (++written % 1000 === 0) console.log(`seed: ${written} messages`);
  return message;
}

const now = Date.now();
const DAY = 86_400_000;

// #general: 45 days, 2,400 messages, a tenth with pictures or clips, a few reactions, 90 threads.
const roots: { id: string; at: number }[] = [];
for (let i = 0; i < 2400; i++) {
  const at = now - 45 * DAY + (i / 2400) * 45 * DAY + Math.floor(rand() * 60_000);
  const message = await post(generalId, new Date(at), { files: rand() < 0.1 });
  if (rand() < 0.04 && roots.length < 90) roots.push({ id: message.id, at });
  if (rand() < 0.15) {
    for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) {
      await db
        .insert(schema.messageReactions)
        .values({
          orgId,
          messageId: message.id,
          userId: pick(people).id,
          reaction: pick(["👍", "🎉", "❤️", "👀", "+1"]),
        })
        .onConflictDoNothing();
    }
  }
}
for (const root of roots) {
  for (let k = 0, replies = 3 + Math.floor(rand() * 37); k < replies; k++) {
    const at = new Date(Math.min(now - 60_000, root.at + (k + 1) * 7 * 60_000));
    await post(generalId, at, { threadId: root.id, files: rand() < 0.05 });
  }
}

// The other channels: 30 to 250 messages over 20 days, from their own agents.
for (const channel of channels) {
  if (channel.id === generalId) continue;
  const members = await db
    .select({ agentId: schema.channelMembers.agentId })
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, channel.id));
  const inChannel = agents.filter((a) => members.some((m) => m.agentId === a.id));
  const count = 30 + Math.floor(rand() * 220);
  for (let i = 0; i < count; i++) {
    const at = now - 20 * DAY + (i / count) * 20 * DAY + Math.floor(rand() * 60_000);
    await post(channel.id, new Date(at), { agents: inChannel, agent: inChannel.length > 0 ? undefined : false });
  }
}

// DMs with every agent and with six people.
for (const agent of agents) {
  const dm = await openDm(db, ana.id, orgId, { agentId: agent.id });
  const count = 40 + Math.floor(rand() * 260);
  for (let i = 0; i < count; i++) {
    const at = new Date(now - 10 * DAY + (i / count) * 10 * DAY);
    await post(dm.id, at, { agent: i % 2 === 1, agents: [agent], from: [ana] });
  }
}
for (const person of people.slice(0, 6)) {
  const dm = await openDm(db, ana.id, orgId, { userId: person.id });
  const count = 30 + Math.floor(rand() * 120);
  for (let i = 0; i < count; i++) {
    const at = new Date(now - 10 * DAY + (i / count) * 10 * DAY);
    await post(dm.id, at, { agent: false, from: [i % 2 ? person : ana] });
  }
}

// Read up to now, except every fifth channel, read up to two days ago.
for (const [i, channel] of channels.entries()) {
  const lastReadAt = new Date(i % 5 === 0 ? now - 2 * DAY : now);
  await db
    .insert(schema.channelReads)
    .values({ orgId, channelId: channel.id, userId: ana.id, lastReadAt })
    .onConflictDoUpdate({ target: [schema.channelReads.channelId, schema.channelReads.userId], set: { lastReadAt } });
}

// Nothing waits to run for what was written here: no agent wakes up, and nothing is indexed for search.
await db.execute(sql`delete from outbox where status = 'pending'`);
await close();
console.log(`seed: ${written} messages written; the folder is ready: ${dir}`);
