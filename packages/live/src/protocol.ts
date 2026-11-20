import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { type Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { writeSyncStep1, writeSyncStep2, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";

/**
 * The live file socket's messages (ADR 0196 §3), the same on the server and in every app. Binary frames use
 * y-websocket's framing, so they interoperate with any y-protocols peer: an outer varuint (0 sync, 1 awareness,
 * 3 query awareness; no auth message, since the upgrade is the authorization) and then y-protocols' own messages
 * (sync step 1, step 2, update; an awareness update). Control messages are JSON text frames.
 */

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_QUERY_AWARENESS = 3;

/** y-protocols' sync message types, inside a `MSG_SYNC` frame. */
export const SYNC_STEP1 = 0;
export const SYNC_STEP2 = 1;
export const SYNC_UPDATE = 2;

export type LiveMode = "edit" | "view";

export type LiveErrorCode = "read_only" | "too_large" | "invalid" | "rate";

export type LiveControl =
  | { type: "live.ready"; mode: LiveMode; seq: number }
  | { type: "live.mode"; mode: LiveMode }
  /** Everything this socket sent up to now is stored. */
  | { type: "live.saved"; seq: number }
  /** A version was written: refresh the history. */
  | { type: "live.versions" }
  | { type: "live.error"; code: LiveErrorCode };

/** Close codes, the desktop streams' numbers (ADR 0196 §3): the apps reconnect after any but 4403 and 4404. */
export const LIVE_CLOSE = {
  badRequest: 4400,
  forbidden: 4403,
  notFound: 4404,
  tooMany: 4429,
  behind: 1013,
  goingAway: 1001,
  internal: 1011,
} as const;

/** Whether the apps should open the socket again after it closed with `code`. */
export function liveShouldReconnect(code: number): boolean {
  return code !== LIVE_CLOSE.forbidden && code !== LIVE_CLOSE.notFound;
}

/** A frame that isn't one of ours, or an update Yjs can't read. */
export class LiveProtocolError extends Error {
  readonly code = "invalid" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LiveProtocolError";
  }
}

/** Sync step 1: our state vector, asking the other side for what we lack. */
export function syncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** Sync step 2: what the other side lacks, given its state vector (everything without one). */
export function syncStep2(doc: Y.Doc, stateVector?: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  writeSyncStep2(encoder, doc, stateVector);
  return encoding.toUint8Array(encoder);
}

/** An update as it happens. */
export function updateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** The awareness states of `clients` (a client without a state goes as a removal); unknown clients are skipped. */
export function awarenessMessage(awareness: Awareness, clients: number[]): Uint8Array {
  const known = clients.filter((id) => awareness.meta.has(id));
  return awarenessUpdateMessage(encodeAwarenessUpdate(awareness, known));
}

/** An awareness update already encoded (to forward one as it came). */
export function awarenessUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Asks the other side for every awareness state it knows. */
export function queryAwarenessMessage(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_QUERY_AWARENESS);
  return encoding.toUint8Array(encoder);
}

/** One client's entry in an awareness update: its state (`null` = gone) and the clock that orders its states. */
export interface AwarenessEntry {
  clientId: number;
  clock: number;
  state: unknown;
}

/** The entries of an encoded awareness update (throws `LiveProtocolError` on a malformed one). */
export function readAwarenessUpdate(update: Uint8Array): AwarenessEntry[] {
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const entries: AwarenessEntry[] = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const state: unknown = JSON.parse(decoding.readVarString(decoder));
      entries.push({ clientId, clock, state });
    }
    return entries;
  } catch (error) {
    throw new LiveProtocolError("Malformed awareness update", { cause: error });
  }
}

/** Encodes entries as an awareness update (the inverse of `readAwarenessUpdate`). */
export function writeAwarenessUpdate(entries: readonly AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state ?? null));
  }
  return encoding.toUint8Array(encoder);
}

export interface ReadContext {
  doc: Y.Doc;
  awareness: Awareness;
  /** The transaction origin for what this message changes (the socket on the server, `REMOTE` in the apps). */
  origin: unknown;
  /** False on a read-only socket: sync step 2 and updates are refused without touching the document. */
  allowWrite: boolean;
  /**
   * The server's say over awareness (ADR 0196 §5): each entry goes through it before it is applied, and comes back
   * rewritten (the person's identity forced, the state sanitized) or `null` to drop it.
   */
  filterAwareness?: (entry: AwarenessEntry) => AwarenessEntry | null;
}

export interface ReadResult {
  type: "sync" | "awareness" | "query";
  /** What to send back on the same socket: step 2 for a step 1, the known states for a query. */
  reply?: Uint8Array;
  /** A write on a read-only socket, refused. */
  rejected?: boolean;
  /**
   * What the message changed: for sync, the update as the document took it in (nothing when it held nothing new, so a
   * repeated or empty update isn't stored twice); for awareness, the update as applied (after `filterAwareness`).
   */
  update?: Uint8Array;
  /** Something threw after the change was applied (an observer): the change is in the document all the same. */
  error?: unknown;
}

/**
 * Reads one binary message. Sync: a step 1 gets its step 2 as `reply`; a step 2 or update is applied with `origin`,
 * unless `allowWrite` is false (then `rejected`). Awareness: applied with `origin` (through `filterAwareness`). A
 * query gets every known state as `reply`. A frame that isn't one of ours throws `LiveProtocolError`.
 */
