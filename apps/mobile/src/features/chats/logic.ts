import type {
  Agent,
  AppNotification,
  Channel,
  DirectMessage,
  MediaKind,
  Mission,
  MissionStatus,
  PreviewMeta,
  ThreadActor,
  ThreadInfo,
} from "@agenteschat/client";
import { hiddenAgentIds, hiddenDm, opensDm } from "@agenteschat/client/lib/audience";
import { dmActivityAt } from "@agenteschat/client/lib/recent";
import type { ServerCheck, ServerProblem } from "@agenteschat/client/lib/server";
import { looksUnread, unreadTotal } from "@agenteschat/client/lib/unread";
import { previewOf } from "../shared/logic";

/**
 * Conversas: channels, direct messages, threads and missions in one list (newest activity first): the home's pinned
 * strip and Recentes (DMs and channels, no grouping), threads and missions in their own tab, and what waits on you.
 */

export interface LastLine {
  author: ThreadActor | null;
  /** The author's name as the server sent it (channels), else looked up from `author`. */
  name?: string | null;
  text: string;
  /** A body the server wrote: the row shows it in the reader's language (`previewBody`). */
  meta?: PreviewMeta | null;
  /** A GIF or a sticker with no text (ADR 0091): the row says which ("GIF", "Figurinha"). */
  mediaKind?: MediaKind | null;
}

export type ConversationRow =
  | {
      kind: "channel";
      key: string;
      channelId: string;
      name: string;
      topic: string;
      /** Its sidebar category (ADR 0080); null: none. */
      categoryId: string | null;
      last: LastLine | null;
      at: string | null;
      /** New messages (0 while I muted it: it never looks unread). */
      unread: number;
      /** Unread mentions of me: the row's number, as on the web (even while muted). */
      mentions: number;
      /** I muted it (it never looks unread): the swipe offers to turn it back on. Only set when true. */
      muted?: boolean;
    }
  | {
      kind: "dm";
      key: string;
      channelId: string;
      with: DirectMessage["with"];
      last: LastLine | null;
      at: string | null;
      unread: number;
      /** An agent DM where the agent is working right now ("trabalhando…"). */
      working: boolean;
    }
  | {
      kind: "thread" | "mission";
      key: string;
      channelId: string;
      threadId: string;
      title: string;
      channelName: string;
      channelKind: ThreadInfo["channelKind"];
      /** In a DM: who it is with (the channel's own name is an internal one). */
      dmWith: DirectMessage["with"] | null;
      closed: boolean;
      working: boolean;
      needsYou: boolean;
      /** What its work waits on with none of it running, since when, and who works longest (ADR 0084 addendum). */
      wait: ThreadInfo["wait"];
      since: string | null;
      worker: string | null;
      /** A return an agent set there, still ahead: "Retorno às 00:32" when nothing else is on. */
      laterAt: string | null;
      /** Whose face the row shows: the last reply's author, else who started it. */
      face: ThreadActor;
      last: LastLine | null;
      at: string | null;
      unread: number;
      mission: {
        id: string;
        agentId: string;
        status: MissionStatus;
        planDone: number;
        planTotal: number;
        waitingYou: number;
      } | null;
    };

/**
 * Every message with replies is a thread on the server (an agent's answer
 * too). The list shows the ones that are conversations of their own: a
 * mission, a titled or range thread, or one where two people talk.
 */
export function isListedThread(t: Pick<ThreadInfo, "mission" | "title" | "context" | "participants" | "state">) {
  if (t.state === "archived") return false;
  if (t.mission) return true;
  if (t.title?.trim() || t.context) return true;
  return t.participants.filter((p) => p.type === "person" && p.id).length >= 2;
}

export const threadTitle = (t: Pick<ThreadInfo, "title" | "rootText">) => t.title?.trim() || previewOf(t.rootText);

export { hiddenAgentIds };

/**
 * One list: threads and missions, DMs and channels, by the latest activity (channels without any last, by
 * name). `workingChannels`: conversations where an agent has a run in progress (who is working now).
 */
