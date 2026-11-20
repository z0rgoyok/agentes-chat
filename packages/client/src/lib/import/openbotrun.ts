import {
  atTime,
  baseName,
  cronOf,
  cronTrigger,
  type Draft,
  everyMinutes,
  type FlowStep,
  ImportError,
  type ImportFile,
  join,
  jsonOf,
  list,
  num,
  obj,
  onceAt,
  slug,
  str,
  type Trigger,
} from "./shared";

/**
 * OpenBot.run (Synthetify Labs, github.com/nightly-labs/openbot), read from
 * its documented formats only:
 * - `openbot-import.json` (`openbot-agent-import` v1), the archive "Migrator
 *   by OpenBot" writes for Grok Bot users (its skill:
 *   `resources/agent-import/grok-bot/SKILL.md`): agents with instructions,
 *   skill folders, routines and memories; group chats; optional files.
 * - `openbot-transfer.json` (`openbot-instance-transfer` v1), a server's
 *   transfer file (`docs/architecture/agents.md`, "Instance transfer"): the
 *   same per agent plus its model, and the server's MCP servers with every
 *   value already emptied. `agentes-runner migrate --from openbot` writes this
 *   format too, from the app's own database.
 * Agent paths are always inside `agents/<key>/`. A routine a webhook starts gets an address of its own here (to give
 * the app that called the old one); a workflow becomes a routine or a skill (`workflow`); what hands a routine's
 * answer to another agent is said at the end of its request; a messaging connection has nothing to connect to here.
 */

const IMPORT = "openbot-agent-import";
const TRANSFER = "openbot-instance-transfer";
const APPS: Record<string, string> = { "grok-bot": "Grok Bot" };

/**
 * The colour the app draws an agent in (`packages/brand/src/bloub-avatar.ts`, on its avatar library's palette): its
 * own `avatarColor` (`#rrggbb`), else its hue's (one of ten), else the one its seed picks among eight (FNV-1a of
 * `<seed>:color`). The face itself is the app's own drawing: here the agent gets a face of ours, in that colour.
 */
const PALETTE = {
  red: "#e8483f",
  orange: "#f08a24",
  amber: "#f0b429",
  green: "#3ecf8e",
  turquoise: "#2fbfa0",
  blue: "#3b93f0",
  violet: "#8b5cf6",
  pink: "#e152b0",
} as const;
const HUE_COLORS: Record<number, `#${string}`> = {
  0: PALETTE.red,
  30: PALETTE.orange,
  55: PALETTE.amber,
  100: "#8ece34",
  150: PALETTE.green,
  185: PALETTE.turquoise,
  215: PALETTE.blue,
  245: "#5d67ee",
  280: PALETTE.violet,
  320: PALETTE.pink,
};
const SEED_COLORS = Object.values(PALETTE);
const HEX = /^#[0-9a-f]{6}$/i;

export function openbotColor(agent: Record<string, unknown>): `#${string}` | undefined {
  const own = str(agent.avatarColor);
  if (HEX.test(own)) return own.toLowerCase() as `#${string}`;
  const hue = typeof agent.avatarHue === "number" ? HUE_COLORS[agent.avatarHue] : undefined;
  if (hue) return hue;
  const seed = str(agent.avatarSeed);
  if (!seed) return undefined;
  const value = `${seed}:color`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return SEED_COLORS[(hash >>> 0) % SEED_COLORS.length];
}

function manifest(files: ImportFile[]) {
  for (const file of files) {
    const doc = jsonOf(file);
    if (doc && (doc.format === IMPORT || doc.format === TRANSFER)) return { file, doc };
  }
  return null;
}

export const detect = (files: ImportFile[]) => manifest(files) !== null;

