import { randomUUID } from "expo-crypto";
import { useSyncExternalStore } from "react";
import { API_URL, APP_VARIANT, STORAGE_PREFIX } from "@/config";
import {
  accountsFrom,
  claimedPrefixes,
  currentServer,
  type PlaceAccount,
  perServerName,
  placeFor,
  prefixesFrom,
  savedServer,
  serverListFrom,
  serverOf,
  serverToReturn,
  sharedAccounts,
  twinPlace,
  withoutServer,
  withPrefix,
  withServer,
} from "./server-choice";
import { readValueSync, STORED, writeValue, writeValueSync } from "./storage";

/** Not in `STORED`: signing out of a server doesn't leave it. */
const SERVER = "server";
/** The servers this phone is signed in to (JSON list, ADR 0154). */
const SIGNED_IN = "servers";
/** Each server's session prefix (JSON by server, ADR 0154). */
const PREFIXES = "session-prefixes";

/** Development builds may use http, on localhost or the local network only. */
export const ALLOW_HTTP = APP_VARIANT === "development";

/**
 * The place the app is on: a server, or one of its accounts (`server-choice.ts`, ADR 0183). The session, the cache
 * and what the phone keeps are a place's; the address to talk to is its server's.
 */
let place = currentServer(readValueSync(SERVER), API_URL);
const listeners = new Set<() => void>();

/** The server the app talks to, read at call time: it changes while the app runs. */
export const serverUrl = () => serverOf(place);

/** The place the app is on, read at call time: whose session and saved values are in use. */
export const placeKey = () => place;

/** The server's address, for screens that show or fetch from it. */
export function useServer() {
  return useSyncExternalStore(subscribe, serverUrl);
}

/** The place, for what must follow a change of server or of account (the providers). */
export function usePlace() {
  return useSyncExternalStore(subscribe, placeKey);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The server the app was on before the last change: where the sign-in of a newly added one goes back to. */
let came: string | null = null;

/**
 * Points the app at `next`, a server or one of its accounts' places. Every one stays signed in (ADR 0154, ADR 0183):
 * its session waits under its own prefix.
 */
export async function setServer(next: string) {
  if (next !== place) came = place;
  place = next;
  await writeValue(SERVER, savedServer(next, API_URL));
  for (const listener of listeners) listener();
}

// ── Sessions per server (ADR 0154) ──────────────────────────────────────────────

let signedIn = serverListFrom(readValueSync(SIGNED_IN));

const rawPrefixes = readValueSync(PREFIXES);
let prefixes = claimedPrefixes(prefixesFrom(rawPrefixes, place, STORAGE_PREFIX), signedIn, STORAGE_PREFIX);
if (JSON.stringify(prefixes) !== rawPrefixes) writeValueSync(PREFIXES, JSON.stringify(prefixes));

/**
 * Where a server's session (cookie and cached session) is stored. A server met for the first time gets a random
 * prefix (`withPrefix`), saved as its own before anything is stored under it.
 */
export function prefixOf(target: string): string {
  const saved = prefixes[target];
  if (saved) return saved;
  prefixes = withPrefix(prefixes, target, STORAGE_PREFIX, randomUUID);
  writeValueSync(PREFIXES, JSON.stringify(prefixes));
  return prefixes[target] ?? "";
}

/** The name a per-server value is remembered under (`perServerName`). */
export const perServer = (name: string, target: string) => perServerName(name, prefixOf(target), STORAGE_PREFIX);

/** The remembered workspace on a server. */
export const orgValueName = (target: string) => perServer(STORED.org, target);

const signedInListeners = new Set<() => void>();

/** The servers this phone is signed in to, in the order they were added. */
export const signedInServers = () => signedIn;

/** The servers signed in to, for screens that list them (Workspaces). */
export function useSignedInServers() {
  return useSyncExternalStore((listener) => {
    signedInListeners.add(listener);
    return () => {
      signedInListeners.delete(listener);
    };
  }, signedInServers);
}

function saveSignedIn(next: string[]) {
  if (next.length === signedIn.length && next.every((s, i) => s === signedIn[i])) return;
  signedIn = next;
  writeValueSync(SIGNED_IN, JSON.stringify(next));
  for (const listener of signedInListeners) listener();
}

/** A session arrived on `target` (signing in, or an older install's saved one read at launch). */
export const markSignedIn = (target: string) => saveSignedIn(withServer(signedIn, target));

/** Signed out of `target`: off the list. */
export const markSignedOut = (target: string) => saveSignedIn(withoutServer(signedIn, target));

// ── Accounts on one server (ADR 0183) ───────────────────────────────────────────

/** Who is signed in at each place, as last seen (JSON by place): tells accounts apart with no network. */
const ACCOUNTS = "place-accounts";

let accounts = accountsFrom(readValueSync(ACCOUNTS));

/** Who is signed in at each place this phone knows. */
export const placeAccounts = () => accounts;

const accountListeners = new Set<() => void>();

/** Who is signed in at each place, for screens that name the accounts (Workspaces). */
export function usePlaceAccounts() {
  return useSyncExternalStore((listener) => {
    accountListeners.add(listener);
    return () => {
      accountListeners.delete(listener);
    };
  }, placeAccounts);
}

function saveAccounts(next: Record<string, PlaceAccount>) {
  accounts = next;
  writeValueSync(ACCOUNTS, JSON.stringify(next));
  for (const listener of accountListeners) listener();
}

/** A session at `target` is `user`'s (read whenever its session is). */
export function rememberAccount(target: string, user: PlaceAccount) {
  const known = accounts[target];
  if (known && known.id === user.id && known.name === user.name && known.email === user.email) return;
  saveAccounts({ ...accounts, [target]: { id: user.id, name: user.name, email: user.email } });
}

/** Signed out of `target`: nobody is known there. */
export function forgetAccount(target: string) {
  if (!accounts[target]) return;
  const { [target]: _gone, ...rest } = accounts;
  saveAccounts(rest);
}

/**
 * Who a place is to the person, in "Voltar para …": the account's address when it is on the server the app is on (the
 * host would say nothing), null otherwise (the caller names the server).
 */
export const accountLabel = (target: string): string | null =>
  serverOf(target) === serverOf(place) ? (accounts[target]?.email ?? null) : null;

/**
 * A place for one more account on `server`, with nobody signed in yet: the one an earlier "add account" there left
 * empty, when there is one, so backing out of the sign-in leaves nothing behind twice.
 */
export const newAccountPlace = (server: string) =>
  Object.keys(prefixes).find((p) => p !== server && serverOf(p) === server && !signedIn.includes(p)) ??
  placeFor(server, randomUUID());

/** Where `userId` is already signed in on the server of `target`, when that is another place (`twinPlace`). */
export const accountTwin = (target: string, userId: string) => twinPlace(target, userId, signedIn, accounts);

/** The other accounts signed in on the server of `target`, by id: they share this phone's push token there. */
export const accountsSharing = (target: string) => sharedAccounts(target, signedIn, accounts);

/**
 * Where the sign-in screen's back and "Voltar para …" go: the server the app came from while still signed in there,
 * else another one signed in to; null on a first sign-in.
 */
export function useServerToReturn() {
  return serverToReturn(useSignedInServers(), usePlace(), came);
}