export function buildConversations(input: {
  channels: Channel[];
  dms: DirectMessage[];
  threads: ThreadInfo[];
  workingChannels?: ReadonlySet<string>;
  hiddenAgents?: ReadonlySet<string>;
}): ConversationRow[] {
  const rows: ConversationRow[] = [];
  const dmWith = new Map(input.dms.map((d) => [d.channelId, d.with]));
  for (const t of input.threads) {
    if (!isListedThread(t)) continue;
    const m = t.mission ?? null;
    rows.push({
      kind: m ? "mission" : "thread",
      key: `t:${t.id}`,
      channelId: t.channelId,
      threadId: t.id,
      title: threadTitle(t),
      channelName: t.channelName,
      channelKind: t.channelKind,
      dmWith: t.channelKind === "dm" ? (dmWith.get(t.channelId) ?? null) : null,
      closed: t.state === "closed",
      working: t.working,
      needsYou: t.needsYou,
      wait: t.wait ?? null,
      since: t.since ?? null,
      worker: t.worker ?? null,
      laterAt: t.laterAt ?? null,
      face: t.lastMessage?.author ?? t.rootAuthor,
      last: t.lastMessage
        ? {
            author: t.lastMessage.author,
            text: previewOf(t.lastMessage.excerpt),
            ...(t.lastMessage.meta ? { meta: t.lastMessage.meta } : {}),
            ...(t.lastMessage.mediaKind ? { mediaKind: t.lastMessage.mediaKind } : {}),
          }
        : null,
      at: t.lastActivityAt,
      unread: Math.max(0, t.unread ?? 0),
      mission: m
        ? {
            id: m.id,
            agentId: m.agentId,
            status: m.status,
            planDone: m.planDone,
            planTotal: m.planTotal,
            waitingYou: m.waitingYou,
          }
        : null,
    });
  }
  for (const d of input.dms) {
    if (hiddenDm(d, input.hiddenAgents)) continue;
    rows.push({
      kind: "dm",
      key: `d:${d.channelId}`,
      channelId: d.channelId,
      with: d.with,
      last: d.lastMessage
        ? {
            author: d.lastMessage.authorType === "agent" ? { type: "agent", id: d.with.id } : null,
            text: previewOf(d.lastMessage.body),
            ...(d.lastMessage.meta ? { meta: d.lastMessage.meta } : {}),
            ...(d.lastMessage.mediaKind ? { mediaKind: d.lastMessage.mediaKind } : {}),
          }
        : null,
      at: dmActivityAt(d),
      unread: Math.max(0, d.unread),
      working: d.with.type === "agent" && Boolean(input.workingChannels?.has(d.channelId)),
    });
  }
  for (const c of input.channels) {
    if (!c.isMember) continue;
    const last = c.lastMessage ?? null;
    rows.push({
      kind: "channel",
      key: `c:${c.id}`,
      channelId: c.id,
      name: c.name,
      topic: c.topic,
      categoryId: c.categoryId ?? null,
      last: last
        ? {
            author: { type: last.authorType, id: last.authorId },
            name: last.authorName,
            text: previewOf(last.preview),
            ...(last.meta ? { meta: last.meta } : {}),
            ...(last.mediaKind ? { mediaKind: last.mediaKind } : {}),
          }
        : null,
      at: last?.createdAt ?? null,
      unread: looksUnread(c) ? Math.max(0, c.unreadCount ?? 0) : 0,
      mentions: Math.max(0, c.mentionCount ?? 0),
      ...(c.muted ? { muted: true } : {}),
    });
  }
  return rows.sort((a, b) => {
    if (a.at && b.at) return b.at.localeCompare(a.at);
    if (a.at) return -1;
    if (b.at) return 1;
    return rowName(a).localeCompare(rowName(b));
  });
}

/** Where a thread or mission lives: "#vendas", or who the DM is with ("Theo"); null when unknown. */
export type RowPlace = { kind: "channel"; name: string } | { kind: "with"; name: string } | null;

/**
 * A DM's channel name is internal ("dm-…") and never shown: its other member, else (`nameOf`, from the
 * directory) the mission's agent; nothing when neither resolves.
 */
