import type { TFunction } from "i18next";
import type { ScreenKind } from "../api/types";
import type { agentGrammar } from "./grammar";

/**
 * The agent's browser card in the conversation, what the web and the phone draw alike (ADR 0040 §6–7): its title,
 * the line that says what it does now, and the words of each screen. Platform-neutral: the apps draw it.
 */

/** "https://painel.acme.example/login?x=1" → ["painel.acme.example", "/login"]. */
export function hostAndPath(url: string | null | undefined): [string, string] {
  if (!url) return ["", ""];
  const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  return m ? [m[1] ?? "", (m[2] ?? "").replace(/\/$/, "")] : [url, ""];
}

/**
 * What the card's title shows: the request while the person is in control of it, else the
 * site, "opening" only until the first frame, and the agent's browser when no site is known.
 */
export function titleKind(v: {
  inControl: boolean;
  ask: string | null;
  host: string;
  opening: boolean;
}): "ask" | "host" | "opening" | "agent" {
  if (v.inControl && v.ask) return "ask";
  if (v.host) return "host";
  return v.opening ? "opening" : "agent";
}

/** Where the card stands, for the line that says what the agent does now (or who holds its browser). */
export interface BrowserCardLine {
  /** The agent's grammar (`agentGrammar`): its name and the gender its sentences agree with. */
  grammar: ReturnType<typeof agentGrammar>;
  inControl: boolean;
  otherInControl: boolean;
  /** Who else is in control (their name). */
  controllerName: string;
  /** Someone else is in control and the page is theirs alone. */
  hidden: boolean;
  closed: boolean;
  /** It waited too long for a page (`useBrowserStuck`). */
  stuck: boolean;
  reconnecting: boolean;
  /** No page and no step yet: the browser is on its way. */
  starting: boolean;
  /** The request the agent made, while it is the one in control. */
  ask: string | null;
  host: string;
  /** A shared profile in the person's control (ADR 0110), with the computer it runs on when known. */
  profile: { machineName: string | null } | null;
  /** The agent's latest step in the person's words ("Clicked"), lowered into the line; none yet. */
  now: string | null;
}

/** The line under (or beside) the card's title: what the agent does now, or who is in control and why it waits. */
export function browserCardLine(t: TFunction, v: BrowserCardLine): string {
  const g = v.grammar;
  if (v.inControl) {
    if (v.profile)
      return v.profile.machineName
        ? t("browser.profiles.controlSubOn", { machine: v.profile.machineName })
        : t("browser.profiles.controlSub");
    if (v.ask)
      return v.host ? t("browser.inCard.subControl", { site: v.host, ...g }) : t("browser.inCard.subControlAsked", g);
    return t("browser.inCard.subTakeover", g);
  }
  if (v.otherInControl)
    return v.hidden
      ? t("browser.inCard.subHidden", { person: v.controllerName })
      : t("browser.inCard.subOther", { person: v.controllerName });
  if (v.closed) return t("browser.inCard.subClosed");
  if (v.stuck) return t("browser.inCard.subStuck");
  if (v.reconnecting) return t("browser.inCard.subReconnect", g);
  if (v.starting) return t("browser.inCard.subStarting", g);
  if (v.now) return t("browser.inCard.subWorking", { name: g.name, now: v.now });
  return t("browser.live.watchOnly");
}

/**
 * The cards' words by screen: the desktop's own wording where it has one (`desktop.*`), else the
 * browser's (`browser.*`), so the desktop's namespace holds only what differs.
 */
export function screenT(t: TFunction, screen: ScreenKind) {
  const loose = t as unknown as (keys: string[], options?: Record<string, unknown>) => string;
  return (key: string, options?: Record<string, unknown>) =>
    screen === "browser" ? loose([`browser.${key}`], options) : loose([`${screen}.${key}`, `browser.${key}`], options);
}
