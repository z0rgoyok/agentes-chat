/**
 * Reconnect waits shared by every long-lived socket to the server (the apps' realtime socket, the runner's link):
 * exponential steps with full jitter, so clients a restart dropped together spread over the whole step instead of
 * coming back in a wave.
 */

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_CAP_MS = 60_000;
/** How long a connection must stay up before its next drop starts the waits over from the first step. */
export const RECONNECT_HEALTHY_MS = 30_000;

/** The step for `attempt` (0-based): 1 s, 2 s, 4 s… up to 60 s. */
export function reconnectStep(attempt: number, base = RECONNECT_BASE_MS, cap = RECONNECT_CAP_MS): number {
  return Math.min(cap, base * 2 ** Math.min(Math.max(0, attempt), 30));
}

/** A random wait in [0, step) ("full jitter"); `random` in [0, 1). */
export function reconnectDelay(attempt: number, random: () => number = Math.random, step = reconnectStep(attempt)) {
  return Math.floor(random() * step);
}

/**
 * The wait after a server asked for `retryAfterMs` at least: never sooner, and spread over another as long (or the
 * step, if longer), so the clients it turned away don't all come back at its first allowed moment.
 */
export function waitAfterRetryHint(retryAfterMs: number, step: number, random: () => number = Math.random) {
  return retryAfterMs + Math.floor(random() * Math.max(step, retryAfterMs));
}

const RETRY_AFTER = /retry-after=(\d{1,5})/;

/** A close reason that asks the client to wait `seconds` before it dials again. */
export const retryAfterReason = (seconds: number, why = "try again") => `${why}; retry-after=${Math.round(seconds)}`;

/** The wait a close reason asks for (`retryAfterReason`), in ms, at most the longest reconnect step; null without one. */
export function retryAfterFromReason(reason: string | undefined | null): number | null {
  const m = reason ? RETRY_AFTER.exec(reason) : null;
  return m ? Math.min(RECONNECT_CAP_MS, Number(m[1]) * 1000) : null;
}
