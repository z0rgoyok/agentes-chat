import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import type { LiveRun } from "../realtime/streams";
import { hintWords, toolItemsLive, toolPhrase } from "./work";

/**
 * The live work trail under an agent at work (web `WorkingTail`, phone `WorkingLine`): what it did so far, newest last,
 * in the lines its saved reply's work block will show (`toolItemsLive`, the same items in the same order), so the
 * reply takes its place without anything new to read. Its own words before a call are quoted above that call's line.
 */
export interface TrailLine {
  key: string;
  text: string;
  /** The agent's own words, quoted (else the app's line for a call). */
  said: boolean;
}

/** Lines shown at once; older ones fold into "+N". */
export const TRAIL_SHOWN = 3;
/** At most one new line this often: a burst of calls doesn't scroll past faster than it reads. */
export const TRAIL_PACE_MS = 3000;

/**
 * The trail's lines for a run's live work: each listed call in the app's voice ("Consultou o GitHub · list prs ×3"),
 * calls of the same kind in a row folded into one (as the work block folds them), its words before a call quoted above
 * it. The call running now and the words it says now are the line above the trail (`barStep`): never twice.
 */
export function workTrail(t: TFunction, run: Pick<LiveRun, "work" | "step">, locale?: string): TrailLine[] {
  const work = run.work ?? [];
  const said = new Map<string, string>();
  for (const w of work) if (w.kind === "call" && w.said) said.set(w.id, w.said);
  const now = run.step?.said;
  const lines: TrailLine[] = [];
  const items = toolItemsLive(work);
  items.forEach((item, i) => {
    if (item.kind !== "call") return;
    const l = item.line;
    // The call running now is what the line above says. Folded into calls of its kind already done, the line stays as
    // those: dropped while each runs and back when it ends, the trail would lose and gain a row at every call.
    const running = i === items.length - 1 && l.state === "run";
    if (running && l.count === 1) return;
    const done = running ? { ...l, state: "done" as const, count: l.count - 1 } : l;
    const words = said.get(l.key);
    if (words && words !== now)
      lines.push({ key: `${l.key}:said`, text: t("chat.wait.said", { text: words }), said: true });
    const count = done.count > 1 ? ` ${t("chat.work.times", { count: done.count })}` : "";
    const hint = hintWords(t, l);
    lines.push({ key: l.key, text: `${toolPhrase(t, done, locale)}${hint ? ` · ${hint}` : ""}${count}`, said: false });
  });
  return lines;
}

/** What the trail shows: the keys revealed so far, and when the last one was. */
export interface TrailPace {
  shown: string[];
  at: number;
}

/**
 * The next pace for `keys` (the trail's lines now) at `now`: lines already shown stay, a line gone is dropped, and at
 * most one new line is revealed per `TRAIL_PACE_MS`. With none shown yet (a conversation opened mid-run, a new run),
 * what is there shows at once: only what comes in while it is watched is paced. `due`: when the next waits to be
 * revealed (null: none waits).
 */
export function paceTrail(pace: TrailPace, keys: readonly string[], now: number): TrailPace & { due: number | null } {
  const present = new Set(keys);
  const shown = pace.shown.filter((k) => present.has(k));
  if (shown.length === 0 && keys.length > 0) return { shown: [...keys], at: now, due: null };
  const next = keys.find((k) => !shown.includes(k));
  if (next === undefined) return { shown, at: pace.at, due: null };
  if (now - pace.at < TRAIL_PACE_MS) return { shown, at: pace.at, due: pace.at + TRAIL_PACE_MS };
  const revealed = [...shown, next];
  const waiting = keys.some((k) => !revealed.includes(k));
  return { shown: revealed, at: now, due: waiting ? now + TRAIL_PACE_MS : null };
}

/**
 * The trail as it shows now: its newest `TRAIL_SHOWN` revealed lines, in order, and how many earlier ones fold into
 * "+N". New lines come in at `TRAIL_PACE_MS` at most; a line's text may change in place (its count, its end).
 */
export function usePacedTrail(lines: readonly TrailLine[]): { lines: TrailLine[]; earlier: number } {
  const keys = lines.map((l) => l.key);
  const signature = keys.join("\n");
  const pace = useRef<TrailPace>({ shown: [], at: 0 });
  const [, redraw] = useState(0);
  const next = paceTrail(pace.current, keys, Date.now());
  pace.current = { shown: next.shown, at: next.at };
  const due = next.due;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line, or one revealed, sets the next wake
  useEffect(() => {
    if (due === null) return;
    const timer = setTimeout(() => redraw((n) => n + 1), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [due, signature]);
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const revealed = next.shown.flatMap((k) => {
    const line = byKey.get(k);
    return line ? [line] : [];
  });
  return { lines: revealed.slice(-TRAIL_SHOWN), earlier: Math.max(0, revealed.length - TRAIL_SHOWN) };
}
