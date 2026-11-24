import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * How long iOS's `inactive` still counts as in front for sockets and streams: it is also the notification shade,
 * Control Center, a Face ID or permission prompt, a call coming in and the app switcher, each a glance away that
 * mustn't drop the socket and read every screen again. Going home passes it on the way to `background`.
 */
export const INACTIVE_GRACE_MS = 10_000;

/**
 * Tells `listener` whether the app is in front as that changes: out at once in the background, and once `inactive`
 * lasted `inactiveGraceMs`. Returns the unsubscribe.
 */
export function followAppActive(listener: (active: boolean) => void, inactiveGraceMs = 0): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sub = AppState.addEventListener("change", (s) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (s === "inactive" && inactiveGraceMs > 0) timer = setTimeout(() => listener(false), inactiveGraceMs);
    else listener(s === "active");
  });
  return () => {
    if (timer) clearTimeout(timer);
    sub.remove();
  };
}

/**
 * Runs `connection` while the app is in front, through a glance away (`INACTIVE_GRACE_MS`): stopped in the background,
 * where the system would suspend it, started again once `beforeStart` is done (a fresh cookie) when the app comes back,
 * and checked (`checkAlive`) after a glance away. Returns the stop.
 */
export function keepWhileActive(
  connection: { start(): void; stop(): void; checkAlive(): void },
  beforeStart: () => Promise<unknown>,
): () => void {
  let active = AppState.currentState === "active";
  let gone = false;
  const start = () =>
    void beforeStart().then(() => {
      if (active && !gone) connection.start();
    });
  const off = followAppActive((now) => {
    if (now === active) {
      if (now) connection.checkAlive();
      return;
    }
    active = now;
    if (now) start();
    else connection.stop();
  }, INACTIVE_GRACE_MS);
  if (active) start();
  return () => {
    gone = true;
    off();
  };
}

/**
 * Whether the app is in front: a stream the person can't see is let go. `inactiveGraceMs` (`INACTIVE_GRACE_MS`) for
 * what a glance away shouldn't stop; without it `inactive` is out at once (marking read, timers the person watches).
 */
export function useAppActive(inactiveGraceMs = 0) {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => followAppActive(setActive, inactiveGraceMs), [inactiveGraceMs]);
  return active;
}
