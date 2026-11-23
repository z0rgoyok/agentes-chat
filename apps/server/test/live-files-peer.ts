import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";

/**
 * A person's app on a live file's socket (ADR 0196 §3), written on y-protocols alone, as any y-websocket peer would
 * be: so the server is held to the standard framing, not to our own client. It loads nothing over HTTP unless given
 * `state`, sends its sync step 1 and its presence on `live.ready`, answers the server's step 1, and sends every change
 * it makes. `text`: the phone's base64 text frames.
 */
export function livePeer(
  url: string,
  headers: Record<string, string>,
  options: { text?: boolean; state?: string } = {},
) {
  const remote = Symbol("remote");
  const doc = new Y.Doc();
  if (options.state) Y.applyUpdate(doc, new Uint8Array(Buffer.from(options.state, "base64")), remote);
  const awareness = new Awareness(doc);
  // Here, viewing, as the apps say when they open a file. Awareness starts every client at clock 0 with `{}`, a state
  // no other peer takes (y-protocols applies only a newer clock), so a peer that says nothing is in nobody's list.
  awareness.setLocalState({ mode: "viewing" });
  const controls: Record<string, unknown>[] = [];
  const errors: string[] = [];
  /** Everything the server sent, in order: each control's type, `sync:<kind>`, or `message:<type>`. */
  const inbox: string[] = [];
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const send = (bytes: Uint8Array) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(options.text ? Buffer.from(bytes).toString("base64") : bytes);
  };
  const awarenessMessage = (clients: number[]) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients));
    return encoding.toUint8Array(encoder);
  };
  const read = (bytes: Uint8Array) => {
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    // A sync message's kind is its second byte (0 step 1, 1 step 2, 2 update).
    inbox.push(type === 0 ? `sync:${bytes[1]}` : `message:${type}`);
    if (type === 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      readSyncMessage(decoder, encoder, doc, remote);
      if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
    } else if (type === 1) {
      applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), remote);
    } else if (type === 3) {
      send(awarenessMessage([doc.clientID]));
    }
  };
  ws.onmessage = (event) => {
    const data = event.data as string | ArrayBuffer;
    if (typeof data !== "string") return read(new Uint8Array(data));
    if (!data.startsWith("{")) return read(new Uint8Array(Buffer.from(data, "base64")));
    const control = JSON.parse(data) as Record<string, unknown>;
    controls.push(control);
    inbox.push(String(control.type));
    if (control.type === "live.error") errors.push(String(control.code));
    if (control.type !== "live.ready") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    writeSyncStep1(encoder, doc);
    send(encoding.toUint8Array(encoder));
    send(awarenessMessage([doc.clientID]));
  };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === remote) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  });
  awareness.on(
    "update",
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === "local") send(awarenessMessage([...added, ...updated, ...removed]));
    },
  );
  let closeCode: { code: number; reason: string } | null = null;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => {
      closeCode = { code: event.code, reason: event.reason };
      awareness.destroy();
      resolve(closeCode);
    });
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("the socket was refused")));
  });

  /** Waits for `done`, polling: what the server sends comes in its own time. */
  async function until(done: () => boolean, what: string, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (done()) return;
      await Bun.sleep(10);
    }
    const seen = JSON.stringify({ controls, closed: closeCode });
    throw new Error(`timed out waiting for ${what}: ${seen}`);
  }
  /** The first control frame `match` takes, waited for. */
  async function control(match: (c: Record<string, unknown>) => boolean, what: string, ms = 5000) {
    await until(() => controls.some(match), what, ms);
    return controls.find(match) as Record<string, unknown>;
  }

  return {
    ws,
    doc,
    awareness,
    controls,
    inbox,
    /** `live.error` codes, in order. */
    errors,
    opened,
    closed,
    until,
    control,
    /** `live.ready` (the mode the socket opened with). */
    ready: () => control((c) => c.type === "live.ready", "live.ready"),
    /** A frame as is (tests of what the server refuses). */
    raw: (data: string | Uint8Array) => ws.send(data),
    /** The document's sheets as the plan shapes them (ADR 0196 §2): the first one, once synced. */
    sheet: () => firstSheet(doc),
    close: () => ws.close(),
  };
}

export type LivePeer = ReturnType<typeof livePeer>;

/** The first sheet of a spreadsheet document: its id and its row and column ids. */
export function firstSheet(doc: Y.Doc) {
  const id = doc.getArray<string>("sheetOrder").get(0);
  const sheet = id ? doc.getMap<Y.Map<unknown>>("sheets").get(id) : undefined;
  if (!id || !sheet) return null;
  const rows = sheet.get("rows") as Y.Array<string> | undefined;
  const cols = sheet.get("cols") as Y.Array<string> | undefined;
  const cells = sheet.get("cells") as Y.Map<{ v?: unknown }> | undefined;
  if (!rows || !cols || !cells) return null;
  return { id, rows, cols, cells };
}

/** A cell's key by its place (`rowId:colId`, ADR 0196 §2). */
export function cellKey(doc: Y.Doc, row: number, col: number) {
  const sheet = firstSheet(doc);
  const rowId = sheet?.rows.get(row);
  const colId = sheet?.cols.get(col);
  return rowId && colId ? `${rowId}:${colId}` : null;
}

/** Writes a plain value in a cell, as one change of this document. */
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

/** An awareness message whose entries claim any client id (to see the server refuse what isn't the socket's). */
export function forgedAwareness(entries: { clientId: number; clock: number; state: unknown }[]) {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(inner, entry.clientId);
    encoding.writeVarUint(inner, entry.clock);
    encoding.writeVarString(inner, JSON.stringify(entry.state));
  }
  const outer = encoding.createEncoder();
  encoding.writeVarUint(outer, 1);
  encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
  return encoding.toUint8Array(outer);
}