export function readMessage(bytes: Uint8Array, ctx: ReadContext): ReadResult {
  let decoder: decoding.Decoder;
  let type: number;
  try {
    decoder = decoding.createDecoder(bytes);
    type = decoding.readVarUint(decoder);
  } catch (error) {
    throw new LiveProtocolError("Empty or malformed frame", { cause: error });
  }
  if (type === MSG_SYNC) return readSync(decoder, ctx);
  if (type === MSG_AWARENESS) return readAwareness(decoder, ctx);
  if (type === MSG_QUERY_AWARENESS) {
    const clients = [...ctx.awareness.getStates().keys()];
    return clients.length ? { type: "query", reply: awarenessMessage(ctx.awareness, clients) } : { type: "query" };
  }
  throw new LiveProtocolError(`Unknown message type ${type}`);
}

function readSync(decoder: decoding.Decoder, ctx: ReadContext): ReadResult {
  let kind: number;
  let payload: Uint8Array;
  try {
    kind = decoding.readVarUint(decoder);
    payload = decoding.readVarUint8Array(decoder);
  } catch (error) {
    throw new LiveProtocolError("Malformed sync message", { cause: error });
  }
  if (kind === SYNC_STEP1) {
    try {
      return { type: "sync", reply: syncStep2(ctx.doc, payload) };
    } catch (error) {
      throw new LiveProtocolError("Malformed state vector", { cause: error });
    }
  }
  if (kind !== SYNC_STEP2 && kind !== SYNC_UPDATE) throw new LiveProtocolError(`Unknown sync message ${kind}`);
  if (!ctx.allowWrite) return { type: "sync", rejected: true };
  let applied: Uint8Array | null = null;
  const listen = (update: Uint8Array, origin: unknown) => {
    if (origin === ctx.origin) applied = applied ? Y.mergeUpdates([applied, update]) : update;
  };
  ctx.doc.on("update", listen);
  let failure: unknown = null;
  try {
    Y.applyUpdate(ctx.doc, payload, ctx.origin);
  } catch (error) {
    failure = error ?? new Error("update failed");
  } finally {
    ctx.doc.off("update", listen);
  }
  const update = applied as Uint8Array | null;
  if (failure !== null && update === null) throw new LiveProtocolError("Malformed update", { cause: failure });
  const result: ReadResult = { type: "sync" };
  if (update) result.update = update;
  if (failure !== null) result.error = failure;
  return result;
}

function readAwareness(decoder: decoding.Decoder, ctx: ReadContext): ReadResult {
  let update: Uint8Array;
  try {
    update = decoding.readVarUint8Array(decoder);
  } catch (error) {
    throw new LiveProtocolError("Malformed awareness message", { cause: error });
  }
  if (ctx.filterAwareness) {
    const kept: AwarenessEntry[] = [];
    for (const entry of readAwarenessUpdate(update)) {
      const next = ctx.filterAwareness(entry);
      if (next) kept.push(next);
    }
    if (!kept.length) return { type: "awareness" };
    update = writeAwarenessUpdate(kept);
  }
  try {
    applyAwarenessUpdate(ctx.awareness, update, ctx.origin);
  } catch (error) {
    throw new LiveProtocolError("Malformed awareness update", { cause: error });
  }
  return { type: "awareness", update: update.slice() };
}

/** The client's keep-alive and the server's answer (JSON text frames, as on `/api/ws`). */
export const LIVE_PING = '{"type":"ping"}';
export const LIVE_PONG = '{"type":"pong"}';
/**
 * The answer while some of the changes the socket sent before its ping still wait to be stored: the app keeps them
 * as unsent until `live.saved`. A plain `LIVE_PONG` says every one of them is stored, or held nothing new.
 */
export const LIVE_PONG_UNSAVED = '{"type":"pong","unsaved":true}';

/** Whether a text frame is the keep-alive ping (the only control a client sends). */
export function isLivePing(text: string): boolean {
  return controlType(text) === "ping";
}

/** Whether a text frame is the server's answer to a ping. */
export function isLivePong(text: string): boolean {
  return controlType(text) === "pong";
}

/** Whether a pong says changes sent before its ping still wait to be stored (`LIVE_PONG_UNSAVED`). */
export function pongUnsaved(text: string): boolean {
  try {
    const raw: unknown = JSON.parse(text);
    return typeof raw === "object" && raw !== null && (raw as { unsaved?: unknown }).unsaved === true;
  } catch {
    return false;
  }
}

/** A control message as its text frame. */
export function controlText(control: LiveControl): string {
  return JSON.stringify(control);
}

const MODES: readonly string[] = ["edit", "view"];
const ERROR_CODES: readonly string[] = ["read_only", "too_large", "invalid", "rate"];

/** A control text frame, or null when it isn't one (pings and pongs included: see `isLivePong`). */
export function parseControl(text: string): LiveControl | null {
  if (text.length > 4096) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case "live.ready": {
      const mode = modeOf(o.mode);
      const seq = seqOf(o.seq);
      return mode && seq !== null ? { type: "live.ready", mode, seq } : null;
    }
    case "live.mode": {
      const mode = modeOf(o.mode);
      return mode ? { type: "live.mode", mode } : null;
    }
    case "live.saved": {
      const seq = seqOf(o.seq);
      return seq !== null ? { type: "live.saved", seq } : null;
    }
    case "live.versions":
      return { type: "live.versions" };
    case "live.error": {
      // A code from a newer server still reads as an error.
      const code = typeof o.code === "string" && ERROR_CODES.includes(o.code) ? (o.code as LiveErrorCode) : "invalid";
      return { type: "live.error", code };
    }
    default:
      return null;
  }
}

function controlType(text: string): string | null {
  if (text.length > 64) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string"
      ? (raw as { type: string }).type
      : null;
  } catch {
    return null;
  }
}

function modeOf(value: unknown): LiveMode | null {
  return typeof value === "string" && MODES.includes(value) ? (value as LiveMode) : null;
}

function seqOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