export function rowPlace(
  r: Pick<
    Extract<ConversationRow, { kind: "thread" | "mission" }>,
    "channelKind" | "channelName" | "dmWith" | "mission"
  >,
  nameOf?: (who: { type: string; id: string | null }) => string,
): RowPlace {
  if (r.channelKind === "dm") {
    const name =
      r.dmWith?.name?.trim() ||
      (r.dmWith ? nameOf?.(r.dmWith) : "") ||
      (r.mission ? nameOf?.({ type: "agent", id: r.mission.agentId }) : "") ||
      "";
    return name ? { kind: "with", name } : null;
  }
  const name = r.channelName?.trim();
  return name ? { kind: "channel", name } : null;
}

export const rowName = (r: ConversationRow) =>
  r.kind === "channel" ? r.name : r.kind === "dm" ? r.with.name : r.title;

/** A channel's or DM's number: mentions of me in a channel (red, as on the web, even while muted), else its unread. */
export function rowBadge(r: ConversationRow): { count: number; mention: boolean } {
  const mentions = r.kind === "channel" ? r.mentions : 0;
  return mentions > 0 ? { count: mentions, mention: true } : { count: r.unread, mention: false };
}

/** The "Não lidas" count: conversations with something unread. */
export const unreadConversations = (rows: ConversationRow[]) => rows.filter((r) => r.unread > 0).length;

/**
 * The badge of Conversas, straight from the two lists (no thread list needed): joined channels and DMs
 * with something unread, the rows of the home's Recentes. Threads and missions have their own tab and
 * badge (`unreadThreadCount`), so nothing is counted twice.
 */
export function unreadConversationCount(input: {
  channels: Pick<Channel, "isMember" | "unreadCount" | "muted">[];
  dms: Pick<DirectMessage, "unread" | "with">[];
  hiddenAgents?: ReadonlySet<string>;
}): number {
  const channels = input.channels.filter(looksUnread).length;
  const dms = input.dms.filter((d) => d.unread > 0 && !hiddenDm(d, input.hiddenAgents)).length;
  return channels + dms;
}

/** The app icon's number: the web tab title's total (unread DM messages and mentions of me), DMs the home hides left out. */
export function appBadgeCount(input: {
  channels: Pick<Channel, "isMember" | "mentionCount">[];
  dms: Pick<DirectMessage, "unread" | "with">[];
  hiddenAgents?: ReadonlySet<string>;
}): number {
  return unreadTotal(input.channels, input.dms, input.hiddenAgents);
}

// ── The home ────────────────────────────────────────────────────────────────

/**
 * Conversas' collapsible sections, in order, remembered on the phone: Início's widgets, the pinned strip, Recentes, and
 * the channels an administrator reads but isn't in.
 */
export const HOME_SECTIONS = ["widgets", "pinned", "recent", "otherChannels"] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];
/** The kinds of rows: DMs with agents, channels, DMs with people, and threads and missions (their own tab). */
export type RowKind = "agents" | "channels" | "people" | "threads";
/** A pushed list of conversations: Recentes in full, its "See all" (threads and missions are a tab). */
export const LIST_KINDS = ["recent"] as const;
export type ListKind = (typeof LIST_KINDS)[number];
/** Rows Recentes shows on the home before "See all". */
export const RECENT_MAX = 20;

export const isListKind = (v: unknown): v is ListKind => LIST_KINDS.includes(v as ListKind);

/** Which list a row belongs to: agent DMs, channels, DMs with people, threads and missions. */
export function kindOf(r: ConversationRow): RowKind {
  if (r.kind === "channel") return "channels";
  if (r.kind === "dm") return r.with.type === "agent" ? "agents" : "people";
  return "threads";
}

/** The rows of one kind, in the list's order (latest activity first). */
export const rowsOfKind = (rows: ConversationRow[], kind: RowKind) => rows.filter((r) => kindOf(r) === kind);

/**
 * Conversas' Recentes (pure): every DM and channel with no grouping, in the list's order (latest activity first);
 * threads and missions are their own tab. A pinned conversation keeps its place by its activity: the strip above holds
 * the pins, so nothing here is put first for them.
 */