export function parse(files: ImportFile[], d: Draft) {
  const found = manifest(files);
  if (!found) throw new ImportError("unknown");
  const { file, doc } = found;
  if (doc.version !== 1) throw new ImportError("newerVersion");
  d.used.add(file.name);
  const source = obj(doc.source);
  const app = str(source.app);
  const transfer = doc.format === TRANSFER;
  // A transfer names no app; its server may have a name of its own.
  d.name = APPS[app] ?? (app || (transfer ? str(obj(doc.serverIdentity).name) || "OpenBot" : ""));
  d.ref = app || "openbot";

  const names = new Map<string, string>();
  // The routines by their key in the file, for what hands their answer on.
  const from = new Map<string, string>();
  for (const a of list(doc.agents).map(obj)) {
    const key = str(a.key);
    const name = str(a.name) || key;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(key)) continue;
    names.set(key, name);
    const folder = (path: unknown) => {
      const p = str(path).replace(/\/+$/, "");
      return p.startsWith(`agents/${key}/`) ? p : "";
    };
    // Instructions longer than the manifest allows are written whole to files/INSTRUCTIONS.md.
    const files = folder(a.files);
    const full = files ? d.file(`${files}/INSTRUCTIONS.md`)?.text : undefined;
    const skills = list(a.skills).flatMap((path) => {
      const k = d.skillDir(folder(path), baseName(str(path)) || str(path));
      return k ? [k] : [];
    });
    d.agent({
      key,
      name,
      role: str(a.title),
      instructions: full?.trim() || str(a.description),
      ...(transfer ? { model: [str(a.provider), str(a.model)].filter(Boolean).join("/") } : {}),
      seed: str(a.avatarSeed) || key,
      color: openbotColor(a),
      skills,
    });
    if (folder(a.avatar)) {
      d.used.add(folder(a.avatar));
      d.left("picture", name);
    }
    // The rest of the folder is the agent's own files: they can go to its folder in the Drive.
    if (files) d.filesIn(key, files);
    for (const r of [...list(a.routines), ...list(a.oneTimeRoutines)].map(obj)) routine(r, key, null, name, d, from);
    for (const r of list(a.webhookRoutines).map(obj)) routine(r, key, null, name, d, from, true);
    list(a.memories).forEach((m, i) => {
      d.note({ key: `${key}/memory-${i + 1}`, agent: key, kind: "fact", content: str(m) || str(obj(m).text) });
    });
  }

  for (const c of list(doc.channels).map(obj)) {
    const key = str(c.key);
    const members = list(c.members)
      .map(str)
      .filter((k) => names.has(k));
    // An archived channel is one the person put away.
    if (!key || members.length === 0 || c.archived === true) continue;
    const lead = members.includes(str(c.lead)) ? str(c.lead) : "";
    // A group chat with a lead answers through it; without one, every member may answer.
    d.channel({
      key,
      name: str(c.name) || key,
      topic: join([str(c.title), str(c.instructions)]),
      agents: members.map((k) => ({ key: k, autoReply: !lead || k === lead })),
    });
    const runs = lead || (members[0] as string);
    for (const r of list(c.routines).map(obj)) routine(r, runs, key, str(c.name) || key, d, from);
    for (const r of list(c.webhookRoutines).map(obj)) routine(r, runs, key, str(c.name) || key, d, from, true);
    list(c.memories).forEach((m, i) => {
      d.note({ key: `${key}/memory-${i + 1}`, agent: null, kind: "fact", content: str(m) });
    });
  }

  // The server's shared skills that no agent had (`library/<slug>/`): they come too, on for nobody.
  for (const s of list(doc.sharedSkills).map(obj)) {
    const dir = str(s.path).replace(/\/+$/, "");
    if (dir.startsWith("library/")) d.skillDir(dir, str(s.slug) || baseName(dir));
  }

  const settings = obj(doc.settings);
  for (const server of list(settings.mcpServers).map(obj)) {
    const http = str(server.transport) === "http";
    d.connection(str(server.name) || str(server.id), http ? str(server.url) : "");
  }
  for (const p of list(settings.customProviders).map(obj)) d.left("model", str(p.name) || str(p.id));
  for (const a of list(settings.customAgents).map(obj)) d.left("remote", str(a.name) || str(a.id));
  for (const w of list(settings.workflows).map(obj)) workflow(w, d);
  // A routine that handed its answer to another agent says so at the end of its request.
  for (const f of list(settings.routineFlows).map(obj)) {
    const key = from.get(str(f.routineKey));
    const r = d.routines.find((x) => x.key === key);
    const to = d.agents.find((a) => a.key === str(f.toAgentKey));
    if (!r || !to || to.key === r.agent) continue;
    const instruction = str(f.instruction);
    const words = instruction
      ? d.say("pass", { handle: to.handle, instruction })
      : d.say("passPlain", { handle: to.handle });
    r.prompt = join([r.prompt, words]);
    d.passes.set(r.key, [...new Set([...(d.passes.get(r.key) ?? []), to.key])]);
  }
  // A messaging connection (written by `agentes-runner migrate`) has nothing to connect to here.
  for (const m of list(settings.messagingConnections).map(obj)) {
    d.left("messaging", [str(m.platform), str(m.name)].filter(Boolean).join(": "));
  }
}

