import { pathToFileURL } from "node:url";
import { type LiveActivityMessage, PushError, type PushResult, type PushSender } from "@agenteschat/adapters";
import { and, asc, type Database, desc, eq, inArray, isNull, notInArray, rowsOf, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { AGENT_HEARTBEAT_FRESH_MS } from "./agent-status";
import { agentsOnlyIn, anchorsSql, outageIn } from "./agent-work";
import { runAuthority, runAuthorityById } from "./authority";
import { readableChannelIds } from "./channels";
import { LIVE_ACTIVITY_DELAY_MS, noteLiveActivityInUse, queueLiveActivity } from "./live-activity-queue";
import { inboxVisible, type NotificationLatest, type NotificationSource } from "./notifications";
import { listMemberships } from "./organizations";
import { type PushLocale, pushLocale, pushStrings } from "./push-messages";
import { accountClosed } from "./standing";

const { agents, liveActivityDevices, notifications, users } = schema;

/**
 * The agents at work for one person, in their iPhone's Dynamic Island and on its Lock Screen (ADR 0210): one Live
 * Activity per person, never one per agent. It shows the runs they are behind (`authority.ts`), in every workspace they
 * are in, and the requests waiting for them (an approval, a question, a secret: their inbox's "Esperando você", the
 * one record of what waits on a person). The server computes it and sends it to Apple (`live-activity.refresh`): a
 * push-to-start when the phone shows none, an update when what shows changed, "done" and an end once nothing is left.
 */

/** The activity's layout in the app (`expo-widgets`): the content state's `name`. */
export const LIVE_ACTIVITY_NAME = "AgentsActivity";
/** The app's activity attributes' type, which a push-to-start names. */
export const LIVE_ACTIVITY_ATTRIBUTES = "LiveActivityAttributes";
/** Agents shown; the rest are counted (`more`). */
export const LIVE_ACTIVITY_SHOWN = 3;
/** One phone gets at most one update this often, unless the tone changed (a request came or went). */
export const LIVE_ACTIVITY_UPDATE_EVERY_MS = 5000;
/** A push-to-start whose activity never sent its token back is tried again only after this. */
export const LIVE_ACTIVITY_RESTART_AFTER_MS = 10 * 60_000;
/** A started activity's content is dimmed as out of date this long after (until its own token lets us update it). */
export const LIVE_ACTIVITY_START_STALE_MS = 10 * 60_000;
/** An update's content is dimmed this long after, unless sent again: a server that stopped never shows old news. */
export const LIVE_ACTIVITY_STALE_MS = 30 * 60_000;
/** While nothing changes, the same content is sent again this often, so it never goes stale while it is right. */
export const LIVE_ACTIVITY_RESEND_MS = 20 * 60_000;
/** Content sent again (`LIVE_ACTIVITY_RESEND_MS`) is asked once per window this long, however many updates went. */
const RESEND_WINDOW_MS = 5 * 60_000;
/** "Done" stays this long on the Lock Screen after the end. */
export const LIVE_ACTIVITY_DISMISS_MS = 4 * 60_000;
/** Phones kept per person: the oldest go when another registers. */
export const MAX_LIVE_ACTIVITY_DEVICES = 10;

/** The requests waiting for a person that the activity shows, by their inbox kind. */
const ASKS = { approval: "approval", agent_question: "question", secret_request: "secret" } as const;
type AskKind = (typeof ASKS)[keyof typeof ASKS];

/** The words of one agent's line, as data: the language comes in only when the props are made. */
export type LiveActivityStep =
  /** The agent's own words (`set_status`), as it wrote them. */
  | { kind: "own"; text: string }
  /** A line the server picked or a wait (`presence.agent.*`, the apps' own words), with its subject. */
  | { kind: "status"; status: string; subject: string | null }
  | { kind: "working" }
  | { kind: "queued" }
  /** A request: its words (a question's, an approval's why) and its title (an approval's, a secret's name). */
  | { kind: "ask"; text: string | null; title: string | null };

export interface LiveActivityItem {
  /** `working`: a run they are behind; otherwise a request waiting for them. */
  kind: "working" | AskKind;
  agentId: string;
  agentName: string;
  orgId: string;
  /** "#channel", or the workspace's name (a DM, a task's conversation, a place they don't read). */
  where: string;
  /** Where a tap goes; null channel: the workspace. */
  channelId: string | null;
  threadId: string | null;
  messageId: string | null;
  /** Since when, ms since the epoch: a run's start, a request's making. */
  since: number;
  step: LiveActivityStep;
}

/** What a person's activity shows, in order (one item per agent): requests waiting first, then the latest work. */
export interface LiveActivityState {
  items: LiveActivityItem[];
}

export type LiveActivityTone = "working" | "waiting" | "done";

/** The content state's `props` (ADR 0210 §5), sent as a JSON string. */
export interface LiveActivityProps {
  v: 1;
  tone: LiveActivityTone;
  headline: string;
  trailing: string | null;
  agents: {
    id: string;
    name: string;
    face: string | null;
    step: string;
    since: number;
    state: "working" | "waiting" | "done";
    where: string;
  }[];
  more: number;
  url: string;
}

// ── What it shows ────────────────────────────────────────────────────────────

/** Statuses an agent's automatic line takes (`AgentStatusKind`), which the apps word as `presence.agent.*`. */
const LINE_KINDS = new Set([
  "task",
  "routine",
  "mission",
  "channel",
  "browsing",
  "coding",
  "files",
  "wiki",
  "planning",
  "data",
  "mail",
  "connector",
  "computer",
  "work",
]);

type RunRow = {
  run_id: string;
  agent_id: string;
  agent_name: string;
  status: string;
  trigger_message_id: string;
  background: boolean | string;
  steered_by: string | null;
  started_at: string | Date | null;
  created_at: string | Date;
  on_machine: boolean | string;
  outage: boolean | string;
  wait_code: string | null;
  line_run_id: string | null;
  line_source: string | null;
  line_kind: string | null;
  line_subject: string | null;
  line_text: string | null;
  channel_id: string;
  channel_kind: string;
  channel_name: string;
  thread_root_id: string;
  anchor_trigger_id: string;
  placed: boolean | string;
};

const truthy = (v: boolean | string | null | undefined) => v === true || v === "t";
const ms = (v: string | Date | null) => (v === null ? null : new Date(v).getTime());

/** What a run of theirs does now: what it waits on, else its agent's line when it is this run's, else at work. */
function stepOfRun(r: RunRow): LiveActivityStep {
  const status = (s: string, subject: string | null = null): LiveActivityStep => ({
    kind: "status",
    status: s,
    subject,
  });
  if (r.status === "queued") return { kind: "queued" };
  if (r.status === "waiting_approval") return status("waiting_approval");
  if (r.status === "waiting_input") {
    if (truthy(r.outage)) return status("provider_down");
    if (r.wait_code === "plan_limit") return status("waiting_plan");
    if (r.wait_code === "budget") return status("waiting_budget");
    if (r.wait_code === "busy" || r.wait_code === "work_queue") return status("queued_computer");
    if (truthy(r.on_machine) || r.wait_code) return status("waiting_computer");
    return status("waiting_answer");
  }
  // Asking its computer for room from the line.
  if (truthy(r.on_machine)) return status("queued_computer");
  if (r.line_run_id === r.run_id) {
    if (r.line_source === "self" && r.line_text) return { kind: "own", text: r.line_text };
    if (r.line_source === "auto" && r.line_kind && LINE_KINDS.has(r.line_kind))
      return status(r.line_kind, r.line_subject);
  }
  return { kind: "working" };
}

/**
 * The runs still on in a workspace that `userId` is behind, at most one per agent (its latest), with where each shows:
 * up the hand-offs to the conversation the person reads (`anchorsSql`), as the agents' lists show them. A running run
 * whose worker stopped beating doesn't count. One statement, then who is behind each (`runAuthority`, whose walks the
 * server remembers).
 */
async function runsOf(db: Database, userId: string, orgId: string, orgName: string, now: Date) {
  const aliveAfter = new Date(now.getTime() - AGENT_HEARTBEAT_FRESH_MS).toISOString();
  const rows = rowsOf<RunRow>(
    await db.execute(sql`with ${anchorsSql(orgId)}
      select r.id as run_id, r.agent_id, g.name as agent_name, r.status, r.trigger_message_id, r.background,
        coalesce(r.state, r.transcript)->>'steeredBy' as steered_by, r.started_at, r.created_at,
        r.waiting_machine_id is not null as on_machine, ${outageIn("r")} as outage,
        case when coalesce(r.state, r.transcript)->'waitingForBrain'->>'code' = 'usage_pause'
          then (case when coalesce(r.state, r.transcript)->'waitingForBrain'->>'source' = 'budget' then 'budget' else 'plan_limit' end)
          else coalesce(r.state, r.transcript)->'waitingForBrain'->>'code' end as wait_code,
        g.status_run_id as line_run_id, g.status_source as line_source, g.status_kind as line_kind,
        g.status_subject as line_subject, g.status_text as line_text,
        c.id as channel_id, c.kind as channel_kind, c.name as channel_name, a.thread_root_id,
        a.trigger_message_id as anchor_trigger_id,
        (c.archived_at is null and not ${agentsOnlyIn("c")} and not a.background) as placed
      from anchors t
      join agent_runs r on r.id = t.run_id
      join agents g on g.id = r.agent_id
      join agent_runs a on a.id = t.anchor_id
      join channels c on c.id = a.channel_id
      where not r.background
        and not (r.status = 'running' and coalesce(r.heartbeat_at, r.started_at, r.updated_at) < ${aliveAfter}::timestamptz)`),
  );
  const mine: RunRow[] = [];
  for (const r of rows) {
    const authority = await runAuthority(db, {
      id: r.run_id,
      orgId,
      triggerMessageId: r.trigger_message_id,
      background: false,
      transcript: r.steered_by ? { steeredBy: r.steered_by } : null,
    });
    if (authority.personId === userId) mine.push(r);
  }
  const readable = await readableChannelIds(
    db,
    orgId,
    userId,
    mine.filter((r) => truthy(r.placed)).map((r) => r.channel_id),
  );
  const byAgent = new Map<string, LiveActivityItem>();
  for (const r of mine) {
    const since = ms(r.started_at) ?? (ms(r.created_at) as number);
    const placed = truthy(r.placed) && readable.has(r.channel_id);
    const item: LiveActivityItem = {
      kind: "working",
      agentId: r.agent_id,
      agentName: r.agent_name,
      orgId,
      where: placed && r.channel_kind === "channel" ? `#${r.channel_name}` : orgName,
      channelId: placed ? r.channel_id : null,
      threadId: placed && r.thread_root_id !== r.anchor_trigger_id ? r.thread_root_id : null,
      messageId: placed ? r.anchor_trigger_id : null,
      since,
      step: stepOfRun(r),
    };
    const best = byAgent.get(r.agent_id);
    if (!best || item.since > best.since) byAgent.set(r.agent_id, item);
  }
  return [...byAgent.values()];
}

/**
 * The requests waiting for `userId` in a workspace that the activity shows: their inbox's waiting rows of an
 * approval, a question or a secret, by the inbox's own rule (not done, not snoozed, an approval only while they may
 * decide it), asked in a conversation they still read. Their words are what the inbox keeps: never a confidential
 * thread's (ADR 0190), which the inbox keeps empty.
 */
async function asksOf(db: Database, userId: string, orgId: string, orgName: string, now: Date) {
  const rows = await db
    .select({
      kind: notifications.kind,
      actors: notifications.actors,
      source: notifications.source,
      latest: notifications.latest,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(
      and(
        inboxVisible(orgId, userId, now),
        eq(notifications.waiting, true),
        inArray(notifications.kind, Object.keys(ASKS)),
      ),
    )
    .orderBy(asc(notifications.createdAt))
    .limit(100);
  const asked = rows.flatMap((r) => (typeof r.source.channelId === "string" ? [r.source.channelId] : []));
  const readable = await readableChannelIds(db, orgId, userId, asked);
  const out: (Omit<LiveActivityItem, "agentName"> & { agentName: string | null })[] = [];
  for (const r of rows) {
    const asker = r.actors[0];
    if (asker?.type !== "agent") continue;
    const source = r.source as NotificationSource;
    const latest = r.latest as NotificationLatest;
    const channelId = typeof source.channelId === "string" ? source.channelId : null;
    if (channelId && !readable.has(channelId)) continue;
    const clean = (s: string | undefined) => s?.replace(/\s+/g, " ").trim() || null;
    out.push({
      kind: ASKS[r.kind as keyof typeof ASKS],
      agentId: asker.id,
      agentName: null,
      orgId,
      where: source.label && !source.dmId ? `#${source.label}` : orgName,
      channelId,
      threadId: typeof source.threadId === "string" ? source.threadId : null,
      messageId: typeof source.messageId === "string" ? source.messageId : null,
      since: r.createdAt.getTime(),
      step: { kind: "ask", text: clean(latest.text), title: clean(latest.title) },
    });
  }
  return out;
}

/**
 * What `userId`'s Live Activity shows now (ADR 0210 §1): in every workspace they read, the requests waiting for them
 * and the runs they are behind, one item per agent (a request over its work), requests first, then the latest first.
 * Nothing for an account that is closed.
 */
export async function liveActivityStateOf(db: Database, userId: string, now = new Date()): Promise<LiveActivityState> {
  if (await accountClosed(db, userId)) return { items: [] };
  const memberships = (await listMemberships(db, userId)).filter((m) => m.permissions.has("read"));
  const asks: Awaited<ReturnType<typeof asksOf>> = [];
  const working: LiveActivityItem[] = [];
  for (const m of memberships) {
    const [a, w] = await Promise.all([
      asksOf(db, userId, m.orgId, m.orgName, now),
      runsOf(db, userId, m.orgId, m.orgName, now),
    ]);
    asks.push(...a);
    working.push(...w);
  }
  const askerIds = [...new Set(asks.map((a) => a.agentId))];
  const names = new Map(
    askerIds.length > 0
      ? (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, askerIds))).map(
          (a) => [a.id, a.name],
        )
      : [],
  );
  const newest = (a: { since: number }, b: { since: number }) => b.since - a.since;
  const items: LiveActivityItem[] = [];
  const seen = new Set<string>();
  for (const a of asks.sort(newest)) {
    const agentName = names.get(a.agentId);
    if (!agentName || seen.has(a.agentId)) continue;
    seen.add(a.agentId);
    items.push({ ...a, agentName });
  }
  for (const w of working.sort(newest)) {
    if (seen.has(w.agentId)) continue;
    seen.add(w.agentId);
    items.push(w);
  }
  return { items };
}

// ── Its words ────────────────────────────────────────────────────────────────

const clip = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** An agent's face in the app's widgets directory (a path or a `file://` URL), as a `file://` URL. */
export function liveActivityFace(widgetsDir: string, agentId: string): string | null {
  const dir = widgetsDir.trim();
  if (!dir) return null;
  if (dir.startsWith("file://")) return new URL(`faces/${agentId}.png`, dir.endsWith("/") ? dir : `${dir}/`).href;
  if (!dir.startsWith("/")) return null;
  // The trailing slashes off by hand: a regular expression on the app's input could be made to run slow.
  let end = dir.length;
  while (end > 1 && dir.charCodeAt(end - 1) === 47) end--;
  return pathToFileURL(`${dir.slice(0, end)}/faces/${agentId}.png`).href;
}

/** Where a tap on the activity goes: the app's own link to the conversation (ADR 0210 §5). */
export function liveActivityUrl(item: Pick<LiveActivityItem, "orgId" | "channelId" | "threadId" | "messageId">) {
  const q = new URLSearchParams({ org: item.orgId });
  if (item.channelId) {
    q.set("channel", item.channelId);
    if (item.threadId) q.set("thread", item.threadId);
    if (item.messageId) q.set("message", item.messageId);
  }
  return `agenteschat://island?${q.toString()}`;
}

/** One item's line, in `locale`. */
function stepWords(locale: PushLocale, item: LiveActivityItem): string {
  const s = pushStrings(locale);
  const step = item.step;
  switch (step.kind) {
    case "own":
      return step.text;
    case "status":
      return serverText(locale, `presence.agent.${step.status}`, { subject: step.subject ?? "" });
    case "queued":
      return s.liveActivityQueuedStep;
    case "working":
      return s.liveActivityWorkingStep;
    case "ask":
      // An approval's title is the tool's, in English: only English shows it, the others its why (`renderPush`).
      if (item.kind === "approval")
        return (locale === "en" ? (step.title ?? step.text) : step.text) ?? s.liveActivityApprovalStep;
      if (item.kind === "question") return step.text ?? s.liveActivityQuestionStep;
      return step.title ?? step.text ?? s.liveActivitySecretStep;
  }
}

/**
 * The content state's props (ADR 0210 §5) for what `state` holds, in `locale`, with faces in the phone's widgets
 * directory. A request waiting leads ("Iris pede aprovação", "Aprovar?"); otherwise one agent's name and its timer, or
 * how many work. Null when nothing is left (`liveActivityDoneProps` says "done").
 */
export function liveActivityProps(
  state: LiveActivityState,
  options: { locale: PushLocale; widgetsDir: string; now?: Date },
): LiveActivityProps | null {
  const first = state.items[0];
  if (!first) return null;
  const s = pushStrings(options.locale);
  const shown = state.items.slice(0, LIVE_ACTIVITY_SHOWN);
  const name = clip(first.agentName, 40);
  const asks = {
    approval: [s.liveActivityApproval(name), s.liveActivityApprovalShort],
    question: [s.liveActivityQuestion(name), s.liveActivityQuestionShort],
    secret: [s.liveActivitySecret(name), s.liveActivitySecretShort],
  } as const;
  const count = state.items.length;
  const [headline, trailing] =
    first.kind === "working"
      ? count > 1
        ? [s.liveActivityWorking(count), s.liveActivityWorking(count)]
        : [name, null]
      : asks[first.kind];
  return {
    v: 1,
    tone: first.kind === "working" ? "working" : "waiting",
    headline: clip(headline, 60),
    trailing: trailing === null ? null : clip(trailing, 24),
    agents: shown.map((item) => ({
      id: item.agentId,
      name: clip(item.agentName, 40),
      face: liveActivityFace(options.widgetsDir, item.agentId),
      step: clip(stepWords(options.locale, item), 100),
      since: item.since,
      state: item.kind === "working" ? "working" : "waiting",
      where: clip(item.where, 40),
    })),
    more: count - shown.length,
    url: liveActivityUrl(first),
  };
}

/** The last content once nothing is left: the agents it showed, done ("Pronto"), where it pointed. */
export function liveActivityDoneProps(last: LiveActivityProps | null, locale: PushLocale): LiveActivityProps {
  const done = pushStrings(locale).liveActivityDone;
  return {
    v: 1,
    tone: "done",
    headline: done,
    trailing: done,
    agents: (last?.agents ?? []).map((a) => ({ ...a, step: done, state: "done" })),
    more: 0,
    url: last?.url ?? "agenteschat://island",
  };
}

const parseProps = (json: string | null): LiveActivityProps | null => {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as LiveActivityProps;
    return parsed && typeof parsed === "object" && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
};

// ── Phones ───────────────────────────────────────────────────────────────────

/** What `POST /push/live-activity` registers: one app install's tokens, where its faces are, its app and language. */
export interface LiveActivityDeviceInput {
  installId: string;
  /** Absent: unchanged; null: none (the phone gave none). */
  pushToStartToken?: string | null;
  /** The activity running on the phone, with its own token. Absent: unchanged; null: none runs. */
  activity?: { id: string; token: string } | null;
  widgetsDir: string;
  appId?: string | null;
  sandbox?: boolean;
  locale?: string;
}

/**
 * Registers (or refreshes) one of the person's phones for their Live Activity. An activity it names that the server
 * didn't know replaces the one it had (and its start is settled: its token came back); its content goes to it again
 * at the next refresh, which this queues when anything changed (the app registers again every few seconds while it is
 * open). Keeps the newest `MAX_LIVE_ACTIVITY_DEVICES`. False for a closed account.
 */
export async function registerLiveActivityDevice(
  db: Database,
  userId: string,
  input: LiveActivityDeviceInput,
  now = new Date(),
): Promise<boolean> {
  if (await accountClosed(db, userId)) return false;
  const [known] = await db
    .select()
    .from(liveActivityDevices)
    .where(and(eq(liveActivityDevices.userId, userId), eq(liveActivityDevices.installId, input.installId)));
  const fields = {
    widgetsDir: input.widgetsDir,
    ...(input.appId !== undefined ? { appId: input.appId } : {}),
    ...(input.sandbox !== undefined ? { apnsSandbox: input.sandbox } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.pushToStartToken !== undefined ? { pushToStartToken: input.pushToStartToken } : {}),
    updatedAt: now,
  };
  const activity = input.activity;
  // A new activity (or a new token for it): the next refresh sends it everything, whatever was sent before.
  const fresh = activity && (activity.id !== known?.activityId || activity.token !== known?.activityToken);
  const activityFields =
    activity === undefined
      ? {}
      : activity === null
        ? { activityId: null, activityToken: null, lastSent: null, lastSentAt: null }
        : fresh
          ? { activityId: activity.id, activityToken: activity.token, startedAt: null, lastSentAt: null }
          : {};
  if (known) {
    await db
      .update(liveActivityDevices)
      .set({ ...fields, ...activityFields })
      .where(eq(liveActivityDevices.id, known.id));
    const changed =
      known.widgetsDir !== input.widgetsDir ||
      (input.appId !== undefined && input.appId !== known.appId) ||
      (input.sandbox !== undefined && input.sandbox !== known.apnsSandbox) ||
      (Boolean(input.locale) && input.locale !== known.locale) ||
      (input.pushToStartToken !== undefined && input.pushToStartToken !== known.pushToStartToken) ||
      Boolean(fresh) ||
      (activity === null && known.activityId !== null);
    if (changed) await queueLiveActivity(db, userId);
    return true;
  }
  await db
    .insert(liveActivityDevices)
    .values({
      userId,
      installId: input.installId,
      locale: input.locale ?? "en",
      createdAt: now,
      ...fields,
      ...activityFields,
    })
    .onConflictDoUpdate({
      target: [liveActivityDevices.userId, liveActivityDevices.installId],
      set: { ...fields, ...activityFields },
    });
  // A new phone: the oldest beyond the newest ten go, and every process knows one shows a Live Activity now.
  const kept = await db
    .select({ id: liveActivityDevices.id })
    .from(liveActivityDevices)
    .where(eq(liveActivityDevices.userId, userId))
    .orderBy(desc(liveActivityDevices.updatedAt))
    .limit(MAX_LIVE_ACTIVITY_DEVICES);
  await db.delete(liveActivityDevices).where(
    and(
      eq(liveActivityDevices.userId, userId),
      notInArray(
        liveActivityDevices.id,
        kept.map((k) => k.id),
      ),
    ),
  );
  noteLiveActivityInUse();
  await queueLiveActivity(db, userId);
  return true;
}

/** Forgets one of the person's phones (the switch turned off, signing out). Anyone else's are untouched. */
export async function unregisterLiveActivityDevice(db: Database, userId: string, installId: string): Promise<boolean> {
  const rows = await db
    .delete(liveActivityDevices)
    .where(and(eq(liveActivityDevices.userId, userId), eq(liveActivityDevices.installId, installId)))
    .returning({ id: liveActivityDevices.id });
  return rows.length > 0;
}

// ── Sending (job `live-activity.refresh`) ─────────────────────────────────────

export interface LiveActivityDeps {
  db: Database;
  /** The phones' sender: its `sendLiveActivity` reaches Apple (straight or through the push relay). */
  push?: PushSender | null;
  now?: () => Date;
}

type Device = typeof liveActivityDevices.$inferSelect;

const seconds = (t: number) => Math.floor(t / 1000);

/**
 * The row as this refresh read it: a write lands only if what decides a send (its tokens, its start, what was sent and
 * when) is still what it read, so of two refreshes at once only one sends.
 */
const unchanged = (d: Device) => {
  const t = liveActivityDevices;
  return and(
    eq(t.id, d.id),
    d.activityToken === null ? isNull(t.activityToken) : eq(t.activityToken, d.activityToken),
    d.pushToStartToken === null ? isNull(t.pushToStartToken) : eq(t.pushToStartToken, d.pushToStartToken),
    d.startedAt === null ? isNull(t.startedAt) : eq(t.startedAt, d.startedAt),
    d.lastSent === null ? isNull(t.lastSent) : eq(t.lastSent, d.lastSent),
    d.lastSentAt === null ? isNull(t.lastSentAt) : eq(t.lastSentAt, d.lastSentAt),
  );
};

/**
 * The job: `{ userId }` refreshes that person's activity; `{ runId }` (with the job's workspace) the activity of the
 * person behind that run, if a person is.
 */
export async function runLiveActivityJob(
  deps: LiveActivityDeps,
  job: { orgId: string | null; payload: Record<string, unknown> },
) {
  const { userId, runId } = job.payload;
  if (typeof userId === "string") return refreshLiveActivity(deps, userId);
  if (typeof runId !== "string" || !job.orgId) return null;
  const authority = await runAuthorityById(deps.db, job.orgId, runId);
  return authority.kind === "person" ? refreshLiveActivity(deps, authority.personId) : null;
}

/**
 * Sends each of the person's phones what its activity should show now (ADR 0210 §3):
 * - content and the activity's token: an `update` when the content changed (at most one every
 *   `LIVE_ACTIVITY_UPDATE_EVERY_MS` unless the tone changed: a later refresh sends the rest), or the same again once
 *   `LIVE_ACTIVITY_RESEND_MS` old, so it never goes stale while it is right;
 * - content, no activity token, a push-to-start token and no start in `LIVE_ACTIVITY_RESTART_AFTER_MS`: a `start`,
 *   with the system's alert;
 * - nothing left and an activity's token: an `update` saying "done", then an `end` that takes it off in
 *   `LIVE_ACTIVITY_DISMISS_MS`; the activity is forgotten.
 * A token Apple says is gone is cleared. Each write lands only on the row as read, so two refreshes at once send once;
 * what wasn't taken is written back, and a failure that may pass is thrown for the outbox to retry.
 */
export async function refreshLiveActivity(deps: LiveActivityDeps, userId: string) {
  const { db } = deps;
  const send = deps.push?.sendLiveActivity?.bind(deps.push);
  if (!send) return null;
  const devices = await db
    .select({ device: liveActivityDevices, userLocale: users.locale })
    .from(liveActivityDevices)
    .innerJoin(users, eq(users.id, liveActivityDevices.userId))
    .where(eq(liveActivityDevices.userId, userId));
  if (devices.length === 0) return null;
  const now = deps.now?.() ?? new Date();
  const state = await liveActivityStateOf(db, userId, now);
  let sent = 0;
  let later: number | null = null;
  const retry: string[] = [];
  for (const { device, userLocale } of devices) {
    // The person's language (ADR 0122), else the one the phone registered.
    const locale = pushLocale(userLocale, device.locale);
    const plan = planOf(device, state, locale, now);
    if (plan.kind === "later") later = Math.min(later ?? plan.at, plan.at);
    if (plan.kind === "later" || plan.kind === "none") continue;
    const [claimed] = await db
      .update(liveActivityDevices)
      .set({ ...plan.write, updatedAt: now })
      .where(unchanged(device))
      .returning();
    // Another refresh wrote it first: that one sends.
    if (!claimed) continue;
    let results: PushResult[];
    try {
      results = await send(plan.messages);
    } catch (error) {
      await restore(db, claimed, device);
      throw error;
    }
    const gone = results.filter((r) => r.unregistered).map((r) => r.token);
    const failures = results.filter((r) => !r.ok && !r.unregistered);
    sent += results.filter((r) => r.ok).length;
    const last = results[results.length - 1];
    if (gone.length > 0) await forgetTokens(db, device.id, gone);
    else if (failures.length > 0) {
      // Its last push (the end, after "done") didn't reach the phone: as it was, so the next refresh sends it again.
      if (!last?.ok) await restore(db, claimed, device);
      for (const f of failures) if (f.retryable) retry.push(f.error ?? "not sent");
    }
    // Sent again before it goes stale, while there is something to show and its token to show it with.
    if (plan.kind === "update" && last?.ok)
      await queueLiveActivity(db, userId, LIVE_ACTIVITY_RESEND_MS, RESEND_WINDOW_MS);
  }
  if (later !== null) await queueLiveActivity(db, userId, Math.max(later - now.getTime(), LIVE_ACTIVITY_DELAY_MS));
  if (retry.length > 0) throw new PushError(`Live Activity not delivered: ${retry.join("; ")}`, true);
  return { sent };
}

type Plan =
  | { kind: "none" }
  | { kind: "later"; at: number }
  | { kind: "start" | "update" | "end"; write: Partial<Device>; messages: LiveActivityMessage[] };

/** What one phone needs now. */
function planOf(device: Device, state: LiveActivityState, locale: PushLocale, now: Date): Plan {
  const t = now.getTime();
  const apns = { ...(device.appId ? { topic: device.appId } : {}), ...(device.apnsSandbox ? { sandbox: true } : {}) };
  const content = (props: LiveActivityProps) => ({ name: LIVE_ACTIVITY_NAME, props: JSON.stringify(props) });
  const props = liveActivityProps(state, { locale, widgetsDir: device.widgetsDir, now });
  const last = parseProps(device.lastSent);
  if (!props) {
    if (!device.activityToken) return { kind: "none" };
    const done = content(liveActivityDoneProps(last, locale));
    const base = { to: device.activityToken, contentState: done, timestamp: seconds(t), priority: 10 as const, apns };
    return {
      kind: "end",
      write: { activityId: null, activityToken: null, lastSent: null, lastSentAt: now, startedAt: null },
      messages: [
        { ...base, event: "update" },
        { ...base, event: "end", dismissalDate: seconds(t + LIVE_ACTIVITY_DISMISS_MS) },
      ],
    };
  }
  const json = JSON.stringify(props);
  if (device.activityToken) {
    const sentAt = device.lastSentAt?.getTime() ?? null;
    const due = json !== device.lastSent || sentAt === null || t - sentAt >= LIVE_ACTIVITY_RESEND_MS;
    if (!due) return { kind: "none" };
    if (sentAt !== null && last?.tone === props.tone && t - sentAt < LIVE_ACTIVITY_UPDATE_EVERY_MS)
      return { kind: "later", at: sentAt + LIVE_ACTIVITY_UPDATE_EVERY_MS };
    return {
      kind: "update",
      write: { lastSent: json, lastSentAt: now },
      messages: [
        {
          to: device.activityToken,
          event: "update",
          contentState: { name: LIVE_ACTIVITY_NAME, props: json },
          timestamp: seconds(t),
          staleDate: seconds(t + LIVE_ACTIVITY_STALE_MS),
          // A request waiting for the person: now. Plain progress: when it suits the phone's battery.
          priority: props.tone === "waiting" ? 10 : 5,
          apns,
        },
      ],
    };
  }
  if (!device.pushToStartToken) return { kind: "none" };
  if (device.startedAt && t - device.startedAt.getTime() < LIVE_ACTIVITY_RESTART_AFTER_MS) return { kind: "none" };
  const lead = props.agents[0];
  const body = [lead?.step, lead?.where].filter(Boolean).join(" · ");
  return {
    kind: "start",
    write: { startedAt: now, lastSent: json, lastSentAt: now },
    messages: [
      {
        to: device.pushToStartToken,
        event: "start",
        contentState: { name: LIVE_ACTIVITY_NAME, props: json },
        timestamp: seconds(t),
        staleDate: seconds(t + LIVE_ACTIVITY_START_STALE_MS),
        alert: { title: clip(props.headline, 80), body: clip(body || props.headline, 180) },
        attributesType: LIVE_ACTIVITY_ATTRIBUTES,
        attributes: { url: props.url },
        inputPushToken: true,
        priority: 10,
        apns,
      },
    ],
  };
}

/** The row as it was before a send nobody took, if nothing else wrote it since. */
async function restore(db: Database, claimed: Device, before: Device) {
  await db
    .update(liveActivityDevices)
    .set({
      activityId: before.activityId,
      activityToken: before.activityToken,
      startedAt: before.startedAt,
      lastSent: before.lastSent,
      lastSentAt: before.lastSentAt,
      updatedAt: new Date(),
    })
    .where(unchanged(claimed));
}

/** Apple says these tokens reach nothing any more: the activity is gone, or the app can't be started with it. */
async function forgetTokens(db: Database, id: string, tokens: string[]) {
  // Hex only (the senders answer anything else as gone before it leaves): a Postgres array literal as is.
  const list = `{${tokens.filter((t) => /^[0-9a-fA-F]+$/.test(t)).join(",")}}`;
  await db
    .update(liveActivityDevices)
    .set({
      activityId: sql`case when ${liveActivityDevices.activityToken} = any(${list}::text[]) then null else ${liveActivityDevices.activityId} end`,
      lastSent: sql`case when ${liveActivityDevices.activityToken} = any(${list}::text[]) then null else ${liveActivityDevices.lastSent} end`,
      activityToken: sql`case when ${liveActivityDevices.activityToken} = any(${list}::text[]) then null else ${liveActivityDevices.activityToken} end`,
      pushToStartToken: sql`case when ${liveActivityDevices.pushToStartToken} = any(${list}::text[]) then null else ${liveActivityDevices.pushToStartToken} end`,
      updatedAt: new Date(),
    })
    .where(eq(liveActivityDevices.id, id));
}
