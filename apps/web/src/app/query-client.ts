import { ApiError } from "@agenteschat/client";
import { busyRetryDelay, retryBusy } from "@agenteschat/client/lib/busy-retry";
import { sessionEnded } from "@agenteschat/client/lib/errors";
import { LiveQueryClient } from "@agenteschat/client/lib/live-query-client";
import { MutationCache, QueryCache } from "@tanstack/react-query";

/** How long a read counts as fresh: shown again within it, a page asks the server nothing. */
export const STALE_MS = 30_000;
/** How long a page's data stays in memory once nothing shows it. */
export const KEEP_MS = 30 * 60_000;

/**
 * Queries show their errors inline; a
 * 401 anywhere means the session ended (back to sign-in); every failed write
 * gets a toast in the person's words.
 */
export function createQueryClient(handlers: {
  onUnauthorized: () => void;
  onMutationError: (message: string) => void;
  /** A failed write in the person's words (`errorText`). */
  describeError: (error: unknown) => string;
}) {
  return new LiveQueryClient({
    defaultOptions: {
      queries: {
        retry: retryBusy((count, error) => !(error instanceof ApiError && error.status < 500) && count < 2),
        retryDelay: busyRetryDelay,
        refetchOnWindowFocus: false,
        // The socket keeps what is cached current (its events update or invalidate it, and a reconnect reads it all
        // again), so a page shown again within this window shows what it has without asking the server once more.
        staleTime: STALE_MS,
        // A page left a while ago still opens with what it showed (and reads again in the background), not a skeleton.
        gcTime: KEEP_MS,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (sessionEnded(error)) handlers.onUnauthorized();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (sessionEnded(error)) return handlers.onUnauthorized();
        // Mutations that show their own inline error opt out with `meta: { silent: true }`.
        if (mutation.meta?.silent) return;
        handlers.onMutationError(handlers.describeError(error));
      },
    }),
  });
}
