import type { PubSub } from "@agenteschat/adapters";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  type ArtifactActor,
  createLiveDocs,
  createLiveFile,
  type LiveConn,
  type LiveDeps,
  type LiveDocs,
  type LiveSession,
  type LiveTiming,
} from "../src";
import type { Fixture } from "./fixtures";

/**
 * Live files in engine tests (ADR 0196): `LiveDocs` instances standing for processes on one database, and a person's
 * app held in memory that talks to a session the way a socket would (y-protocols framing, asynchronously both ways).
 */

export const quietLog = { info() {}, warn() {}, error() {} };

/** Short waits, so a test sees what would take seconds. */
export const FAST: Partial<LiveTiming> = {
  coalesceMs: 10,
  tailCheckMs: 60_000,
  lingerMs: 50,
  relayMs: 5,
  announceMs: 60_000,
  agentLingerMs: 150,
  agentRenewMs: 50,
  progressiveMs: 400,
  stepMs: 25,
  retryMs: [10, 20],
  board: { debounceMs: 5, announceMs: 60_000, ttlMs: 40_000, channelMs: 5 },
};

/** A process holding live files: `replicaId` tells it apart. */
export function liveDocsFor(
  f: Fixture,
  replicaId: string,
  overrides: Partial<Omit<LiveDeps, "timing">> & { timing?: Partial<LiveTiming>; pubsub?: PubSub } = {},
): LiveDocs {
  const { timing, ...rest } = overrides;
  return createLiveDocs({
    ...f.artifactDeps,
    pubsub: f.pubsub,
    replicaId,
    log: quietLog,
    ...rest,
    timing: { ...FAST, ...timing },
  });
}

export const personActor = (userId: string): ArtifactActor => ({ type: "person", userId });

/** A live file the workspace owner makes in the shared Drive. */
export async function makeLiveFile(
  f: Fixture,
  kind: "spreadsheet" | "slides" | "canvas" = "spreadsheet",
  input: { title?: string; channelId?: string | null; actor?: ArtifactActor } = {},
) {
  return createLiveFile(f.artifactDeps, input.actor ?? personActor(f.owner.id), f.org.id, {
    kind,
    title: input.title ?? "Budget",
    channelId: input.channelId ?? null,
  });
}

/** Waits for `done`, polling: what a process sends comes in its own time. */
export async function until(done: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The first sheet of a spreadsheet document: its id, rows, columns and cells. */
export function firstSheet(doc: Y.Doc) {
  const id = doc.getArray<string>("sheetOrder").get(0);
  const sheet = id ? doc.getMap<Y.Map<unknown>>("sheets").get(id) : undefined;
  if (!id || !sheet) return null;
  const rows = sheet.get("rows") as Y.Array<string> | undefined;
  const cols = sheet.get("cols") as Y.Array<string> | undefined;
  const cells = sheet.get("cells") as Y.Map<{ v?: unknown }> | undefined;
  if (!rows || !cols || !cells) return null;
  return { id, sheet, rows, cols, cells };
}

/** A cell's key by its place (`rowId:colId`). */
export function cellKey(doc: Y.Doc, row: number, col: number) {
  const sheet = firstSheet(doc);
  const rowId = sheet?.rows.get(row);
  const colId = sheet?.cols.get(col);
  return rowId && colId ? `${rowId}:${colId}` : null;
}

/** Writes a plain value in a cell. */
export function setCell(doc: Y.Doc, row: number, col: number, value: string | number) {
  const sheet = firstSheet(doc);
  const key = cellKey(doc, row, col);
  if (!sheet || !key) throw new Error("the spreadsheet isn't loaded yet");
  sheet.cells.set(key, { v: value });
}

/** A cell's value, or undefined. */
export function cellValue(doc: Y.Doc, row: number, col: number) {
  const key = cellKey(doc, row, col);
  return key ? firstSheet(doc)?.cells.get(key)?.v : undefined;
}

/**
 * A person's app on a live file: its own document and presence, joined to `docs` as a socket would be. Frames go
 * both ways on a later microtask, never inside the sender's call (a socket's frames come in their own time).
 */
export async function openApp(
  docs: LiveDocs,
  orgId: string,
  fileId: string,
  userId: string,
  options: { mode?: "edit" | "view" } = {},
) {
  const remote = Symbol("remote");
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  const controls: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const closed: { code: number; reason?: string }[] = [];
  /** Binary frames the server sent, in order. */
  const frames: Uint8Array[] = [];
  let session: LiveSession | null = null;
  const waiting: Uint8Array[] = [];
  let ended = false;

  const toServer = (bytes: Uint8Array) => {
    if (ended) return;
    if (!session) {
      waiting.push(bytes);
      return;
    }
    const s = session;
    queueMicrotask(() => {
      try {
        s.message(bytes);
      } catch {
        // What the socket would say of a frame the document can't read.
        errors.push("invalid");
      }
    });
  };
  const awarenessFrame = (clients: number[]) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients));
    return encoding.toUint8Array(encoder);
  };
  const read = (bytes: Uint8Array) => {
    frames.push(bytes);
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      readSyncMessage(decoder, encoder, doc, remote);
      if (encoding.length(encoder) > 1) toServer(encoding.toUint8Array(encoder));
    } else if (type === 1) {
      applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), remote);
    }
  };
  const conn: LiveConn = {
    text: false,
    userId,
    mode: options.mode ?? "edit",
    send(data) {
      if (ended) return;
      if (typeof data === "string") {
        const control = JSON.parse(data) as Record<string, unknown>;
        controls.push(control);
        if (control.type === "live.error") errors.push(String(control.code));
        if (control.type === "live.ready") {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, 0);
          writeSyncStep1(encoder, doc);
          toServer(encoding.toUint8Array(encoder));
          if (awareness.getLocalState()) toServer(awarenessFrame([doc.clientID]));
        }
        return;
      }
      const copy = new Uint8Array(data);
      queueMicrotask(() => read(copy));
    },
    close(code, reason) {
      closed.push({ code, reason });
      ended = true;
      session?.leave();
    },
    buffered: () => 0,
  };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === remote) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    writeUpdate(encoder, update);
    toServer(encoding.toUint8Array(encoder));
  });
  awareness.on(
    "update",
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === "local") toServer(awarenessFrame([...added, ...updated, ...removed]));
    },
  );
  session = await docs.join(orgId, fileId, conn);
  for (const bytes of waiting.splice(0)) toServer(bytes);

  return {
    doc,
    awareness,
    controls,
    errors,
    closed,
    frames,
    session,
    /** Raw bytes as a socket frame (tests of what the document refuses). */
    raw: (bytes: Uint8Array) => toServer(bytes),
    /** The first control frame `match` takes. */
    control: (match: (c: Record<string, unknown>) => boolean) => controls.find(match),
    saved: () => controls.filter((c) => c.type === "live.saved").length,
    leave() {
      ended = true;
      session?.leave();
      awareness.destroy();
    },
  };
}

export type LiveApp = Awaited<ReturnType<typeof openApp>>;

/** The awareness state another app's client shows in `app`. */
export const stateIn = (app: LiveApp, clientId: number) =>
  app.awareness.getStates().get(clientId) as Record<string, unknown> | undefined;
