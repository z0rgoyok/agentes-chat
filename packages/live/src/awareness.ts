import type { Awareness } from "y-protocols/awareness";
import { fnv1a } from "./colors";
import { LIVE_LIMITS } from "./limits";

/**
 * Presence in a live file (ADR 0196 §5): who is here, viewing or editing, and where. It is Yjs awareness, never
 * stored. The server owns identity: `sanitizePeerState` writes the person over whatever a client claims, keeps only
 * the fields below with their sizes capped, and turns `editing` into `viewing` on a read-only socket.
 */

export type PeerKind = "person" | "agent";

export interface PeerUser {
  kind: PeerKind;
  id: string;
}

/** A selected cell range, by row and column ids (so it follows rows inserted above it). */
export interface SheetSel {
  sheet: string;
  r1: string;
  c1: string;
  r2: string;
  c2: string;
  /** Typing in the cell. */
  editing?: boolean;
}

/** A y-prosemirror relative position, as JSON (`Y.relativePositionToJSON`). */
export interface RelativePositionJson {
  type?: { client: number; clock: number } | null;
  tname?: string | null;
  item?: { client: number; clock: number } | null;
  assoc?: number;
}

export interface PeerState {
  user: PeerUser;
  mode: "viewing" | "editing";
  at?: { sheet?: string; slide?: string };
  /** Selected cells, slide element ids, canvas shape ids, a document's block ids (an agent at work, ADR 0200). */
  sel?: { sheet?: SheetSel; slide?: string[]; canvas?: string[]; document?: string[] };
  /** The pointer, in canvas world units or slide units. */
  cursor?: { x: number; y: number; space: "canvas" | "slide" };
  /** What they see (to follow them). */
  view?: { x: number; y: number; zoom: number; w: number; h: number };
  presenting?: { slide: string; since: number };
  /** The awareness client id of the peer they follow. */
  following?: number;
  /** What an agent is doing: an i18n key under `live.activity.*` and its parameters (words the apps translate). */
  activity?: { key: string; params?: Record<string, string> };
  /** The text cursor in a rich text box (y-prosemirror's cursor, under this field name). */
  cursorPm?: unknown;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVITY_KEY = /^[A-Za-z0-9_.]{1,64}$/;
const PARAM_KEY = /^[A-Za-z0-9_]{1,32}$/;
/** Ids in one selection: past this the apps draw the selection's bounds anyway. */
const MAX_SELECTED = 200;
const MAX_PARAMS = 8;
const MAX_PARAM_CHARS = 200;
const MAX_COORD = 1e7;
const MAX_CLIENT = 0xffffffff;

function idOf(value: unknown): string | undefined {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

function numberOf(value: unknown, min = -MAX_COORD, max = MAX_COORD): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function idsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = idOf(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_SELECTED) break;
  }
  return out;
}

function clientOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_CLIENT ? value : undefined;
}

function userOf(value: unknown): PeerUser | undefined {
  const o = recordOf(value);
  if (!o) return undefined;
  const kind = o.kind === "person" || o.kind === "agent" ? o.kind : undefined;
  const id = typeof o.id === "string" && o.id.length > 0 && o.id.length <= 64 ? o.id : undefined;
  return kind && id ? { kind, id } : undefined;
}

function sheetSelOf(value: unknown): SheetSel | undefined {
  const o = recordOf(value);
  if (!o) return undefined;
  const sheet = idOf(o.sheet);
  const r1 = idOf(o.r1);
  const c1 = idOf(o.c1);
  const r2 = idOf(o.r2);
  const c2 = idOf(o.c2);
  if (!sheet || !r1 || !c1 || !r2 || !c2) return undefined;
  const sel: SheetSel = { sheet, r1, c1, r2, c2 };
  if (o.editing === true) sel.editing = true;
  return sel;
}

function positionOf(value: unknown): RelativePositionJson | undefined {
  const o = recordOf(value);
  if (!o) return undefined;
  const out: RelativePositionJson = {};
  for (const key of ["type", "item"] as const) {
    const v = o[key];
    if (v === null) out[key] = null;
    else if (v !== undefined) {
      const id = recordOf(v);
      const client = id && typeof id.client === "number" && Number.isSafeInteger(id.client) ? id.client : -1;
      const clock = id && typeof id.clock === "number" && Number.isSafeInteger(id.clock) ? id.clock : -1;
      if (client < 0 || clock < 0) return undefined;
      out[key] = { client, clock };
    }
  }
  if (o.tname === null) out.tname = null;
  else if (o.tname !== undefined) {
    if (typeof o.tname !== "string" || o.tname.length > 64) return undefined;
    out.tname = o.tname;
  }
  if (o.assoc !== undefined && o.assoc !== null) {
    if (typeof o.assoc !== "number" || !Number.isInteger(o.assoc) || Math.abs(o.assoc) > 1) return undefined;
    out.assoc = o.assoc;
  }
  return out;
}

