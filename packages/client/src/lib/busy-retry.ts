import { ApiError } from "../api/http";

/** Tries of a read an overloaded server turned away (503 `server_busy`), each after the wait it asked for. */
export const BUSY_RETRIES = 6;

const busy = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 503 && error.code === "server_busy";

/**
 * A query's `retry`: a read the server was too busy for is tried again up to `BUSY_RETRIES` times, anything else as
 * `otherwise` says. With `busyRetryDelay`, the web and phone apps come back when the server said, not all at once.
 */
export const retryBusy =
  (otherwise: (failureCount: number, error: unknown) => boolean) => (failureCount: number, error: unknown) =>
    busy(error) ? failureCount < BUSY_RETRIES : otherwise(failureCount, error);

/** A query's `retryDelay`: the server's `Retry-After` when it gave one, else React Query's own doubling. */
export const busyRetryDelay = (failureCount: number, error: unknown) =>
  busy(error) && error.retryAfterMs ? error.retryAfterMs : Math.min(1000 * 2 ** failureCount, 30_000);
