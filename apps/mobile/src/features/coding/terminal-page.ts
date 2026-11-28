import type { TerminalEnd } from "@agenteschat/client";
import { originOf } from "@agenteschat/client/lib/server";
import { sessionCookieScript } from "../computer/screen-page";

/*
 * A code session's terminal on the phone (ADR 0215): the app's side of the server's `/terminal.html`, in a WebView, as
 * the agent's screen is (`screen-page.ts`). The page holds the shell's socket and draws it with xterm, as the web's
 * terminal does; the app tells it when to open, its colors, and the keys a phone keyboard lacks. Pure, so it is
 * unit-tested.
 */

/** What the terminal shows: its shell opening or live, or why it closed (`dropped`: it was live, then its socket broke). */
export type TerminalState = "opening" | "live" | "dropped" | "moved" | TerminalEnd;

/** What the page says (`apps/web/src/terminal/session.ts`). */
export type TerminalEvent = { type: "ready" } | { type: "state"; state: TerminalState } | { type: "folder" };

const STATES: ReadonlySet<string> = new Set<TerminalState>([
  "opening",
  "live",
  "dropped",
  "moved",
  "ended",
  "screening",
  "forbidden",
  "offline",
  "outdated",
  "unavailable",
  "busy",
  "paused",
  "failed",
]);

/** Each closed state's line (`codeTerminal.*`, the web's). */
export const TERMINAL_END_WORDS = {
  ended: "codeTerminal.ended",
  dropped: "codeTerminal.dropped",
  moved: "codeTerminal.moved",
  screening: "codeTerminal.screening",
  forbidden: "codeTerminal.forbidden",
  offline: "codeTerminal.offline",
  outdated: "codeTerminal.outdated",
  unavailable: "codeTerminal.unavailable",
  busy: "codeTerminal.busy",
  paused: "codeTerminal.paused",
  failed: "codeTerminal.failed",
} as const satisfies Record<Exclude<TerminalState, "opening" | "live">, string>;

/** Where opening again changes nothing by itself: the server's rule, the person's rights, the computer's app. */
export const terminalOpensAgain = (state: TerminalState) =>
  state !== "screening" && state !== "forbidden" && state !== "outdated";

/**
 * The terminal's name on this phone: its shell stays on the computer while the app is away, and the same session's
 * terminal comes back to it (the server puts the person's id in front). Another than the web's, so neither takes the
 * other's.
 */
export const phoneTerminalKeep = (sessionId: string) => `phone-${sessionId}`;

/** The page's address for one session's terminal. */
export const terminalPageUrl = (server: string, v: { orgId: string; agentId: string; sessionId: string }) => {
  const query = new URLSearchParams({ o: v.orgId, a: v.agentId, s: v.sessionId, k: phoneTerminalKeep(v.sessionId) });
  return `${server}/terminal.html?${query.toString()}`;
};

/** This WebView holds a session, so only the server's own page ever loads in it: never a link, a redirect or a frame. */
export function terminalPageStays(server: string, url: string): boolean {
  const page = new URL(`${server}/terminal.html`);
  try {
    const to = new URL(url);
    return to.origin === page.origin && to.pathname === page.pathname;
  } catch {
    return false;
  }
}

/** One message from the server's page, or null for anything else. */
export function terminalEvent(server: string, from: { url: string; data: string }): TerminalEvent | null {
  if (originOf(from.url) !== new URL(server).origin) return null;
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(from.data);
    if (typeof parsed !== "object" || parsed === null) return null;
    m = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (m.type === "ready" || m.type === "folder") return { type: m.type };
  if (m.type === "state" && typeof m.state === "string" && STATES.has(m.state)) {
    return { type: "state", state: m.state as TerminalState };
  }
  return null;
}

/** The keys a phone keyboard lacks, on the row over it (`TERMINAL_KEYS` on the page). */
export const TERMINAL_ROW_KEYS = [
  "Escape",
  "Tab",
  "CtrlC",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "CtrlD",
] as const;
export type TerminalKey = (typeof TERMINAL_ROW_KEYS)[number];

/** Each key's cap on the row. */
export const TERMINAL_CAP: Record<TerminalKey, string> = {
  Escape: "esc",
  Tab: "tab",
  CtrlC: "^C",
  CtrlD: "^D",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

export type TerminalCalls = {
  open: [];
  key: [name: TerminalKey];
  type: [text: string];
  look: [{ dark: boolean; background: string; foreground: string }];
  focus: [];
  blur: [];
};

/**
 * A call on the page, for `injectJavaScript`. JSON keeps whatever a person pasted a value, never code. `open` has the
 * session's cookie set just before it, since another WebView mounting meanwhile may have cleared it (as the agent's
 * screen's `pageCall`).
 */
export const terminalCall = <K extends keyof TerminalCalls>(
  session: { cookie: string; server: string },
  method: K,
  ...args: TerminalCalls[K]
) =>
  (method === "open" ? sessionCookieScript(session.cookie, session.server) : "") +
  `window.agentTerminal?.${method}(${args.map((a) => JSON.stringify(a)).join(",")});true;`;