function cursorPmOf(value: unknown): { anchor: RelativePositionJson; head: RelativePositionJson } | null | undefined {
  if (value === null) return null;
  const o = recordOf(value);
  if (!o) return undefined;
  const anchor = positionOf(o.anchor);
  const head = positionOf(o.head);
  return anchor && head ? { anchor, head } : undefined;
}

function activityOf(value: unknown): PeerState["activity"] {
  const o = recordOf(value);
  if (!o || typeof o.key !== "string" || !ACTIVITY_KEY.test(o.key)) return undefined;
  const activity: NonNullable<PeerState["activity"]> = { key: o.key };
  const params = recordOf(o.params);
  if (params) {
    const out: Record<string, string> = {};
    let count = 0;
    for (const [key, v] of Object.entries(params)) {
      if (count >= MAX_PARAMS) break;
      if (!PARAM_KEY.test(key)) continue;
      if (typeof v === "string") out[key] = v.slice(0, MAX_PARAM_CHARS);
      else if (typeof v === "number" && Number.isFinite(v)) out[key] = String(v);
      else continue;
      count++;
    }
    if (count) activity.params = out;
  }
  return activity;
}

/** The UTF-8 length of a text without encoding it (a lone surrogate counts as the 3 bytes of its replacement). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function bytesOf(state: PeerState): number {
  return utf8Length(JSON.stringify(state));
}

/**
 * A peer's presence as the server accepts it: `null` for a removal or anything that isn't an object; otherwise only
 * the known fields, each checked and capped (unknown keys dropped, ids and strings bounded, numbers finite), the
 * user forced to who the socket belongs to, `viewing` on a read-only socket, and at most `LIVE_LIMITS.awarenessBytes`
 * once encoded (the bulkiest optional fields go first when it is over).
 */
export function sanitizePeerState(input: unknown, forced: { user: PeerUser; viewOnly: boolean }): PeerState | null {
  const o = recordOf(input);
  if (!o) return null;
  const state: PeerState = {
    user: { kind: forced.user.kind, id: forced.user.id },
    mode: o.mode === "editing" && !forced.viewOnly ? "editing" : "viewing",
  };
  const at = recordOf(o.at);
  if (at) {
    const sheet = idOf(at.sheet);
    const slide = idOf(at.slide);
    if (sheet || slide) state.at = { ...(sheet ? { sheet } : {}), ...(slide ? { slide } : {}) };
  }
  const sel = recordOf(o.sel);
  if (sel) {
    const sheet = sheetSelOf(sel.sheet);
    const slide = idsOf(sel.slide);
    const canvas = idsOf(sel.canvas);
    const document = idsOf(sel.document);
    if (sheet || slide || canvas || document) {
      state.sel = {
        ...(sheet ? { sheet } : {}),
        ...(slide ? { slide } : {}),
        ...(canvas ? { canvas } : {}),
        ...(document ? { document } : {}),
      };
    }
  }
  const cursor = recordOf(o.cursor);
  if (cursor && (cursor.space === "canvas" || cursor.space === "slide")) {
    const x = numberOf(cursor.x);
    const y = numberOf(cursor.y);
    if (x !== undefined && y !== undefined) state.cursor = { x, y, space: cursor.space };
  }
  const view = recordOf(o.view);
  if (view) {
    const x = numberOf(view.x);
    const y = numberOf(view.y);
    const zoom = numberOf(view.zoom, 0.01, 100);
    const w = numberOf(view.w, 0);
    const h = numberOf(view.h, 0);
    if (x !== undefined && y !== undefined && zoom !== undefined && w !== undefined && h !== undefined) {
      state.view = { x, y, zoom, w, h };
    }
  }
  const presenting = recordOf(o.presenting);
  if (presenting) {
    const slide = idOf(presenting.slide);
    const since = numberOf(presenting.since, 0, Number.MAX_SAFE_INTEGER);
    if (slide && since !== undefined) state.presenting = { slide, since };
  }
  const following = clientOf(o.following);
  if (following !== undefined) state.following = following;
  const activity = activityOf(o.activity);
  if (activity) state.activity = activity;
  const cursorPm = cursorPmOf(o.cursorPm);
  if (cursorPm !== undefined) state.cursorPm = cursorPm;
  return fitBytes(state);
}

