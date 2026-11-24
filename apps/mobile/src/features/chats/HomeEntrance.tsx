import { useEffect, useState } from "react";
import { useRevealed } from "../launch/launched";

/** Once per launch: the first Conversas after the splash greets you; every other visit is just there. */
let played = false;

/**
 * Whether the first Conversas after launch greets you: from the moment it is in view (the splash's ring opening on
 * it, `useRevealed`), once per launch, never again while the app runs (coming back to the tab, a pull, a new day all
 * show it still). The home itself is already in place under the splash: nothing arrives over the ring.
 */
export function useHomeEntrance(): { armed: boolean; play: boolean } {
  const inView = useRevealed();
  const [armed] = useState(() => !played);
  useEffect(() => {
    if (armed && inView) played = true;
  }, [armed, inView]);
  return { armed, play: armed && inView };
}

/**
 * The right hand waking as the app opens: asleep under the splash, it opens its eyes `delay` after it left, the one
 * living thing that greets you; it stays where it is (a hop on a spring there made the home bounce as it opened).
 * Unarmed, it is just awake.
 */
export function useWake(armed: boolean, play: boolean, delay = 300) {
  const [awake, setAwake] = useState(!armed);
  useEffect(() => {
    if (!play || awake) return;
    const timer = setTimeout(() => setAwake(true), delay);
    return () => clearTimeout(timer);
  }, [play, awake, delay]);
  return { mode: awake ? ("idle" as const) : ("sleep" as const) };
}
