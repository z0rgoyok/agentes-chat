import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { LiveConnection, type LiveConnectionOptions, type LiveTiming, liveSocketUrl, type Timers } from "../src/index";
import { FakeLiveServer, type FakeLiveServerOptions } from "../src/live/testing";

/**
 * Helpers for the live files tests: a clock the test moves (timers and `now` together), and connections to an
 * in-memory server (`FakeLiveServer`) whose frames arrive a microtask later.
 */

export const FILE = "f0000000-0000-4000-8000-000000000001";
export const ORG = "o0000000-0000-4000-8000-000000000001";

export interface Clock {
  timers: Timers;
  now: () => number;
  /** Moves time forward, running every timer that comes due, in order. */
  advance(ms: number): void;
  /** Timers waiting. */
  pending(): number;
}

export function fakeClock(start = 1_000_000): Clock {
  let now = start;
  let nextId = 1;
  const tasks = new Map<number, { at: number; fn: () => void; every?: number }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      tasks.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (id) => {
      tasks.delete(id as number);
    },
    setInterval: (fn, ms) => {
      const id = nextId++;
      tasks.set(id, { at: now + Math.max(1, ms), fn, every: Math.max(1, ms) });
      return id;
    },
    clearInterval: (id) => {
      tasks.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (let guard = 0; guard < 100_000; guard++) {
      let nextKey = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of tasks) {
        if (t.at <= end && (t.at < nextAt || (t.at === nextAt && id < nextKey))) {
          nextKey = id;
          nextAt = t.at;
        }
      }
      const task = tasks.get(nextKey);
      if (!task) break;
      now = task.at;
      if (task.every) task.at += task.every;
      else tasks.delete(nextKey);
      task.fn();
    }
    now = end;
  };
  return { timers, now: () => now, advance, pending: () => tasks.size };
}

/** Quick waits for tests: what's below a few frames of real time. */
export const QUICK: Partial<LiveTiming> = { sendDelayMs: 20, awarenessMs: 60 };

export interface Peer {
  doc: Y.Doc;
  awareness: Awareness;
  connection: LiveConnection;
  /** Every state the connection went through. */
  states: LiveConnection["state"][];
  errors: string[];
  destroy(): void;
}

/** A connection to `server` as an app makes one (HTTP state first unless `loadState: false`). */
export function connect(
  server: FakeLiveServer,
  clock: Clock,
  options: Partial<Omit<LiveConnectionOptions, "loadState">> & {
    loadState?: LiveConnectionOptions["loadState"] | false;
  } = {},
  fileId = FILE,
): Peer {
  const doc = options.doc ?? new Y.Doc();
  const awareness = options.awareness ?? new Awareness(doc);
  const { loadState, ...rest } = options;
  const connection = new LiveConnection({
    url: liveSocketUrl("https://app.example.com", ORG, fileId, { textFrames: options.textFrames }),
    createSocket: server.socketFactory(),
    timers: clock.timers,
    now: clock.now,
    timing: QUICK,
    // Exact waits in tests (the jitter has its own test).
    backoffJitter: 0,
    ...rest,
    doc,
    awareness,
    ...(loadState === false ? {} : { loadState: loadState ?? (async () => server.loadState(fileId)) }),
  });
  const states: LiveConnection["state"][] = [];
  const errors: string[] = [];
  connection.subscribe((s) => states.push(s));
  connection.onError((code) => errors.push(code));
  connection.start();
  return {
    doc,
    awareness,
    connection,
    states,
    errors,
    destroy: () => {
      connection.stop();
      awareness.destroy();
      doc.destroy();
    },
  };
}

/** A server with one file holding a map `cells` (the connection doesn't care what kind of document it carries). */
export function serverWithFile(options: FakeLiveServerOptions = {}, mode: "edit" | "view" = "edit") {
  const server = new FakeLiveServer(options);
  server.addFile(FILE, {
    kind: "spreadsheet",
    mode,
    init: (doc) => doc.getMap<string>("cells").set("A1", "hello"),
  });
  return server;
}

export const cells = (doc: Y.Doc) => doc.getMap<string>("cells").toJSON() as Record<string, string>;
