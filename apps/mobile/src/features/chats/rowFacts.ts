import {
  threadWorkState,
  threadWorkTone,
  threadWorkWord,
  workLine,
  workTime,
} from "@agenteschat/client/lib/agent-work";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { agentFaceWord } from "@agenteschat/client/lib/presence";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { TFunction } from "i18next";
import { workTitle } from "../agents/work";
import { agentIntro } from "../chat/intent";
import type { Directory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import type { PresenceOf } from "../status/hooks";
import { type ConversationRow, type LastLine, rowBadge, threadRowLines } from "./logic";
import type { AgentRowState } from "./now";

/**
 * What a conversation's row says, as plain values: worked out once per screen from what the screen reads (who everyone
 * is, their presence, their work, one clock for the whole list), so each row is a memoized drawing of these and draws
 * again only when something it shows changed. Pure, so the tests read it as the row does.
 */

/** What a screen of rows reads once, for all of them. */
export interface RowContext {
  t: TFunction;
  locale: string;
  /** The list's one clock (a minute's tick): how long work has gone on, when a return comes. */
  now: number;
  dir: Pick<Directory, "agentById" | "nameOf">;
  presence: PresenceOf;
  /** A channel's name by id, for an agent's work in it. */
  channelName: (id: string) => string | undefined;
  /** The workspace, for the words that read its mode (ADR 0159). */
  org: Parameters<typeof modeKey>[0];
  /** A time as the lists say it ("9:41", "Ontem"). */
  short: (iso: string) => string;
}

/** The mark before the second line's words: the orbit at work, the amber square for what waits on you, a clock. */
export type RowMark = "orbit" | "wait" | "clock" | null;

/** The second line, by what it says. */
export type RowLine =
  /** A state in words (`word`, ink when `strong`, amber when it waits on you) and what follows it (` · 22 min`). */
  | { kind: "state"; mark: RowMark; word: string; strong: boolean; em: boolean; amber: boolean; rest: string }
  /** Waiting for its offline computer: a clock and the words. */
  | { kind: "away"; text: string }
  /** What an agent is on, after the orbit. */
  | { kind: "doing"; text: string }
  /** The last message, with who said it (`lead`, empty in a DM's own words). */
  | { kind: "last"; lead: string; text: string };

export interface RowFacts {
  /** An agent's face: dozing while it waits for its computer, at work, or idle. */
  face: "idle" | "run" | "rest";
  /** The orbit's tones: the DM's or the mission's agent, or who works longest in a thread. */
  orbit: AgentColorName;
  /** The faint line over the name ("Missão · #canal"). */
  place: string | null;
  line: RowLine;
  /** What the second line says, for screen readers. */
  label: string;
  /** A face's presence in a word, and a person's status line, for screen readers. */
  presence: string | null;
  status: string | null;
  /** The number at the end: unread, mentions of me (`mention`), or what waits on me in a mission. */
  badge: number;
  mention: boolean;
  /** When it last moved, as the lists say it. */
  time: string | null;
}

/** One row's facts (`agent`: what an agent DM says instead of its last message, from `agentRowState`). */
export function rowFacts(r: ConversationRow, agent: AgentRowState | undefined, ctx: RowContext): RowFacts {
  const { t, locale, now, dir, presence, org } = ctx;
  const agentDm = r.kind === "dm" && r.with.type === "agent";
  const agentState = agentDm ? (agent ?? null) : null;
  // Presence and line (ADR 0084): the agent's from its work, the person's as they set it.
  const agentShown = r.kind === "dm" && agentDm ? presence.agent(r.with.id) : null;
  const personShown = r.kind === "dm" && !agentDm ? presence.person(r.with.id) : null;
  const agentLine = agentShown?.line ?? null;
  const presenceWord = agentShown
    ? agentFaceWord(t, agentShown.presence)
    : personShown
      ? t(`presence.${personShown.presence}`)
      : null;
  // Its work for me, workspace-wide (ADR 0084 addendum): whom it helps, where, what waits on me, how long.
  const work =
    r.kind === "dm" && agentDm
      ? workLine(
          t,
          locale,
          agentShown?.work ?? null,
          { agentName: (id) => dir.agentById.get(id)?.name, channelName: ctx.channelName, here: null },
          now,
        )
      : null;
  // Waiting for its offline computer: dozing, no working orbit (its run only waits).
  const away = agentState?.kind === "computer";
  const working =
    r.kind === "channel" || away ? false : r.working || agentState?.kind === "working" || work?.tone === "working";
  // Whose orbit: the DM's agent, or the mission's.
  const orbitAgent = r.kind === "dm" ? r.with.id : r.kind === "mission" ? r.mission?.agentId : null;
  let orbit = agentLook(orbitAgent ? dir.agentById.get(orbitAgent) : undefined).color;
  const lines = r.kind === "thread" || r.kind === "mission" ? threadRowLines(r, dir.nameOf) : null;
  // The faint line of a thread or mission: what it is and where ("Missão · #canal").
  const place = lines
    ? [t(lines.kind === "mission" ? "mobile.chats.mission" : "mobile.chats.thread"), lines.where]
        .filter(Boolean)
        .join(" · ")
    : null;
  const own = rowBadge(r);

  const lastText = (last: LastLine | null) => {
    if (!last) return { who: "", text: "" };
    const who = last.name || (last.author ? dir.nameOf(last.author) : "");
    return { who, text: previewBody(t, last.text, last.meta ?? null, last.mediaKind) };
  };
  /**
   * A DM with nothing in it yet: who the agent is (as its first conversation says), or a word to start. A personal
   * workspace's agent is there for its person, not on a team (ADR 0159).
   */
  const introLine = (): string => {
    if (r.kind !== "dm") return "";
    const a = agentDm ? dir.agentById.get(r.with.id) : undefined;
    if (!a) return t("mobile.chats.sayHi", { name: r.with.name });
    const intro = agentIntro(a);
    return intro.kind === "what"
      ? intro.text
      : intro.kind === "role"
        ? t(modeKey(org, "mobile.chat.intent.roleIntro"), { role: intro.role })
        : t("mobile.chat.intent.noIntro");
  };

  // A thread's work, as the chip under its root says it: one state, and how long (ADR 0084 addendum).
  const threadState = r.kind === "thread" && !r.closed ? threadWorkState(r) : null;
  let line: RowLine;
  let label: string;
  if (r.kind === "thread" && threadState) {
    const word = threadWorkWord(t, threadState, { at: r.laterAt, locale, now });
    const tone = threadWorkTone(threadState);
    // A return says when it comes, never for how long.
    const held = threadState === "later" ? null : workTime(locale, r.since, now);
    label = [word, held].filter(Boolean).join(" · ");
    orbit = agentLook(dir.agentById.get(r.worker ?? "")).color;
    line = {
      kind: "state",
      mark: tone === "working" ? "orbit" : tone === "you" ? "wait" : "clock",
      word,
      strong: tone === "working",
      em: true,
      amber: tone === "you",
      rest: held ? ` · ${held}` : "",
    };
  } else if (lines?.state && lines.progress) {
    const progress = t("mobile.chats.missionProgress", lines.progress);
    const state = t(`mobile.chats.missionState.${lines.state}`);
    // The state is words in the state's color: the orbit for work, amber for what waits on you; no icon.
    const lead = lines.state === "working" || lines.state === "waiting";
    label = `${state} · ${progress}`;
    line = {
      kind: "state",
      mark: lines.state === "working" ? "orbit" : null,
      word: state,
      strong: lead,
      em: lead,
      amber: lines.state === "waiting",
      rest: ` · ${progress}`,
    };
  } else if (work) {
    // The same line as the web's lists: the orbit at work, amber what waits on me, the clock for a wait elsewhere.
    label = [work.text, work.time].filter(Boolean).join(" · ");
    line = {
      kind: "state",
      mark: work.tone === "working" ? "orbit" : work.tone === "neutral" ? "clock" : null,
      word: work.text,
      strong: work.tone === "working",
      em: true,
      amber: work.tone === "you",
      rest: work.time ? ` · ${work.time}` : "",
    };
  } else if (agentState?.kind === "waiting") {
    const verb = t(`mobile.homeNow.rowWait.${agentState.wait}`);
    label = [verb, agentState.title].filter(Boolean).join(" · ");
    line = {
      kind: "state",
      mark: null,
      word: verb,
      strong: false,
      em: true,
      amber: true,
      rest: agentState.title ? ` · ${agentState.title}` : "",
    };
  } else if (agentState?.kind === "computer") {
    label = t("mobile.outage.rowWaiting", { computer: agentState.computer });
    line = { kind: "away", text: label };
  } else if (agentLine && working) {
    // Its own line, or the one picked for its run, in place of the last message while it works (a line kept with
    // `minutes` after the run ended doesn't hide its reply).
    label = agentLine.text;
    line = { kind: "doing", text: agentLine.text };
  } else if (working && r.kind !== "mission") {
    const doing = agentState?.kind === "working" ? workTitle(t, agentState.work) : "";
    label = doing ? t("mobile.homeNow.doingLabel", { what: doing }) : t("mobile.chats.working");
    line = { kind: "doing", text: doing || t("mobile.chats.working") };
  } else {
    const last = lastText(r.last);
    const text =
      r.kind === "channel" ? last.text || r.topic || t("mobile.chats.channelEmpty") : r.last ? last.text : introLine();
    // In a DM the other side's own words need no "Ada:" before them (the row is already Ada's).
    const theirs = r.kind === "dm" && r.last?.author?.type === r.with.type && r.last.author.id === r.with.id;
    const lead = theirs ? "" : last.who;
    label = lead ? `${lead}: ${text}` : text;
    line = { kind: "last", lead, text };
  }
  if (r.kind === "thread" && r.closed) label = `${t("mobile.chats.closed")}, ${label}`;

  return {
    face: away ? "rest" : working ? "run" : "idle",
    orbit,
    place,
    line,
    label,
    presence: presenceWord,
    status: personShown?.status?.text ?? null,
    badge: lines ? lines.badge : own.count,
    mention: !lines && own.mention,
    time: r.at ? ctx.short(r.at) : null,
  };
}

/**
 * The mark a face on the pinned strip carries before its name, standing for its row's second line (the strip has no
 * room for the words): the orbit at work, the amber square while it waits on you, a clock for a wait elsewhere (its
 * offline computer, a return); none over a last message.
 */
export function faceMark(line: RowLine): RowMark {
  if (line.kind === "doing") return "orbit";
  if (line.kind === "away") return "clock";
  if (line.kind === "state") return line.amber ? "wait" : line.mark;
  return null;
}

/** Two plain values (what the rows and their facts hold) equal all the way down. */
export function samePlain(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => samePlain(v, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => k in right && samePlain(left[k], right[k]));
}

/**
 * `next` with the objects of `before` (by key) wherever nothing in them changed, and the map for the next time: a list
 * rebuilt on every change keeps the rows that didn't, so their memoized drawings stay as they are.
 */
export function reuseByKey<T extends { key: string }>(
  before: ReadonlyMap<string, T>,
  next: readonly T[],
  same: (a: T, b: T) => boolean = samePlain,
): { list: T[]; byKey: Map<string, T> } {
  const byKey = new Map<string, T>();
  const list = next.map((item) => {
    const old = before.get(item.key);
    const kept = old && same(old, item) ? old : item;
    byKey.set(item.key, kept);
    return kept;
  });
  return { list, byKey };
}
