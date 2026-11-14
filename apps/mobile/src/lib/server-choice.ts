import { normalizeServer, originOf } from "@agenteschat/client/lib/server";

/**
 * A place is one account's sign-in on a server (ADR 0183): the server's address for the first account there, as
 * before a server kept several, and `address#id` for each other one. It names a session and what the phone keeps of
 * it; it is never an address to fetch (`serverOf` is).
 */
const PLACE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The server a place is on (pure). */
export const serverOf = (place: string): string => {
  const at = place.indexOf("#");
  return at < 0 ? place : place.slice(0, at);
};

/** Another account's place on `server` (pure). */
export const placeFor = (server: string, id: string) => `${server}#${id}`;

/** A saved place as the app takes it: its server normalized, its id kept when it is one; null for anything else. */
export function placeFrom(raw: string): string | null {
  const at = raw.indexOf("#");
  const server = normalizeServer(at < 0 ? raw : raw.slice(0, at), { allowHttp: true });
  if (!server) return null;
  if (at < 0) return server;
  const id = raw.slice(at + 1);
  return PLACE_ID.test(id) ? placeFor(server, id) : null;
}

/** The place the app is on: the one the person chose ("Seu servidor", or one of its accounts), else the build's. */
export const currentServer = (saved: string | null, build: string) => (saved ? placeFrom(saved) : null) ?? build;

/** What to remember: nothing for the build's own server, so a newer build's default applies. */
export const savedServer = (server: string, build: string) => (server === build ? null : server);

/**
 * FNV-1a of a server's address, in hex (pure). Only for the prefixes installs already use (`claimedPrefixes`): 32
 * bits are few enough that someone can make an address with another server's, so nothing new is named by it.
 */
export function serverSlug(server: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < server.length; i++) {
    hash ^= server.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The prefix each server's session is stored under (ADR 0154: one session per server), which is also the record of
 * whose it is: a prefix has one owner, so a second server saved with the same one is dropped and gets its own. Read
 * from storage, or on the first launch that keeps sessions per server, the server the app used until then keeps the
 * one prefix there was, so whoever was signed in stays signed in with nothing to move (pure).
 */
export function prefixesFrom(raw: string | null, current: string, base: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw ?? "null") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const owned = new Set<string>();
      const out: Record<string, string> = {};
      for (const [server, prefix] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof prefix !== "string" || !/^[A-Za-z0-9._-]+$/.test(prefix) || owned.has(prefix)) continue;
        owned.add(prefix);
        out[server] = prefix;
      }
      return out;
    }
  } catch {
    // Unreadable: as on the first launch.
  }
  return { [current]: base };
}

/**
 * Installs from before prefixes were saved for every server kept a later server's session under a prefix made from
 * its address. The servers signed in to keep theirs, saved as their own from now on, so nobody signs in again; where
 * two share one, the first signed in to keeps it. A server with no saved prefix after this gets a random one (pure).
 */
export function claimedPrefixes(
  prefixes: Readonly<Record<string, string>>,
  signedIn: readonly string[],
  base: string,
): Record<string, string> {
  const out = { ...prefixes };
  const owned = new Set(Object.values(out));
  for (const server of signedIn) {
    const prefix = `${base}_${serverSlug(server)}`;
    if (out[server] || owned.has(prefix)) continue;
    owned.add(prefix);
    out[server] = prefix;
  }
  return out;
}

/**
 * The prefixes with one for `target`: its own when it has one, else a new one from `randomId`, never one made from its
 * address, which another address could be made to match and so be sent this server's session (pure).
 */
export function withPrefix(
  prefixes: Readonly<Record<string, string>>,
  target: string,
  base: string,
  randomId: () => string,
): Record<string, string> {
  return prefixes[target] ? { ...prefixes } : { ...prefixes, [target]: `${base}_${randomId()}` };
}

/**
 * The name a per-server value or file is kept under, from the server's session prefix: the plain name for the server
 * the app used before sessions were kept per server, so what it remembered stays; its own for any other (pure).
 */
export const perServerName = (name: string, prefix: string, base: string) =>
  prefix === base ? name : `${name}.${prefix.slice(base.length + 1)}`;

/** A server's session cookie for a request to `url`: nothing when the address is on another origin (pure). */
export function cookieTo(url: string, server: string, cookie: string): string {
  const origin = originOf(url);
  return origin !== null && origin === originOf(server) ? cookie : "";
}

/**
 * The places this phone is signed in to (a server, or one of its accounts: ADR 0183), in the order they were added,
 * from storage (pure; anything else dropped).
 */
export function serverListFrom(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) {
      const server = typeof v === "string" ? placeFrom(v) : null;
      if (server && !out.includes(server)) out.push(server);
    }
    return out;
  } catch {
    return [];
  }
}

