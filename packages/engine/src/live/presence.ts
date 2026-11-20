import { livePresenceTopic, type PubSub, type RealtimeEvent, type Unsubscribe } from "@agenteschat/adapters";
import { publishChannelEvent } from "../events";
import type { PresencePeer } from "./awareness";

/**
 * Who is in each live file, for the Drive's and messages' cards (ADR 0196 §5): `GET …/live/presence` may land on a
 * process that hosts none of the files it asks about, so each process tells the others, on one server-side topic,
 * who its own sockets and agents are in each file it holds: when that changes (at most once a `debounceMs` per file),
 * again every `announceMs`, and when a process that just started asks. What another process said lasts `ttlMs`
 * unless said again, so a process that dies takes its people out of the cards on its own. Files in a conversation
 * also get the channel event `live.presence` (the file's id only) so the apps showing their cards ask again.
 */

export interface PresenceBoardTiming {
  debounceMs: number;
  announceMs: number;
  ttlMs: number;
  channelMs: number;
}

export const PRESENCE_BOARD_TIMING: PresenceBoardTiming = {
  debounceMs: 1000,
  announceMs: 15_000,
  ttlMs: 40_000,
  channelMs: 2000,
};

/** The most bytes of JSON one summary event carries: NOTIFY takes under 7900 with its envelope. */
const SUMMARY_BYTES = 6000;

/** A file's people as one event packs them: `[kind, id, mode]` with `p`/`a` and `v`/`e`. */
type Packed = [string, string, string];

const pack = (p: PresencePeer): Packed => [p.kind === "agent" ? "a" : "p", p.id, p.mode === "editing" ? "e" : "v"];

function unpack(value: unknown): PresencePeer | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [k, id, m] = value as unknown[];
  if ((k !== "p" && k !== "a") || typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  return { kind: k === "a" ? "agent" : "person", id, mode: m === "e" ? "editing" : "viewing" };
}

export interface PresenceBoardDeps {
  pubsub: PubSub;
  replicaId: string;
  /** Who this process's sockets and agents are in each file it holds (empty when nobody of its own is there). */
  own(fileId: string): PresencePeer[];
  /** The files this process holds or keeps agents' presence in now. */
  files(): string[];
  /** A file's conversation (its cards get `live.presence`), or null for the shared Drive. */
  channelOf(fileId: string): string | null;
  timing?: Partial<PresenceBoardTiming>;
  now?: () => number;
}