export const recentRows = (rows: ConversationRow[]) => rows.filter((r) => kindOf(r) !== "threads");

/**
 * The pinned strip (pure): what the person pinned (the web sidebar's pins, `usePins`), agents first, then channels,
 * then people, each in the pins' order. A pinned agent with no conversation yet stands as one to start (its row in
 * `starters`); a pinned channel or person shows while their conversation is among `rows`. A pin of something no longer
 * listed (gone, hidden from me, the right hand with its own field) holds no place.
 */
export function pinnedRows(
  rows: readonly ConversationRow[],
  starters: readonly ConversationRow[],
  pins: { agents: readonly string[]; channels: readonly string[]; people: readonly string[] },
): ConversationRow[] {
  const dmWith = (kind: "agents" | "people", id: string) => (r: ConversationRow) =>
    r.kind === "dm" && kindOf(r) === kind && r.with.id === id;
  return [
    ...pins.agents.map((id) => rows.find(dmWith("agents", id)) ?? starters.find(dmWith("agents", id))),
    ...pins.channels.map((id) => rows.find((r) => r.kind === "channel" && r.channelId === id)),
    ...pins.people.map((id) => rows.find(dmWith("people", id))),
  ].filter((r): r is ConversationRow => r !== undefined);
}

/** #general with nothing new in it: no unread message and no mention of me. */
export const isQuietGeneral = (r: ConversationRow) =>
  r.kind === "channel" && r.name === "general" && r.unread === 0 && r.mentions === 0;

/**
 * The rows without a quiet #general when `hide` (pure): a personal workspace while its person is the only member
 * leaves it out of the home's Recentes and of its "See all", as the web's sidebar does (ADR 0159). Every workspace has
 * one; with family in it, or something new there, it shows.
 */
export const withoutQuietGeneral = (rows: ConversationRow[], hide: boolean) =>
  hide ? rows.filter((r) => !isQuietGeneral(r)) : rows;

/**
 * The agents to start a conversation with, as rows: each a DM with no channel (`channelId: ""`), opened on press (a
 * pinned agent never talked to, on the home's strip). Agents hidden from me are left out, and so is any whose DM the
 * server wouldn't open for me (`opensDm`): one I only edit, or someone's private agent under a mere "Edit agents" (ADR
 * 0085 addendum of 2026-11-17).
 */
export function agentStarters(
  agents: readonly Pick<Agent, "id" | "name" | "handle" | "canTalk" | "canManage">[],
  hidden: ReadonlySet<string> = new Set(),
): ConversationRow[] {
  return agents
    .filter((a) => !hidden.has(a.id) && opensDm(a))
    .map((a) => ({
      kind: "dm" as const,
      key: `a:${a.id}`,
      channelId: "",
      with: { type: "agent" as const, id: a.id, name: a.name, handle: a.handle },
      last: null,
      at: null,
      unread: 0,
      working: false,
    }));
}

/**
 * The right hand's own row (ADR 0137), its field under Conversas' greeting and never among the list's rows: its DM, or
 * one to start (no channel yet); the other rows without it. No pin when there is none for this person (outside its
 * audience).
 */
export function rightHandPin(
  rows: ConversationRow[],
  agent: { id: string; name: string; handle: string } | undefined,
): { pin: ConversationRow | null; rows: ConversationRow[] } {
  if (!agent) return { pin: null, rows };
  const isIt = (r: ConversationRow) => r.kind === "dm" && r.with.type === "agent" && r.with.id === agent.id;
  return { pin: rows.find(isIt) ?? agentStarters([agent])[0] ?? null, rows: rows.filter((r) => !isIt(r)) };
}

/** The Threads tab: threads and missions, by latest activity. */
export const threadRows = (rows: ConversationRow[]) => rowsOfKind(rows, "threads");

/** The badge of the Threads tab: thread and mission rows with something unread (replies in threads I follow). */
export const unreadThreadCount = (rows: ConversationRow[]) => threadRows(rows).filter((r) => r.unread > 0).length;

/**
 * The sections the person collapsed, as remembered (anything unreadable: none), out of `keys`. Null `keys` takes any
 * ids: the groups of agents of every workspace share one list, so one workspace's toggles keep the others'.
 */