/**
 * A routine of an agent or of a group chat. One a webhook starts gets an address of its own here: the person gives it
 * to whatever called the old one.
 */
function routine(
  r: Record<string, unknown>,
  agent: string,
  channel: string | null,
  owner: string,
  d: Draft,
  from: Map<string, string>,
  webhook = false,
) {
  const name = str(r.name);
  const key = d.routine({
    key: `${channel ?? agent}/${str(r.key) || slug(name)}`,
    name,
    agent,
    prompt: str(r.instruction),
    channel,
    trigger: webhook ? { webhook: true } : schedule(obj(r.schedule), str(r.timezone) || null),
    label: `${name} (${owner})`,
    paused: r.active === false,
  });
  if (!key) return;
  if (str(r.key)) from.set(str(r.key), key);
  if (webhook) d.need("webhook", name || key, [agent]);
}

// ── Workflows ─────────────────────────────────────────────────────────────────

/** Steps that only draw on the canvas: they do nothing when the workflow runs. */
const DRAWN = new Set(["text", "note", "shape"]);
const MESSAGING: Record<string, "slack" | "discord" | "telegram"> = {
  slack: "slack",
  discord: "discord",
  telegram: "telegram",
};

/**
 * A workflow (`settings.workflows`; `packages/contracts/src/ipc-workflows.ts` in the app): steps on a canvas that a
 * trigger starts. Here a routine is one agent and one request, and no routine starts another (ADR 0053), so the
 * workflow becomes the request of a routine of its first agent, written step by step: another agent's step is asked
 * of that agent, a condition reads "if…, go on; otherwise…", an approval is asked in the chat, and the output says
 * where the answer goes. Its trigger is the routine's when: a schedule, the routine's own address, or a pull request
 * opened. One started by hand, or by something with no match here, becomes a skill of that agent instead, which runs
 * when someone asks.
 */
