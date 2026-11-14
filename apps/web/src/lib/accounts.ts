import type { ApiClient } from "@agenteschat/client";
import { STORAGE_KEYS, sessionStore, storage } from "./storage";

/**
 * Several accounts signed in on this browser (ADR 0183): moving the tab to another one. The app loads again as that
 * person, and nothing the account before saved for a quick start or left waiting to send comes along.
 */

/**
 * In an address, the account it is for: the desktop app's, for a workspace of another server (the page moves the
 * window to that account), and a clicked notification's new tab (the service worker moved the browser already). In a
 * browser the name alone moves nothing.
 */
export const AS_PARAM = "as";

/** Loads `to` again, as whoever the browser's session is now; the browser's other tabs follow. */
export function loadAs(to: string) {
  announceAccountChange();
  sessionStore.set(STORAGE_KEYS.accountMoved, "1");
  window.location.assign(to);
}

/**
 * Tells the browser's other tabs its session is another account's now (a switch, a sign-out that left one signed in,
 * an account added): the session cookie is the browser's, so a tab left as it was would ask as the wrong person.
 */
export function announceAccountChange() {
  storage.set(STORAGE_KEYS.accountChanged, String(Date.now()));
}

/**
 * A tab inside a workspace loads again from the start when another tab changed the browser's account. Pages outside
 * one (sign-in, an invitation, a consent) read who is signed in as they go.
 */
export function followAccountChanges() {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEYS.accountChanged || !event.newValue) return;
    if (!window.location.pathname.startsWith("/org/")) return;
    sessionStore.set(STORAGE_KEYS.accountMoved, "1");
    window.location.assign("/");
  });
}

/** Moves this browser to `userId`, signed in on it already, and opens `to` as them. */
export async function switchAccount(api: ApiClient, userId: string, to = "/") {
  await api.account.switchDeviceAccount(userId);
  loadAs(to);
}

/**
 * Where the tab goes when its account signed out and the browser moved to another one still signed in (pure): the
 * app's first page from inside a workspace; from a page that was waiting for a sign-in (an invitation, a consent, the
 * first run), the sign-in itself, coming back to that page, so the person picks who goes on.
 */
export function leaveFor(pathname: string, search: string): string {
  if (pathname === "/" || pathname.startsWith("/org/") || pathname.startsWith("/login")) return "/";
  return `/login?${new URLSearchParams({ redirect: `${pathname}${search}`, add: "1" })}`;
}

/**
 * The browser's session can become another account's without this tab being told (a provider's sign-in coming back
 * in another tab, a notification opened as another account): when the tab is looked at again inside a workspace, it
 * asks who is signed in, and loads again from the start when it isn't who it opened as. `known`: who this tab holds.
 */
export function watchAccount(api: ApiClient, known: () => string | null) {
  let asking = false;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || asking) return;
    if (!window.location.pathname.startsWith("/org/")) return;
    const mine = known();
    if (!mine) return;
    asking = true;
    void api.account
      .me()
      .then((me) => {
        if (!me || me.user.id === mine) return;
        sessionStore.set(STORAGE_KEYS.accountMoved, "1");
        window.location.assign("/");
      })
      .catch(() => {})
      .finally(() => {
        asking = false;
      });
  });
}

let cameByMove = false;

/** Whether this load follows `loadAs` (read once: the mark goes with it). */
export function takeAccountMove(): boolean {
  const moved = sessionStore.get(STORAGE_KEYS.accountMoved) === "1";
  if (moved) sessionStore.remove(STORAGE_KEYS.accountMoved);
  cameByMove = moved;
  return moved;
}

/**
 * The browser's own session ended (it expired, a new password, an administrator) while another of its accounts is
 * still signed in: the browser moves to that one and the app loads as them, instead of asking for a sign-in nobody
 * needs. True when it is on its way (the page loads again). Never on a load that already came from a move.
 */
export async function fallBackToAccount(api: ApiClient, to: string): Promise<boolean> {
  if (cameByMove) return false;
  const [other] = await api.account.deviceAccounts().catch(() => []);
  if (!other) return false;
  const moved = await api.account.switchDeviceAccount(other.user.id).then(
    () => true,
    () => false,
  );
  if (moved) loadAs(to);
  return moved;
}

/** The account an address asks for (`?as=`), or null. */
export function accountInLink(search: string): string | null {
  const id = new URLSearchParams(search).get(AS_PARAM)?.trim();
  return id && id.length <= 200 ? id : null;
}

/** `path?query#hash` without `?as=` (pure). */
export function withoutAccount(path: string, search: string, hash: string): string {
  const query = new URLSearchParams(search);
  query.delete(AS_PARAM);
  const rest = query.toString();
  return `${path}${rest ? `?${rest}` : ""}${hash}`;
}
