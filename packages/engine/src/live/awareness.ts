import { type PeerState, type PeerUser, readPeerState, sanitizePeerState } from "@agenteschat/live/awareness";
import {
  type AwarenessEntry,
  awarenessMessage,
  readAwarenessUpdate,
  writeAwarenessUpdate,
} from "@agenteschat/live/protocol";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type * as Y from "yjs";

/**
 * Who is in one live file, as the process that hosts it sees it (ADR 0196 §5): Yjs awareness, never stored. The
 * server owns identity. Each awareness client id belongs to the socket that first spoke for it (or to another process,
 * or to an agent's presence); a socket that claims a client id someone else holds is ignored, unless it is the same
 * person's own tab arriving from another socket or process. Every state a socket sends is rewritten by
 * `sanitizePeerState`: its person forced, unknown fields dropped, sizes capped, `viewing` on a read-only socket. A
 * person whose availability is hidden (ADR 0084) shows nowhere: their states are dropped before anyone sees them.
 */

/** Who holds a client id here. */
export type PresenceOwner =
  | { kind: "socket"; socket: object; user: PeerUser }
  | { kind: "replica"; replica: string; user: PeerUser }
  | { kind: "agent"; user: PeerUser };

/** A socket as presence sees it: whose it is, whether it may change the file, whether its person hides. */
export interface PresenceSocket {
  user: PeerUser;
  viewOnly: boolean;
  hidden: boolean;
}

/** Someone in a file, as the summaries and the presence route say it. */
export interface PresencePeer {
  kind: "person" | "agent";
  id: string;
  mode: "viewing" | "editing";
}

/** Origins of awareness changes that didn't come from a socket of this process. */
export const FROM_REPLICA = Symbol("live.awareness.replica");
export const FROM_AGENT = Symbol("live.awareness.agent");

/** The most bytes of awareness relayed in one pub/sub event, once in base64: NOTIFY takes under 7900 in all. */
export const AWARENESS_RELAY_BYTES = 6000;

/**
 * The client ids one socket may speak for (ADR 0196 §5). An app's socket carries one file and one awareness (one id);
 * a few more leave room for an app that makes its document again. Past this a socket's new ids are dropped, so one
 * socket can't fill the file with thousands of states, each relayed to everyone in it and to the other processes.
 */
export const MAX_SOCKET_CLIENTS = 4;

export interface DocPresenceHooks {
  /** States changed: `message` goes to this process's sockets on the file, all but `except` (the one it came from). */
  broadcast(message: Uint8Array, except: object | null): void;
  /** Client ids this process's sockets hold changed (or were removed): the other processes must hear of them. */
  relay(clientIds: number[]): void;
  /** Who is in the file changed: someone came or left, or started or stopped editing. */
  changed(): void;
}

/** A state's person or agent and mode, read without rewriting it (every state held here was checked on the way in). */
function peerOf(raw: unknown): PresencePeer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { user?: { kind?: unknown; id?: unknown }; mode?: unknown };
  const kind = o.user?.kind;
  const id = o.user?.id;
  if ((kind !== "person" && kind !== "agent") || typeof id !== "string") return null;
  return { kind, id, mode: o.mode === "editing" ? "editing" : "viewing" };
}

/** One entry per person or agent: editing wins over viewing. */
function merged(states: Iterable<unknown>): PresencePeer[] {
  const byUser = new Map<string, PresencePeer>();
  for (const raw of states) {
    const peer = peerOf(raw);
    if (!peer) continue;
    const key = `${peer.kind}:${peer.id}`;
    const seen = byUser.get(key);
    if (!seen || (seen.mode === "viewing" && peer.mode === "editing")) byUser.set(key, peer);
  }
  return [...byUser.values()];
}

export class DocPresence {
  readonly awareness: Awareness;
  private readonly owners = new Map<number, PresenceOwner>();
  /** The last summary `changed` was called for, to call it only when it differs. */
  private summary = "";

