import { type PurposeKind, SCENE_ACTIVITIES, SCENE_FACES } from "@agenteschat/client/lib/purpose-scene";
import { playAgentReaction, prefersReducedMotion } from "@agenteschat/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** The wake's step from one agent to the next (ADR 0162). */
export const WAKE_STEP_MS = 70;
/** The calm loop: the next agent says what it does this often. */
const WORK_EVERY_MS = 2500;

/** The engine's key for an agent of a card's drawing (its reactions, its seed). */
export const sceneAgentKey = (kind: PurposeKind, i: number) => `purpose-${kind}-${i}`;

/**
 * What a purpose drawing's agents are doing (ADR 0162), read by the drawing (`PurposeScene`). Nothing here changes a
 * size or a place: only who is awake, which agent is pointed at, which one is at work.
 */
export interface PurposeLife {
  /** The wake is running: z's pop off the agents. */
  waking: boolean;
  awake: (agent: number) => boolean;
  /** The agent pointed at. */
  hot: number | null;
  /** The agent at work: it bobs and, in the onboarding, says what it does. */
  working: number | null;
  /** The agent has something it does (`SCENE_ACTIVITIES`): pointing at it wakes it. */
  hasActivity: (agent: number) => boolean;
  /** An agent's place in the wake. */
  wakeOrder: (agent: number) => number;
  point: (agent: number | null) => void;
}

/** The wake's order: the agents with something they do, in their order, then the drawing's other agents. */
function wakeOrderOf(kind: PurposeKind): number[] {
  const busy = SCENE_ACTIVITIES[kind].map((a) => a.agent);
  const rest = SCENE_FACES[kind].flatMap((f, i) => ("look" in f && !busy.includes(i) ? [i] : []));
  return [...busy, ...rest];
}

/**
 * At rest the agents doze. Pointing at an agent wakes it with one hop. Choosing the answer wakes them in a quick wave
 * (a hop each, `WAKE_STEP_MS` apart); then one agent at a time is at work, every `WORK_EVERY_MS`, waiting while one is
 * pointed at. Unchosen, they doze again. Reduced motion: no wave, no hops, no loop; chosen is simply awake.
 */
export function usePurposeLife(kind: PurposeKind, chosen: boolean): PurposeLife {
  const order = useMemo(() => wakeOrderOf(kind), [kind]);
  const [woken, setWoken] = useState<ReadonlySet<number>>(() => new Set(chosen ? order : []));
  const [waking, setWaking] = useState(false);
  const [hot, setHot] = useState<number | null>(null);
  const [working, setWorking] = useState<number | null>(null);
  // The wake starts in the same render as the choice, so each z keeps its delay.
  const [seen, setSeen] = useState(chosen);
  if (seen !== chosen) {
    setSeen(chosen);
    setWaking(chosen && !prefersReducedMotion());
  }
  const hotNow = useRef(hot);
  hotNow.current = hot;
  const was = useRef(chosen);
  useEffect(() => {
    const before = was.current;
    was.current = chosen;
    if (!chosen) {
      setWoken(new Set());
      setWaking(false);
      setWorking(null);
      return;
    }
    const still = prefersReducedMotion();
    if (before || still) setWoken(new Set(order));
    if (still) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (!before) {
      order.forEach((agent, n) => {
        timers.push(
          setTimeout(() => {
            setWoken((s) => new Set(s).add(agent));
            playAgentReaction(sceneAgentKey(kind, agent), "up");
          }, n * WAKE_STEP_MS),
        );
      });
      timers.push(setTimeout(() => setWaking(false), order.length * WAKE_STEP_MS + 500));
    }
    const busy = SCENE_ACTIVITIES[kind];
    let n = 0;
    const loop = setInterval(() => {
      if (hotNow.current === null) setWorking(busy[n++ % busy.length]?.agent ?? null);
    }, WORK_EVERY_MS);
    return () => {
      for (const t of timers) clearTimeout(t);
      clearInterval(loop);
    };
  }, [chosen, kind, order]);
  const point = useCallback(
    (agent: number | null) => {
      setHot(agent);
      if (agent !== null && !prefersReducedMotion()) playAgentReaction(sceneAgentKey(kind, agent), "up");
    },
    [kind],
  );
  return useMemo(
    () => ({
      waking: chosen && waking,
      awake: (agent: number) => (chosen && woken.has(agent)) || hot === agent,
      hot,
      working: chosen ? working : null,
      hasActivity: (agent: number) => SCENE_ACTIVITIES[kind].some((a) => a.agent === agent),
      wakeOrder: (agent: number) => Math.max(0, order.indexOf(agent)),
      point,
    }),
    [chosen, waking, woken, hot, working, kind, order, point],
  );
}