function workflow(w: Record<string, unknown>, d: Draft) {
  const title = str(w.title);
  const graph = obj(w.graph);
  const nodes = list(graph.nodes)
    .map(obj)
    .filter((n) => str(n.id) && !DRAWN.has(str(n.kind)));
  const edges = list(graph.edges).map(obj);
  if (!title || nodes.length === 0) return;
  const byId = new Map(nodes.map((n) => [str(n.id), n]));
  const known = (key: string) => d.agents.some((a) => a.key === key);

  // The first trigger that something here can fire, else the first one (or none: started by hand).
  const triggers = nodes.filter((n) => str(n.kind) === "trigger");
  let start: Record<string, unknown> | undefined;
  let trigger: Trigger | null = null;
  let repos: string[] = [];
  for (const n of triggers) {
    const f = obj(n.fields);
    const kind = str(f.trigger);
    if (kind === "schedule") trigger = schedule(obj(n.schedule), str(f.timezone) || null);
    else if (kind === "webhook") trigger = { webhook: true };
    else if (kind === "github" && str(f.event) === "pr.opened") {
      trigger = { event: "github.pr_opened" };
      repos = [...new Set([...str(f.repositories).split(/\s*\n\s*/), str(f.repository)].filter(Boolean))];
    }
    if (trigger) {
      start = n;
      break;
    }
  }
  const was = trigger ? null : str(obj(triggers[0]?.fields).trigger) || "manual";
  start ??= triggers[0];

  // Its steps from the trigger (or from the steps nothing leads to), the "yes" of a condition first.
  const seen = new Set<string>();
  const next = (id: string, branch?: "yes" | "no") =>
    edges
      .filter((e) => str(e.from) === id && (!branch || (branch === "no") === (str(e.branch) === "no")))
      .map((e) => str(e.to));
  const roots = start
    ? next(str(start.id))
    : nodes.filter((n) => !edges.some((e) => str(e.to) === str(n.id))).map((n) => str(n.id));
  if (start) seen.add(str(start.id));
  const walk = (from: string[]): FlowStep[] => {
    const steps: FlowStep[] = [];
    const later: { step: Extract<FlowStep, { kind: "if" }>; no: string[] }[] = [];
    const queue = [...from];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const n = byId.get(id);
      if (seen.has(id) || !n) continue;
      seen.add(id);
      const f = obj(n.fields);
      switch (str(n.kind)) {
        case "condition": {
          const step = { kind: "if" as const, rule: str(f.rule), otherwise: [] as FlowStep[] };
          steps.push(step);
          later.push({ step, no: next(id, "no") });
          queue.push(...next(id, "yes"));
          continue;
        }
        case "prompt":
          if (str(f.text)) steps.push({ kind: "text", text: str(f.text) });
          break;
        case "agent":
          steps.push({ kind: "do", agent: str(f.agentId), task: str(f.task) });
          break;
        case "llm": {
          const keep = str(f.system) ? d.say("keep", { text: str(f.system) }) : "";
          steps.push({ kind: "do", agent: "", task: [str(f.prompt), keep].filter(Boolean).join(" ") });
          break;
        }
        case "image":
          steps.push({ kind: "media", media: str(f.media) === "video" ? "video" : "image", prompt: str(f.prompt) });
          break;
        case "asset":
          steps.push({ kind: "lost", what: "file" });
          break;
        case "approval":
          steps.push({ kind: "approval", question: str(f.question) });
          break;
        case "output": {
          const target = str(f.target);
          // A channel that didn't come: the answer goes to the person instead.
          if (target === "chat-channel" && d.channels.some((c) => c.key === str(f.channelId)))
            steps.push({ kind: "post", to: "channel", channel: str(f.channelId) });
          else if (target === "chat-channel") steps.push({ kind: "post", to: "notify" });
          else if (target === "notify" || target === "file") steps.push({ kind: "post", to: target });
          else if (target === "github") steps.push({ kind: "post", to: "github", action: str(f.action) });
          else steps.push({ kind: "lost", what: MESSAGING[target] ?? "messaging" });
          break;
        }
      }
      queue.push(...next(id));
    }
    // A "no" leads to what the "yes" didn't already take.
    for (const { step, no } of later) step.otherwise = walk(no);
    return steps;
  };
  const steps = walk(roots);

  // The routine's agent: the first one whose step comes, else the team's first.
  const all = (list: FlowStep[]): FlowStep[] => list.flatMap((s) => (s.kind === "if" ? [s, ...all(s.otherwise)] : [s]));
  const agent =
    all(steps).find((s): s is Extract<FlowStep, { kind: "do" }> => s.kind === "do" && known(s.agent))?.agent ??
    d.agents[0]?.key;
  if (!agent || steps.length === 0) {
    d.left("routine", title);
    return;
  }
  // Every step it does itself, or asks another agent for.
  const own = (list: FlowStep[]): FlowStep[] =>
    list.map((s) =>
      s.kind === "do"
        ? known(s.agent) && s.agent !== agent
          ? { ...s, by: agent }
          : { ...s, agent }
        : s.kind === "if"
          ? { ...s, otherwise: own(s.otherwise) }
          : s,
    );
  const final = own(steps);
  const posts = all(final).filter((s): s is Extract<FlowStep, { kind: "post" }> => s.kind === "post");
  const channel = posts.find((s) => s.to === "channel")?.channel ?? null;
  if (posts.some((s) => s.to === "github") || (trigger !== null && "event" in trigger)) {
    d.need("app", "GitHub", [agent]);
  }
  // Posting to a messaging app has no match here: the step stays out of the request, and is listed.
  for (const s of all(final)) if (s.kind === "lost" && s.what !== "file") d.left("other", `${title} (${s.what})`);

  const app = d.name || "OpenBot";
  const request = requestOf(final, d, 0).join("\n");
  if (trigger) {
    const opening =
      "webhook" in trigger
        ? d.say("webhook")
        : "event" in trigger
          ? repos.length
            ? d.say("prIn", { repos: repos.join(", ") })
            : d.say("pr")
          : "";
    const key = d.routine({
      key: `workflow/${slug(title) || "routine"}`,
      name: title,
      agent,
      prompt: join([d.say("intro", { title, app }), opening, request]),
      channel,
      trigger,
    });
    if (!key) return;
    if ("webhook" in trigger) d.need("webhook", title, [agent]);
    d.workflows.push({ item: { kind: "routine", key }, title, agent, was: null, steps: final });
    return;
  }
  const base = slug(title) || "workflow";
  let name = base;
  for (let n = 2; d.skills.some((s) => s.key === name); n++) name = `${base}-${n}`;
  const body = join([was === "manual" ? "" : d.say("asked", { app }), request]);
  const key = d.skill(
    `---\nname: ${name}\ndescription: ${JSON.stringify(d.say("skillAbout", { title, app }))}\n---\n\n${body}\n`,
    name,
  );
  const owner = d.agents.find((a) => a.key === agent);
  if (!key || !owner) return;
  if (!owner.skills.includes(key)) owner.skills.push(key);
  d.workflows.push({ item: { kind: "skill", key }, title, agent, was, steps: final });
}

