import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "./connection";

/** A drop shorter than this shows nothing: the connection retries by itself and most drops end well before. */
export const RECONNECT_QUIET_MS = 120_000;
/** While the pill shows, its cause is read again this often (the network back, the server still down). */
export const RECONNECT_RECHECK_MS = 15_000;

/** Why the app's live connection is down: no internet on this device, the server not answering, or signed out. */
export type ReconnectCause = "device" | "server" | "signedOut";

/**
 * The cause, in that order: the device says it has no network; else the server, asked who is signed in (`me`, null
 * when nobody is), answers no one; else the server isn't answering or the live connection alone is down.
 */
export async function reconnectCause(deviceOffline: boolean, me: () => Promise<unknown>): Promise<ReconnectCause> {
  if (deviceOffline) return "device";
  try {
    return (await me()) === null ? "signedOut" : "server";
  } catch {
    return "server";
  }
}

/**
 * The "Reconnecting…" pill's cause, or null while it stays hidden: nothing for the first `RECONNECT_QUIET_MS` of a
 * dropped connection, then its cause, read again every `RECONNECT_RECHECK_MS`, until the connection opens again.
 * `recheck` reads it at once (after a "Try again now").
 */
export function useReconnectCause(
  status: ConnectionStatus,
  check: () => Promise<ReconnectCause>,
): { cause: ReconnectCause | null; recheck: () => void } {
  const [cause, setCause] = useState<ReconnectCause | null>(null);
  const [shown, setShown] = useState(false);
  const latest = useRef(check);
  latest.current = check;
  const dropped = status === "reconnecting";
  useEffect(() => {
    setShown(false);
    setCause(null);
    if (!dropped) return;
    const timer = setTimeout(() => setShown(true), RECONNECT_QUIET_MS);
    return () => clearTimeout(timer);
  }, [dropped]);
  const [ask, setAsk] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ask` is the "read it again now"
  useEffect(() => {
    if (!shown) return;
    let live = true;
    const read = () =>
      void latest.current().then((c) => {
        if (live) setCause(c);
      });
    read();
    const every = setInterval(read, RECONNECT_RECHECK_MS);
    return () => {
      live = false;
      clearInterval(every);
    };
  }, [shown, ask]);
  return { cause: shown ? cause : null, recheck: () => setAsk((n) => n + 1) };
}
