import type { ControlAppUse, ControlBrowser, ControlStatus } from "@agenteschat/adapters/runner-control";

/** Preference: a macOS notification when an agent asks for help in its browser (off by default). */
export const BROWSER_NOTIFY_PREF = "notifyBrowser";

/** How an agent's browser shows in the tray's "Agora". */
export type BrowserRowState =
  /** The agent asked a person for help (sign in, a code…): Abrir. */
  | { kind: "needs"; request?: string; link?: string }
  /** A person is driving it. */
  | { kind: "control"; controller?: string; link?: string }
  /** The agent is using it. */
  | { kind: "using"; link?: string };

export function browserRowState(b: ControlBrowser): BrowserRowState {
  const h = b.handoff;
  if (h?.status === "pending") return { kind: "needs", ...pick(h.request, h.link ?? b.link) };
  if (h?.status === "active") {
    return {
      kind: "control",
      ...(h.controller ? { controller: h.controller } : {}),
      ...((h.link ?? b.link) ? { link: h.link ?? b.link } : {}),
    };
  }
  return { kind: "using", ...(b.link ? { link: b.link } : {}) };
}

const pick = (request?: string, link?: string) => ({
  ...(request ? { request } : {}),
  ...(link ? { link } : {}),
});

/** The browsers worth a row: open ones and any with a person's turn. */
export function browsersOf(status: ControlStatus | null | undefined): ControlBrowser[] {
  return (status?.browsers ?? []).filter((b) => b.open || b.handoff);
}

/** An app counts as in use this long after the agent's last command in it (it thinks between steps). */
export const APP_BUSY_MS = 90_000;

/** The agents using the person's apps now (ADR 0258): "<Agent> is using <App>" with Stop. */
export function appUsesOf(status: ControlStatus | null | undefined, now = Date.now()): ControlAppUse[] {
  return (status?.apps ?? []).filter((u) => now - Date.parse(u.actedAt) < APP_BUSY_MS);
}

/** The tray's badge: a dot when an agent needs a person, a ring while one is in its browser or the person's apps. */
export function browserBadgeOf(
  statuses: readonly (ControlStatus | null | undefined)[],
  now = Date.now(),
): "needs" | "browsing" | null {
  const all = statuses.flatMap(browsersOf);
  if (all.some((b) => b.handoff?.status === "pending")) return "needs";
  return all.length > 0 || statuses.some((s) => appUsesOf(s, now).length > 0) ? "browsing" : null;
}

/**
 * The site's address for a conversation path the runner passed on (`/org/…`);
 * anything else (or none) opens the site's home.
 */
export function siteLink(server: string | undefined, path: string | undefined, fallback: string): string {
  if (!server || !path || !/^\/org\/[\w-]+\//.test(path) || path.includes("//")) return fallback;
  try {
    const base = new URL(server);
    if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") return fallback;
    return new URL(path, base).toString();
  } catch {
    return fallback;
  }
}

/** Requests for help that weren't there before (each one notifies once). */
export function newHelpRequests(
  before: ReadonlySet<string>,
  statuses: readonly (ControlStatus | null | undefined)[],
): { key: string; agentId: string; request?: string; status: ControlStatus }[] {
  const out: { key: string; agentId: string; request?: string; status: ControlStatus }[] = [];
  for (const s of statuses) {
    if (!s) continue;
    for (const b of browsersOf(s)) {
      if (b.handoff?.status !== "pending") continue;
      const key = `${s.org?.id ?? ""}:${b.agentId}:${b.handoff.request ?? ""}`;
      if (!before.has(key))
        out.push({ key, agentId: b.agentId, ...(b.handoff.request ? { request: b.handoff.request } : {}), status: s });
    }
  }
  return out;
}

/** Every pending request's key now (the next `newHelpRequests` compares with it). */
export function helpRequestKeys(statuses: readonly (ControlStatus | null | undefined)[]): Set<string> {
  const keys = new Set<string>();
  for (const s of statuses) {
    if (!s) continue;
    for (const b of browsersOf(s)) {
      if (b.handoff?.status === "pending") keys.add(`${s.org?.id ?? ""}:${b.agentId}:${b.handoff.request ?? ""}`);
    }
  }
  return keys;
}