/** The steps as the request writes them: numbered, what a "no" leads to indented under its condition. */
function requestOf(steps: FlowStep[], d: Draft, depth: number): string[] {
  const handle = (key: string) => d.agents.find((a) => a.key === key)?.handle ?? key;
  const pad = "   ".repeat(depth);
  const lines: string[] = [];
  let n = 0;
  for (const s of steps) {
    let text = "";
    let sub: string[] = [];
    switch (s.kind) {
      case "text":
        text = d.say("text", { text: s.text });
        break;
      case "do":
        text = s.by ? d.say("ask", { handle: handle(s.agent), task: s.task }) : s.task;
        break;
      case "media":
        text = d.say(s.media, { prompt: s.prompt });
        break;
      case "if":
        text = d.say("if", { rule: s.rule });
        if (s.otherwise.length) {
          sub = [`${pad}   ${d.say("otherwise")}`, ...requestOf(s.otherwise, d, depth + 1)];
        } else text = `${text} ${d.say("stop")}`;
        break;
      case "approval":
        text = s.question ? d.say("approval", { question: s.question }) : d.say("approvalPlain");
        break;
      case "post": {
        const channel = d.channels.find((c) => c.key === s.channel);
        text = channel
          ? d.say("channel", { channel: channel.name })
          : s.to === "github"
            ? s.action === "comment"
              ? d.say("githubComment")
              : d.say("githubDo", { action: s.action ?? "" })
            : d.say(s.to === "file" ? "file" : "notify");
        break;
      }
      case "lost":
        break;
    }
    if (!text.trim()) continue;
    n++;
    lines.push(`${pad}${depth ? "-" : `${n}.`} ${text.trim()}`, ...sub);
  }
  return lines;
}

/** `RoutineSchedule` (packages/contracts/src/ipc-routines.ts): times "HH:MM" in the routine's zone, weekdays 0 = Sunday. */
function schedule(s: Record<string, unknown>, timezone: string | null): Trigger | null {
  const time = str(s.time);
  switch (str(s.kind)) {
    case "hourly":
      return cronTrigger(`${num(s.minute) ?? 0} * * * *`, timezone);
    case "daily":
      return atTime(time, timezone);
    case "weekdays":
      return atTime(time, timezone, [1, 2, 3, 4, 5]);
    case "weekly": {
      const day = num(s.weekday) ?? -1;
      return day >= 0 && day <= 6 ? atTime(time, timezone, [day]) : null;
    }
    case "monthly": {
      const day = num(s.day) ?? 0;
      return day >= 1 && day <= 31 ? atTime(time, timezone, [], [day]) : null;
    }
    case "interval": {
      const unit = { minutes: 1, hours: 60, days: 1440 }[str(s.unit)] ?? 0;
      const anchor = Date.parse(str(s.anchorAt));
      return everyMinutes((num(s.amount) ?? 0) * unit, Number.isNaN(anchor) ? null : anchor);
    }
    case "custom":
      return cronTrigger(str(s.expression), timezone);
    case "once":
      return onceAt(str(s.date), time, timezone);
    case "advanced":
      return advanced(s, timezone);
    default:
      return null;
  }
}

function advanced(s: Record<string, unknown>, timezone: string | null): Trigger | null {
  const months = list(s.months).map(Number);
  const days = obj(s.days);
  const t = obj(s.time);
  const picked = list(days.days).map(Number).join(",");
  const [dom, dow] =
    str(days.kind) === "days-of-week" ? ["*", picked] : str(days.kind) === "days-of-month" ? [picked, "*"] : ["*", "*"];
  const month = months.length && months.length < 12 ? months.join(",") : "*";
  let clock = "";
  if (str(t.kind) === "at-time") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(str(t.time));
    if (m) clock = `${Number(m[2])} ${Number(m[1])}`;
  } else if (str(t.kind) === "every") {
    const n = num(t.amount) ?? 0;
    if (str(t.unit) === "minutes" && n > 0 && n < 60 && 60 % n === 0) clock = `*/${n} *`;
    if (str(t.unit) === "hours" && n > 0 && n < 24 && 24 % n === 0) clock = `0 */${n}`;
  }
  const cron = clock && dom && dow ? cronOf(`${clock} ${dom} ${month} ${dow}`) : null;
  return cron ? { cron, timezone } : null;
}