export function parseCollapsed<K extends string>(
  raw: string | null,
  keys: readonly K[] | null = HOME_SECTIONS as unknown as readonly K[],
): K[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return keys ? keys.filter((k) => v.includes(k)) : v.filter((k): k is K => typeof k === "string");
  } catch {
    return [];
  }
}

/** Collapses or opens a section (in the sections' order; with null `keys`, the others stay as they were). */
export function toggleCollapsed<K extends string>(
  list: readonly K[],
  key: K,
  keys: readonly K[] | null = HOME_SECTIONS as unknown as readonly K[],
): K[] {
  const on = list.includes(key);
  if (!keys) return on ? list.filter((k) => k !== key) : [...list, key];
  return keys.filter((k) => (k === key ? !on : list.includes(k)));
}

// ── The Threads tab ─────────────────────────────────────────────────────────

/** The Threads tab's collapsible sections, in order. */
export const THREAD_SECTIONS = ["missions", "threads"] as const;
export type ThreadSection = (typeof THREAD_SECTIONS)[number];

type ThreadRow = Extract<ConversationRow, { kind: "thread" | "mission" }>;

/**
 * Missões, then Threads, each by latest activity; empty ones left out. A closed thread goes after the open ones (the
 * row carries no "closed" mark: its place says it), and a finished mission after the live ones likewise.
 */
export function threadSections(rows: ConversationRow[]): { key: ThreadSection; rows: ThreadRow[] }[] {
  const all = threadRows(rows).filter((r): r is ThreadRow => r.kind === "thread" || r.kind === "mission");
  const over = (r: ThreadRow) =>
    r.kind === "thread" ? r.closed : r.mission?.status === "done" || r.mission?.status === "canceled";
  const settle = (list: ThreadRow[]) => [...list.filter((r) => !over(r)), ...list.filter(over)];
  return [
    { key: "missions" as const, rows: settle(all.filter((r) => r.kind === "mission")) },
    { key: "threads" as const, rows: settle(all.filter((r) => r.kind === "thread")) },
  ].filter((s) => s.rows.length > 0);
}

/** Where a mission stands, for its second line ("trabalhando…", "Esperando você", "Pausada", "Concluída"). */
export type MissionState = "working" | "waiting" | "paused" | "done" | "canceled" | "active" | "proposed";

export function missionState(r: Pick<ThreadRow, "working" | "needsYou" | "mission">): MissionState | null {
  const m = r.mission;
  if (!m) return null;
  if (m.status === "canceled") return "canceled";
  if (m.status === "done") return "done";
  if (m.status === "active" && r.working) return "working";
  if (m.waitingYou > 0 || r.needsYou) return "waiting";
  if (m.status === "paused") return "paused";
  if (m.status === "awaiting_close") return "done";
  return m.status === "proposed" ? "proposed" : "active";
}

/**
 * A Threads row's lines (`trowApp`): the faint line with what it is and where ("Missão · #canal", "Missão ·
 * Theo" in a DM, "Thread · #canal"); a mission's state and progress, or a thread's last reply; the badge (a
 * mission: what waits on you in it; a thread: unread).
 */
export function threadRowLines(r: ThreadRow, nameOf?: (who: { type: string; id: string | null }) => string) {
  const place = rowPlace(r, nameOf);
  const where = !place ? null : place.kind === "with" ? place.name : `#${place.name}`;
  const state = r.kind === "mission" ? missionState(r) : null;
  return {
    kind: r.kind === "mission" ? ("mission" as const) : ("thread" as const),
    where,
    state,
    progress: r.mission ? { done: r.mission.planDone, total: r.mission.planTotal } : null,
    badge: r.kind === "mission" ? (r.mission?.waitingYou ?? 0) : r.unread,
  };
}

// ── Esperando você (top of Conversas) ───────────────────────────────────────

/** Agents' questions still open in the inbox ("Pergunta"). */
export function openQuestions<T extends Pick<AppNotification, "kind" | "doneAt">>(items: T[]): T[] {
  return items.filter((n) => n.kind === "agent_question" && !n.doneAt);
}

