import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeJson } from "./json-file";
import { bootId } from "./lock";

/**
 * An operator's standby (ADR 0176): `agentes-runner standby` asks the running runner to drop its link to the server
 * and keep everything else running (tasks, the agents' Chrome, their desktops, their programs and holds), so a pause of
 * the computer keeps them all; `agentes-runner resume` brings the link back. The ask is a file the runner reads the
 * moment it is written (and every second, should the watch miss it), answered in another once it applied it. It lapses
 * by itself, in the computer's own running time (`os.uptime`, which a paused computer doesn't count), unless asked
 * again, so a runner nobody resumes comes back.
 */

export const STANDBY_FILE = "standby.json";
export const STANDBY_ACK_FILE = "standby-ack.json";
/** How long a standby lasts, in running minutes, when not asked again. */
export const STANDBY_DEFAULT_MINUTES = 5;
export const STANDBY_MAX_MINUTES = 60;
/** How often the runner reads the ask besides watching it. */
export const STANDBY_POLL_MS = 1_000;

export interface StandbyAsk {
  id: string;
  /** The boot it was asked in: another boot's ask is void. */
  boot: string;
  /** `os.uptime()` seconds it lasts until; 0: resume. */
  until: number;
}

const file = (home: string, name: string) => path.join(home, name);

/** Writes the ask (`minutes` 0: resume) and returns it. */
export function askStandby(home: string, minutes: number, uptime = os.uptime()): StandbyAsk {
  const ask: StandbyAsk = { id: randomUUID(), boot: bootId(), until: minutes > 0 ? uptime + minutes * 60 : 0 };
  writeJson(file(home, STANDBY_FILE), ask);
  return ask;
}

export function readStandby(home: string): StandbyAsk | null {
  const ask = readJson<StandbyAsk>(file(home, STANDBY_FILE));
  return ask && typeof ask.id === "string" && typeof ask.until === "number" ? ask : null;
}

/** In force now: asked in this boot, and not lapsed. */
export function standbyOn(ask: StandbyAsk | null, uptime = os.uptime(), boot = bootId()): boolean {
  return ask !== null && ask.boot === boot && ask.until > uptime;
}

/**
 * A new ask in force that the runner turns down: a turn runs here (`turns`), and a standby would drop its link, a sleep
 * after it freeze it. `answered`: the last ask it answered; `inStandby`: it is in standby already (a renewal).
 */
export function refusesStandby(
  ask: StandbyAsk | null,
  answered: string | null,
  inStandby: boolean,
  turns: number,
  uptime = os.uptime(),
  boot = bootId(),
): boolean {
  return ask !== null && ask.id !== answered && !inStandby && turns > 0 && standbyOn(ask, uptime, boot);
}

/** The runner applied the ask `id`, or turned it down (`refused`, why, for the one who asked). */
export function ackStandby(home: string, id: string, refused?: string) {
  writeJson(file(home, STANDBY_ACK_FILE), refused ? { id, refused } : { id });
}

export function standbyAcked(home: string, id: string): boolean {
  return standbyAnswer(home, id) !== null;
}

/** The runner's answer to the ask `id`: null while none, else whether it turned it down and why. */
export function standbyAnswer(home: string, id: string): { refused: string | null } | null {
  const ack = readJson<{ id?: unknown; refused?: unknown }>(file(home, STANDBY_ACK_FILE));
  if (ack?.id !== id) return null;
  return { refused: typeof ack.refused === "string" ? ack.refused : null };
}

/**
 * Calls `onAsk` as soon as an ask is written: a resume right after the computer wakes from a snapshot puts it back on
 * the server at once instead of on the next poll. Returns how to stop watching; a folder that can't be watched
 * leaves the poll alone.
 */
export function watchStandby(home: string, onAsk: () => void): () => void {
  try {
    const watcher = watch(home, { persistent: false }, (_event, name) => {
      if (!name || String(name) === STANDBY_FILE) onAsk();
    });
    // Same typing gap as `watchConfig`: an unhandled "error" (the folder removed) would end the runner.
    (watcher as unknown as { on?: (event: "error", fn: () => void) => void }).on?.("error", () => watcher.close());
    return () => watcher.close();
  } catch {
    return () => {};
  }
}
