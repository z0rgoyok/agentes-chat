import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { createApi } from "@/lib/api";
import { type authClient, readCookie } from "@/lib/auth";
import { accountTwin, forgetAccount, markSignedIn, markSignedOut, rememberAccount, setServer } from "@/lib/server";

export interface SessionState {
  /** Signed in (a session from the server or SecureStore's cache). */
  signedIn: boolean;
  /** Still checking (first launch, no cache yet). */
  pending: boolean;
  user: { id: string; name: string; email: string } | null;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * The Better Auth session of the current server's client (cached in SecureStore by the Expo plugin, so a
 * signed-in person opens the app straight into it). When it ends, cached server data is dropped.
 */
export function SessionProvider({
  auth,
  server,
  children,
}: {
  auth: ReturnType<typeof authClient>;
  /**
   * The place `auth` signs in to (a server, or one of its accounts): on the list of those signed in to once a session
   * is there (ADR 0154, ADR 0183).
   */
  server: string;
  children: ReactNode;
}) {
  const session = auth.useSession();
  const queryClient = useQueryClient();
  const user = session.data?.user ?? null;
  const signedIn = Boolean(user);
  // Pending only until the first answer. Signed out, Better Auth marks every refetch pending again (its
  // `onRequest` sets `isPending: data === null`), and it refetches whenever the app comes back to the
  // foreground: the gate then read "still checking", opened `(app)` and remounted the sign-in screen, which lost
  // the e-mail, the step and what a password manager was about to fill in. Kept per client: another server's
  // session is read from the start. The client is a callable proxy: kept through an updater, or React would call
  // it as one.
  const [answeredBy, setAnsweredBy] = useState<typeof auth | null>(null);
  if (answeredBy !== auth && !session.isPending) setAnsweredBy(() => auth);
  const answered = answeredBy === auth;

  const userId = user?.id ?? null;
  const userName = user?.name ?? "";
  const userEmail = user?.email ?? "";
  useEffect(() => {
    if (!userId) return;
    // An account added on a server where this phone already has that person (ADR 0183): no second copy. This one's
    // session ends and the app goes to the place they were already in.
    const settle = () => {
      rememberAccount(server, { id: userId, name: userName, email: userEmail });
      markSignedIn(server);
    };
    const twin = accountTwin(server, userId);
    if (!twin) return settle();
    let gone = false;
    // Only while their sign-in there still answers; one that ended gives its place up to this one.
    void createApi(twin)
      .account.me()
      .then(
        (me) => me?.user.id === userId,
        () => true,
      )
      .then((alive) => {
        if (gone) return;
        if (!alive) {
          markSignedOut(twin);
          forgetAccount(twin);
          return settle();
        }
        return auth
          .signOut()
          .catch(() => {})
          .then(() => setServer(twin));
      });
    return () => {
      gone = true;
    };
  }, [auth, server, userId, userName, userEmail]);

  useEffect(() => {
    if (signedIn) {
      // Whatever was cached while signed out (e.g. `me` = null) is stale now.
      void readCookie(server).then(() => queryClient.invalidateQueries());
    } else queryClient.clear();
  }, [signedIn, queryClient, server]);

  const value = useMemo<SessionState>(
    () => ({
      signedIn,
      pending: !answered && !user,
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
      refresh: () => session.refetch(),
    }),
    [signedIn, answered, user, session.refetch],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The session gate's state (`app/_layout.tsx` sends signed-out people to `(auth)`). */
export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession must be used inside SessionProvider");
  return s;
}
