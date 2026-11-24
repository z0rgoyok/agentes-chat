import type { LiveRun, Message } from "@agenteschat/client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { tapHaptic } from "../../shared/parts";
import { stoppedOf } from "../turn";

/** The latest of a function behind one that never changes: what it is handed to isn't redrawn when the function is. */
export function useLatest<A extends unknown[], R>(fn: (...args: A) => R) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/**
 * A value kept outside the screen's state (how far up the person reads, the day at the top of the list): only what
 * reads it (`useValueOf`) redraws when it changes, and setting it again to the same value tells no one.
 */
export interface ValueStore<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const useValueOf = <T>(store: ValueStore<T>) => useSyncExternalStore(store.subscribe, store.get, store.get);

/** How long a run gone from the live list waits for its reply before it is forgotten (no tap for it). */
const TURN_REPLY_WAIT_MS = 30_000;

/**
 * An agent's turn ending here is felt, lightly and once: its run seen at work leaves and its reply is listed. Only
 * with this conversation in front and at its end (the reply lands in view); never for a turn that was stopped or
 * failed, which say so themselves.
 */
export function useTurnEndTap(runs: LiveRun[], list: Message[], inFront: boolean, atEnd: () => boolean) {
  const turnsRef = useRef(new Map<string, { quiet: boolean; goneAt: number | null }>());
  useEffect(() => {
    const turns = turnsRef.current;
    const atWork = new Set<string>();
    for (const r of runs) {
      if (r.provisional) continue;
      atWork.add(r.runId);
      const quiet = Boolean(r.stopping) || r.status === "failed";
      turns.set(r.runId, { quiet: quiet || (turns.get(r.runId)?.quiet ?? false), goneAt: null });
    }
    const now = Date.now();
    let ended = false;
    for (const [runId, turn] of turns) {
      if (atWork.has(runId)) continue;
      const reply = list.findLast((m) => m.agentRunId === runId);
      if (reply) {
        turns.delete(runId);
        if (!turn.quiet && !stoppedOf(reply.meta)) ended = true;
      } else if (turn.goneAt === null) turn.goneAt = now;
      else if (now - turn.goneAt > TURN_REPLY_WAIT_MS) turns.delete(runId);
    }
    if (ended && inFront && atEnd() && AppState.currentState === "active") tapHaptic();
  }, [runs, list, inFront, atEnd]);
}