/** Drops the bulkiest optional fields until the state fits `LIVE_LIMITS.awarenessBytes`. */
function fitBytes(state: PeerState): PeerState {
  const limit = LIVE_LIMITS.awarenessBytes;
  if (bytesOf(state) <= limit) return state;
  const drops: ((s: PeerState) => void)[] = [
    (s) => {
      if (s.activity?.params) delete s.activity.params;
    },
    (s) => {
      if (s.sel?.slide && s.sel.slide.length > 20) s.sel.slide = s.sel.slide.slice(0, 20);
      if (s.sel?.canvas && s.sel.canvas.length > 20) s.sel.canvas = s.sel.canvas.slice(0, 20);
      if (s.sel?.document && s.sel.document.length > 20) s.sel.document = s.sel.document.slice(0, 20);
    },
    (s) => {
      delete s.cursorPm;
    },
    (s) => {
      delete s.activity;
    },
    (s) => {
      delete s.sel;
    },
  ];
  for (const drop of drops) {
    drop(state);
    if (bytesOf(state) <= limit) return state;
  }
  return { user: state.user, mode: state.mode };
}

/** A state as read from awareness (any client's, no identity forced): null when it isn't a peer's. */
export function readPeerState(input: unknown): PeerState | null {
  const user = userOf(recordOf(input)?.user);
  if (!user) return null;
  return sanitizePeerState(input, { user, viewOnly: false });
}

export interface Peer {
  clientId: number;
  user: PeerUser;
  state: PeerState;
  /** This app's own person (any of their tabs here). */
  self: boolean;
}

/**
 * Who is in the file, one entry per person or agent: several tabs of one person merge (this tab first, then the one
 * editing, then the one seen last). Ordered self first, then agents at work, then people editing, then agents and
 * people viewing; within a group by id, so faces don't jump around as states change.
 */
export function peersOf(awareness: Awareness): Peer[] {
  const local = awareness.clientID;
  const byUser = new Map<string, { clientId: number; state: PeerState; seen: number; self: boolean }[]>();
  for (const [clientId, raw] of awareness.getStates()) {
    const state = readPeerState(raw);
    if (!state) continue;
    const key = `${state.user.kind}:${state.user.id}`;
    const seen = awareness.meta.get(clientId)?.lastUpdated ?? 0;
    const list = byUser.get(key) ?? [];
    list.push({ clientId, state, seen, self: clientId === local });
    byUser.set(key, list);
  }
  const peers: Peer[] = [];
  for (const list of byUser.values()) {
    list.sort(
      (a, b) =>
        Number(b.self) - Number(a.self) ||
        Number(b.state.mode === "editing") - Number(a.state.mode === "editing") ||
        b.seen - a.seen ||
        a.clientId - b.clientId,
    );
    const best = list[0];
    if (!best) continue;
    const self = list.some((entry) => entry.self);
    const editing = list.some((entry) => entry.state.mode === "editing");
    const state: PeerState = editing && best.state.mode !== "editing" ? { ...best.state, mode: "editing" } : best.state;
    peers.push({ clientId: best.clientId, user: state.user, state, self });
  }
  return peers.sort((a, b) => rankOf(a) - rankOf(b) || (a.user.id < b.user.id ? -1 : a.user.id > b.user.id ? 1 : 0));
}

function rankOf(peer: Peer): number {
  if (peer.self) return 0;
  const editing = peer.state.mode === "editing";
  if (peer.user.kind === "agent") return editing ? 1 : 3;
  return editing ? 2 : 4;
}

/**
 * The awareness client id an agent's presence takes in a file (ADR 0196 §5): stable for a run, so whichever process
 * runs the agent's next tool call updates the same entry, a 32-bit number like Yjs' own, never 0.
 */
export function agentClientId(runId: string, agentId: string): number {
  const hash = fnv1a(`agent:${agentId}:${runId}`);
  return hash === 0 ? 1 : hash;
}