export function createPresenceBoard(deps: PresenceBoardDeps) {
  const timing = { ...PRESENCE_BOARD_TIMING, ...deps.timing };
  const now = deps.now ?? Date.now;
  /** What other processes said: by file, by process, until when. */
  const remote = new Map<string, Map<string, { peers: PresencePeer[]; until: number }>>();
  /** What this process last said of each file (as a key), so an unchanged one isn't sent again before its time. */
  const said = new Map<string, string>();
  const due = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const channelDue = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  const keyOf = (peers: PresencePeer[]) =>
    peers
      .map((p) => `${p.kind}:${p.id}:${p.mode}`)
      .sort()
      .join(",");

  let answeredAt = 0;

  function receive(event: RealtimeEvent) {
    if (event.from === deps.replicaId || typeof event.from !== "string") return;
    if (event.type === "live.presence?") {
      // A process that just started asks who is where: everything this one holds, at most once a second.
      const t = now();
      if (t - answeredAt < 1000) return;
      answeredAt = t;
      void announce([...deps.files(), ...said.keys()]);
      return;
    }
    if (event.type !== "live.presence") return;
    const files = event.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return;
    const until = now() + timing.ttlMs;
    for (const [fileId, list] of Object.entries(files as Record<string, unknown>)) {
      const peers = Array.isArray(list) ? list.map(unpack).filter((p): p is PresencePeer => p !== null) : [];
      let byReplica = remote.get(fileId);
      if (peers.length === 0) {
        byReplica?.delete(event.from);
        if (byReplica?.size === 0) remote.delete(fileId);
        continue;
      }
      if (!byReplica) {
        byReplica = new Map();
        remote.set(fileId, byReplica);
      }
      byReplica.set(event.from, { peers, until });
    }
  }

  /** Sends what this process holds of `fileIds` (all of them: every file it holds), in events that fit NOTIFY. */
  async function announce(fileIds: Iterable<string>) {
    const files: Record<string, Packed[]> = {};
    let size = 0;
    const sends: Promise<void>[] = [];
    const flush = () => {
      if (Object.keys(files).length === 0) return;
      const event = { type: "live.presence", from: deps.replicaId, files: { ...files } };
      sends.push(deps.pubsub.publish(livePresenceTopic, event).catch(() => {}));
      for (const key of Object.keys(files)) delete files[key];
      size = 0;
    };
    for (const fileId of new Set(fileIds)) {
      const peers = deps.own(fileId);
      const key = keyOf(peers);
      if (peers.length === 0 && !said.has(fileId)) continue;
      // A file's own entry is at most a few hundred people; past the budget alone it goes in parts of its own.
      const packed = peers.map(pack);
      const entry = JSON.stringify(packed).length + fileId.length + 4;
      if (size + entry > SUMMARY_BYTES) flush();
      files[fileId] = entry > SUMMARY_BYTES ? packed.slice(0, Math.floor(SUMMARY_BYTES / 60)) : packed;
      size += Math.min(entry, SUMMARY_BYTES);
      if (peers.length === 0) said.delete(fileId);
      else said.set(fileId, key);
    }
    flush();
    await Promise.all(sends);
  }

  function schedule() {
    if (timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      const files = [...due];
      due.clear();
      void announce(files);
    }, timing.debounceMs);
    unref(timer);
  }

  /** Someone of this process came to `fileId`, left it, or started or stopped editing in it. */
  function changed(fileId: string) {
    if (stopped) return;
    const key = keyOf(deps.own(fileId));
    if ((said.get(fileId) ?? "") === key && !due.has(fileId)) {
      nudgeChannel(fileId);
      return;
    }
    due.add(fileId);
    schedule();
    nudgeChannel(fileId);
  }

  /** The file's conversation hears `live.presence`, at most once a `channelMs`. */
  function nudgeChannel(fileId: string) {
    const channelId = deps.channelOf(fileId);
    if (!channelId || channelDue.has(fileId)) return;
    const at = setTimeout(() => {
      channelDue.delete(fileId);
      void publishChannelEvent(deps.pubsub, { type: "live.presence", channelId, artifactId: fileId });
    }, timing.channelMs);
    unref(at);
    channelDue.set(fileId, at);
  }

  const off: Unsubscribe = deps.pubsub.subscribe(livePresenceTopic, receive);
  void deps.pubsub.publish(livePresenceTopic, { type: "live.presence?", from: deps.replicaId }).catch(() => {});
  const every = setInterval(() => {
    const t = now();
    for (const [fileId, byReplica] of remote) {
      for (const [replica, entry] of byReplica) if (entry.until <= t) byReplica.delete(replica);
      if (byReplica.size === 0) remote.delete(fileId);
    }
    void announce([...deps.files(), ...said.keys()]);
  }, timing.announceMs);
  unref(every);

  return {
    changed,
    /** Everything again (after a LISTEN gap other processes may have missed what was said). */
    announceAll: () => announce([...deps.files(), ...said.keys()]),
    /** What other processes said of `fileId`, still fresh. */
    remoteOf(fileId: string): PresencePeer[] {
      const byReplica = remote.get(fileId);
      if (!byReplica) return [];
      const t = now();
      const out: PresencePeer[] = [];
      for (const entry of byReplica.values()) if (entry.until > t) out.push(...entry.peers);
      return out;
    },
    /** This process leaves: its people go from the others' cards at once. */
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      clearInterval(every);
      for (const at of channelDue.values()) clearTimeout(at);
      channelDue.clear();
      off();
      const ids = [...said.keys()];
      said.clear();
      // About 45 bytes a file: a hundred files an event stays well under NOTIFY's limit.
      for (let i = 0; i < ids.length; i += 100) {
        const files = Object.fromEntries(ids.slice(i, i + 100).map((id) => [id, [] as Packed[]]));
        await deps.pubsub
          .publish(livePresenceTopic, { type: "live.presence", from: deps.replicaId, files })
          .catch(() => {});
      }
    },
  };
}

export type PresenceBoard = ReturnType<typeof createPresenceBoard>;

/** Timers that never keep a process alive on their own. */
export function unref(timer: unknown) {
  (timer as { unref?: () => void } | null)?.unref?.();
}