/** Missions with a review or a decision you may act on, and how many items each has. */
export function missionsWaiting<T extends Pick<Mission, "canAct" | "pending">>(list: T[]): T[] {
  return list.filter((m) => m.canAct && m.pending.reviews + m.pending.decisions > 0);
}

export const missionWaitingItems = (m: Pick<Mission, "pending">) => m.pending.reviews + m.pending.decisions;

/** The count next to "Esperando você": requests, mission items and open questions. */
export function waitingTotal(input: {
  approvals: number;
  missions: Pick<Mission, "pending">[];
  questions: number;
}): number {
  return input.approvals + input.missions.reduce((n, m) => n + missionWaitingItems(m), 0) + input.questions;
}

// ── Conversas when it can't load ────────────────────────────────────────────

/**
 * Why Conversas didn't load (pure): no internet on the phone; the server answered its own check, so it is reachable
 * and the list failed for another reason (never "open Tailscale" then); off a tailnet, a server that worked before and
 * doesn't answer is down; else what its check says.
 */
export function serverTrouble(input: {
  offline: boolean;
  check: ServerCheck | null;
  tailnet: boolean;
}): { kind: "offline" } | { kind: "answered" } | { kind: "down" } | { kind: "problem"; problem: ServerProblem } {
  if (input.offline) return { kind: "offline" };
  if (input.check?.ok) return { kind: "answered" };
  const problem = input.check && !input.check.ok ? input.check.problem : "unreachable";
  if (problem === "unreachable" && !input.tailnet) return { kind: "down" };
  return { kind: "problem", problem };
}

/** Conversas' two ways to list a team's conversations: by latest activity, or by the agents' sectors (ADR 0083). */
export type HomeView = "recent" | "sectors";

export const homeViewOf = (stored: string | null): HomeView => (stored === "sectors" ? "sectors" : "recent");

/** One section of Setores: a sector's agents' conversations, the agents in none, the direct messages, the channels. */
export interface HomeSectorSection {
  /** Remembered collapsed by it: `sector:<id>`, or `agents`, `dms`, `channels`. */
  key: string;
  kind: "sector" | "agents" | "dms" | "channels";
  /** The sector's own (its name, color and icon); null for the other three. */
  group: { id: string; name: string; color?: string | undefined; icon?: string | null | undefined } | null;
  rows: ConversationRow[];
}

/**
 * Setores, as the web's sidebar groups the agents (ADR 0083): each sector with its agents' conversations, in the
 * workspace's order of sectors; then the agents in no sector, the direct messages with people and the channels.
 * Threads and missions stay in Recentes and Threads. Each section is by latest activity (`recentRows`); an empty one
 * is left out.
 */
export function sectorSections(
  rows: readonly ConversationRow[],
  groups: readonly { id: string; name: string; agentIds: readonly string[]; color?: string; icon?: string | null }[],
): HomeSectorSection[] {
  const ordered = recentRows([...rows]);
  const agentRows = ordered.filter((r) => r.kind === "dm" && r.with.type === "agent");
  const agentOf = (r: ConversationRow) => (r.kind === "dm" ? r.with.id : "");
  const placed = new Set<string>();
  const sections: HomeSectorSection[] = groups.map((g) => {
    const ids = new Set(g.agentIds);
    const mine = agentRows.filter((r) => ids.has(agentOf(r)) && !placed.has(r.key));
    for (const r of mine) placed.add(r.key);
    return {
      key: `sector:${g.id}`,
      kind: "sector",
      group: { id: g.id, name: g.name, color: g.color, icon: g.icon ?? null },
      rows: mine,
    };
  });
  sections.push(
    { key: "agents", kind: "agents", group: null, rows: agentRows.filter((r) => !placed.has(r.key)) },
    {
      key: "dms",
      kind: "dms",
      group: null,
      rows: ordered.filter((r) => r.kind === "dm" && r.with.type !== "agent"),
    },
    { key: "channels", kind: "channels", group: null, rows: ordered.filter((r) => r.kind === "channel") },
  );
  return sections.filter((s) => s.rows.length > 0);
}
