import { NavigationContext } from "expo-router/react-navigation";
import { useContext, useEffect, useState } from "react";

/** The longest a conversation waits for its push to end before what it holds back mounts anyway (ms). */
const SETTLE_MAX_MS = 900;

/** The one stack event read here (the native stack's `transitionEnd`, which the plain context type omits). */
type TransitionEvents = { addListener(event: "transitionEnd", listener: () => void): () => void };

/**
 * The routes whose conversation already landed: one swapped in place there (the screen keyed again by its params, no
 * slide) settles at once.
 */
const landed = new WeakSet<object>();

/**
 * False until the conversation's push has ended (its stack's `transitionEnd`): what its first frame doesn't show mounts
 * then, so the slide starts after a lighter first render. True at once where there is no slide: `now` (the iOS peek) or
 * a conversation swapped in place on a route that already landed; `SETTLE_MAX_MS` at the latest. Once true, it stays.
 */
export function useSettled(now: boolean): boolean {
  const navigation = useContext(NavigationContext) as unknown as (TransitionEvents & object) | undefined;
  const [settled, setSettled] = useState(() => now || (navigation !== undefined && landed.has(navigation)));
  useEffect(() => {
    if (settled) return;
    if (now) {
      setSettled(true);
      return;
    }
    const end = () => {
      if (navigation) landed.add(navigation);
      setSettled(true);
    };
    const timer = setTimeout(end, SETTLE_MAX_MS);
    const off = navigation?.addListener("transitionEnd", end);
    return () => {
      clearTimeout(timer);
      off?.();
    };
  }, [settled, now, navigation]);
  return settled || now;
}