  constructor(
    doc: Y.Doc,
    private readonly hooks: DocPresenceHooks,
  ) {
    this.awareness = new Awareness(doc);
    // The server is no peer: its own (empty) state would show as someone in the file.
    this.awareness.setLocalState(null);
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) =>
        this.onUpdate([...added, ...updated, ...removed], removed, origin),
    );
  }

  private onUpdate(changed: number[], removed: number[], origin: unknown) {
    if (changed.length === 0) return;
    const known = changed.filter((id) => this.awareness.meta.has(id));
    if (known.length > 0) {
      const socket = typeof origin === "object" && origin !== null ? origin : null;
      this.hooks.broadcast(awarenessMessage(this.awareness, known), socket);
    }
    // What this process's sockets hold goes to the other processes; what came from them or an agent never goes back.
    if (origin !== FROM_REPLICA && origin !== FROM_AGENT) {
      const mine = changed.filter((id) => this.owners.get(id)?.kind === "socket");
      if (mine.length > 0) this.hooks.relay(mine);
    }
    for (const id of removed) {
      // A state that timed out or was removed elsewhere frees its client id; a socket's stays its own while it is open.
      if (this.owners.get(id)?.kind !== "socket") this.owners.delete(id);
    }
    this.noticeChange();
  }

  private noticeChange() {
    const summary = this.peers()
      .map((p) => `${p.kind}:${p.id}:${p.mode}`)
      .sort()
      .join(",");
    if (summary === this.summary) return;
    this.summary = summary;
    this.hooks.changed();
  }

  /**
   * The filter a socket's awareness goes through before it is applied (`readMessage`'s `filterAwareness`): the entry
   * rewritten, or null to drop it.
   */
  filter(socket: object, who: PresenceSocket, entry: AwarenessEntry): AwarenessEntry | null {
    const owner = this.owners.get(entry.clientId);
    const own = owner?.kind === "socket" && owner.socket === socket;
    if (entry.state === null) return own ? entry : null;
    if (who.hidden) return null;
    if (owner && !own) {
      // Someone else's client: only this same person's own tab, come over from another socket or process.
      if (owner.kind === "agent" || owner.user.kind !== "person" || owner.user.id !== who.user.id) return null;
    }
    if (!own && this.socketClients(socket).length >= MAX_SOCKET_CLIENTS) return null;
    const state = sanitizePeerState(entry.state, { user: who.user, viewOnly: who.viewOnly });
    if (!state) return null;
    this.owners.set(entry.clientId, { kind: "socket", socket, user: who.user });
    return { clientId: entry.clientId, clock: entry.clock, state };
  }

  /** Client ids a socket holds. */
  socketClients(socket: object): number[] {
    const ids: number[] = [];
    for (const [id, owner] of this.owners) if (owner.kind === "socket" && owner.socket === socket) ids.push(id);
    return ids;
  }

  /** A socket left (or its person now hides): its states go, for everyone, here and in the other processes. */
  dropSocket(socket: object, origin: object) {
    const ids = this.socketClients(socket);
    const shown = ids.filter((id) => this.awareness.states.has(id));
    if (shown.length > 0) removeAwarenessStates(this.awareness, shown, origin);
    for (const id of ids) this.owners.delete(id);
  }

  /** The states of `clientIds` as awareness updates, split so each fits `maxBytes` once in base64. */
  encode(clientIds: readonly number[], maxBytes = AWARENESS_RELAY_BYTES): Uint8Array[] {
    const known = clientIds.filter((id) => this.awareness.meta.has(id));
    const budget = Math.floor((maxBytes * 3) / 4) - 64;
    const parts: Uint8Array[] = [];
    let batch: number[] = [];
    let size = 0;
    for (const id of known) {
      const one = encodeAwarenessUpdate(this.awareness, [id]).byteLength;
      // One state alone is under 4 KiB (`LIVE_LIMITS.awarenessBytes`), so it always fits a part of its own.
      if (batch.length > 0 && size + one > budget) {
        parts.push(encodeAwarenessUpdate(this.awareness, batch));
        batch = [];
        size = 0;
      }
      batch.push(id);
      size += one;
    }
    if (batch.length > 0) parts.push(encodeAwarenessUpdate(this.awareness, batch));
    return parts;
  }

  /** Every client id this process's sockets hold with a state (what it re-announces). */
  ownedClients(): number[] {
    const ids: number[] = [];
    for (const [id, owner] of this.owners) if (owner.kind === "socket" && this.awareness.states.has(id)) ids.push(id);
    return ids;
  }

  /**
   * States from another process (`replica`): each kept only when no socket of this process holds that client id, and
   * applied as that process's (an agent's presence is told apart by its user, whichever process set it).
   */
  applyRemote(replica: string, update: Uint8Array) {
    const kept: AwarenessEntry[] = [];
    for (const entry of readAwarenessUpdate(update)) {
      const owner = this.owners.get(entry.clientId);
      if (owner?.kind === "socket") continue;
      if (entry.state === null) {
        if (owner?.kind === "replica" && owner.replica !== replica) continue;
        kept.push(entry);
        continue;
      }
      const state = readPeerState(entry.state);
      if (!state) continue;
      this.owners.set(
        entry.clientId,
        state.user.kind === "agent"
          ? { kind: "agent", user: state.user }
          : { kind: "replica", replica, user: state.user },
      );
      kept.push({ clientId: entry.clientId, clock: entry.clock, state });
    }
    if (kept.length > 0) applyAwarenessUpdate(this.awareness, writeAwarenessUpdate(kept), FROM_REPLICA);
  }

  /** An agent's presence set by this process (`state` null: gone), at the clock its owner chose. */
  applyAgent(clientId: number, clock: number, state: PeerState | null, user: PeerUser) {
    const owner = this.owners.get(clientId);
    if (owner && owner.kind !== "agent") return;
    if (state === null && !this.awareness.states.has(clientId)) return;
    if (state) this.owners.set(clientId, { kind: "agent", user });
    const current = this.awareness.meta.get(clientId)?.clock ?? 0;
    // A later clock wins; a removal at the clock of the state it removes is taken too.
    const at = Math.max(clock, state === null ? current : current + 1);
    applyAwarenessUpdate(this.awareness, writeAwarenessUpdate([{ clientId, clock: at, state }]), FROM_AGENT);
  }

  /** Who holds a client id. */
  ownerOf(clientId: number): PresenceOwner | undefined {
    return this.owners.get(clientId);
  }

  /** Who is in the file now, as this process knows: its sockets, other processes' and agents. */
  peers(): PresencePeer[] {
    return merged(this.awareness.getStates().values());
  }

  /** Who this process's sockets are (its summary to the other processes). */
  ownPeers(): PresencePeer[] {
    return merged(this.ownedClients().map((id) => this.awareness.states.get(id)));
  }

  /** Every known state as one awareness message (for a socket that just joined), or null when nobody is here. */
  everyone(): Uint8Array | null {
    const ids = [...this.awareness.getStates().keys()];
    return ids.length > 0 ? awarenessMessage(this.awareness, ids) : null;
  }

  destroy() {
    this.awareness.destroy();
    this.owners.clear();
  }
}