export const withServer = (list: readonly string[], server: string) =>
  list.includes(server) ? [...list] : [...list, server];

export const withoutServer = (list: readonly string[], server: string) => list.filter((s) => s !== server);

/**
 * Choosing a server or following a connect link (a QR code or `agenteschat://connect`): the app moves to it and every
 * other server stays signed in (ADR 0154). Only a one-time sign-in on a server someone is already signed in to signs
 * them out there first: one account per server.
 */
export function connectPlan(current: string, target: { server: string; token?: string }, signedInThere: boolean) {
  return {
    move: target.server !== current,
    signOut: signedInThere && Boolean(target.token),
    token: target.token ?? null,
  };
}

/** Who is signed in at a place, as the phone last saw them (ADR 0183). */
export interface PlaceAccount {
  id: string;
  name: string;
  email: string;
}

/** The accounts by place, from storage (pure; anything else dropped). */
export function accountsFrom(raw: string | null): Record<string, PlaceAccount> {
  const out: Record<string, PlaceAccount> = {};
  try {
    const parsed = JSON.parse(raw ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [saved, value] of Object.entries(parsed as Record<string, unknown>)) {
      const place = placeFrom(saved);
      const v = (value ?? {}) as Partial<PlaceAccount>;
      if (!place || typeof v.id !== "string" || !v.id || v.id.length > 200) continue;
      out[place] = {
        id: v.id,
        name: typeof v.name === "string" ? v.name.slice(0, 200) : "",
        email: typeof v.email === "string" ? v.email.slice(0, 320) : "",
      };
    }
  } catch {
    // Unreadable: nobody known yet.
  }
  return out;
}

/**
 * The place where `userId` is already signed in on the server of `place`, when it is another one (pure): signing in
 * to an added account as someone the phone already has there lands on theirs, not on a second copy.
 */
export function twinPlace(
  place: string,
  userId: string,
  signedIn: readonly string[],
  accounts: Readonly<Record<string, PlaceAccount>>,
): string | null {
  const server = serverOf(place);
  return signedIn.find((p) => p !== place && serverOf(p) === server && accounts[p]?.id === userId) ?? null;
}

/** The other accounts this phone is signed in to on the server of `place`, by id (pure): they share its push token. */
export function sharedAccounts(
  place: string,
  signedIn: readonly string[],
  accounts: Readonly<Record<string, PlaceAccount>>,
): string[] {
  const server = serverOf(place);
  const ids = signedIn.filter((p) => p !== place && serverOf(p) === server).map((p) => accounts[p]?.id);
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/**
 * Where a tapped push opens (pure): `here` on the place the app is on, `switch` to another place this phone is signed
 * in to, `gone` for one it no longer is. The push names its server (none, from an older server: the current one) and
 * whose it is (`who.user`, ADR 0183): among that server's accounts on this phone, theirs. A push that names nobody, or
 * a server whose accounts the phone hasn't all seen yet, opens as before accounts: on that server.
 */
export function pushPlace(
  pushServer: string | undefined,
  current: string,
  signedIn: readonly string[],
  who: { user?: string | undefined; accounts: Readonly<Record<string, PlaceAccount>> } = { accounts: {} },
): { kind: "here" } | { kind: "switch"; server: string } | { kind: "gone" } {
  const here = serverOf(current);
  const server = (pushServer ? normalizeServer(pushServer, { allowHttp: true }) : null) ?? here;
  const there = signedIn.filter((p) => serverOf(p) === server);
  const places = server === here && !there.includes(current) ? [current, ...there] : there;
  if (who.user && places.length > 0 && places.every((p) => who.accounts[p])) {
    const theirs = places.find((p) => who.accounts[p]?.id === who.user);
    if (!theirs) return { kind: "gone" };
    return theirs === current ? { kind: "here" } : { kind: "switch", server: theirs };
  }
  if (server === here) return { kind: "here" };
  const [first] = there;
  return first ? { kind: "switch", server: first } : { kind: "gone" };
}

/** The server to open after leaving one (pure): the next one still signed in, or none. */
export const serverAfter = (signedIn: readonly string[], leaving: string): string | null =>
  signedIn.find((s) => s !== leaving) ?? null;

/**
 * Where "back" goes from the sign-in of a server added while signed in elsewhere: the server the app came from, when
 * still signed in there, else any other signed in to; null when there's none (a first sign-in has nowhere to go back).
 */
export const serverToReturn = (signedIn: readonly string[], current: string, came: string | null): string | null =>
  came && came !== current && signedIn.includes(came) ? came : serverAfter(signedIn, current);
