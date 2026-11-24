import type { OrgSummary } from "@agenteschat/client";
import { settingsSectionNameKey } from "@agenteschat/client/lib/personal-view";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import type { IconName } from "@/ui";
import { fold } from "../search/logic";
import {
  GROUP_LABEL,
  PERSONAL_ICON,
  personalSections,
  SECTION_SHORT,
  type SettingsEntry,
  visibleSections,
} from "./logic";

/*
 * Every setting the phone has, found by its name (Você's search and the Buscar tab's Configurações group): the
 * person's own, as Você lists them, and the workspace's, as its settings list them for this person (ADR 0085: what the
 * person may open, nothing more). Each with where it lives ("Você › Preferências"), the words it also answers to, and
 * where a tap goes: its screen, or the menu it changes in (Sons, Aparência, which have no screen). Pure, so the tests
 * run it; the screens hand it the workspace and what this phone offers.
 */

/** Whose setting: the person's own (Você) or the workspace's (its settings). */
export type SettingScope = "me" | "workspace";

/** A setting that changes in a menu, with no screen of its own. */
export type SettingPick = "sounds" | "appearance";

export interface SettingEntry {
  id: string;
  scope: SettingScope;
  icon: IconName;
  /** The i18n key of its name. */
  label: string;
  /** The i18n keys of where it lives, from the top. */
  path: readonly string[];
  /** Its screen. */
  href?: string;
  /** Or the menu it changes in. */
  pick?: SettingPick;
  /** The i18n key of the other words it answers to, comma-separated ("senha, foto"). */
  words?: string;
}

/** What decides which settings this person has here. */
export interface SettingsReach {
  org: OrgSummary | null | undefined;
  /** People other than me in a personal workspace (its People row), unknown while loading. */
  others?: number | undefined;
  /** This build carries other app icons (ADR 0179). */
  appIcon?: boolean;
  /** The server has an About page. */
  about?: boolean;
}

const ME = "mobile.me.title";
const PREFERENCES = "mobile.me.preferences";
const ACCOUNT = "mobile.me.account.title";
const SETTINGS = "settings.title";
const ADVANCED = "settings.advanced";
const WORDS = "mobile.settingsSearch.words";

/** The person's own settings, in Você's order, with the rows Você shows only here and now. */
function mine(reach: SettingsReach): SettingEntry[] {
  const org = reach.org;
  const personal = isPersonal(org);
  const pref = [ME, PREFERENCES];
  const rows: (SettingEntry | false)[] = [
    {
      id: "status",
      scope: "me",
      icon: "smile",
      label: "presence.setStatus",
      path: [ME],
      href: "/me/status",
      words: `${WORDS}.status`,
    },
    {
      id: "account",
      scope: "me",
      icon: "person",
      label: ACCOUNT,
      path: [ME],
      href: "/me/account",
      words: `${WORDS}.account`,
    },
    {
      id: "deleteAccount",
      scope: "me",
      icon: "trash",
      label: "mobile.me.deleteAccount",
      path: [ME, ACCOUNT],
      href: "/account-delete",
      words: `${WORDS}.deleteAccount`,
    },
    {
      id: "workspaces",
      scope: "me",
      icon: "home",
      label: "mobile.me.workspaces",
      path: [ME],
      href: "/me/workspaces",
      words: `${WORDS}.workspaces`,
    },
    {
      id: "notifications",
      scope: "me",
      icon: "bell",
      label: "mobile.me.notifications",
      path: pref,
      href: "/me/notifications",
      words: `${WORDS}.notifications`,
    },
    // A personal workspace lists its approvals under Settings › Advanced (ADR 0159 §3).
    {
      id: "approvals",
      scope: "me",
      icon: "shield",
      label: "settings.section.approvals",
      path: personal ? [SETTINGS, ADVANCED] : pref,
      href: "/me/approvals",
      words: `${WORDS}.approvals`,
    },
    // A server from before each choice sends none of it, and Você leaves its row out then.
    org?.start !== undefined && {
      id: "start",
      scope: "me",
      icon: "home",
      label: "mobile.me.start",
      path: pref,
      href: "/me/start",
      words: `${WORDS}.start`,
    },
    org?.showActivity !== undefined && {
      id: "activity",
      scope: "me",
      icon: "eye",
      label: "mobile.me.activity",
      path: pref,
      href: "/me/activity",
      words: `${WORDS}.activity`,
    },
    org?.chatPrefs !== undefined && {
      id: "chatLook",
      scope: "me",
      icon: "text",
      label: "settings.account.chat.title",
      path: pref,
      href: "/me/chat-look",
      words: `${WORDS}.chatLook`,
    },
    org?.chatPrefs !== undefined && {
      id: "wallpaper",
      scope: "me",
      icon: "image",
      label: "settings.account.chat.wallpaper.title",
      path: [ME, PREFERENCES, "settings.account.chat.title"],
      href: "/me/chat-wallpaper",
      words: `${WORDS}.wallpaper`,
    },
    org?.agentStyle !== undefined && {
      id: "agentStyle",
      scope: "me",
      icon: "agent",
      label: "mobile.me.agentStyle",
      path: pref,
      href: "/me/agent-style",
      words: `${WORDS}.agentStyle`,
    },
    {
      id: "sounds",
      scope: "me",
      icon: "sound",
      label: "mobile.me.sounds",
      path: pref,
      pick: "sounds",
      words: `${WORDS}.sounds`,
    },
    {
      id: "appearance",
      scope: "me",
      icon: "sun",
      label: "mobile.me.appearance",
      path: pref,
      pick: "appearance",
      words: `${WORDS}.appearance`,
    },
    reach.appIcon === true && {
      id: "appIcon",
      scope: "me",
      icon: "image",
      label: "appIcon.title",
      path: pref,
      href: "/me/app-icon",
      words: `${WORDS}.appIcon`,
    },
    {
      id: "language",
      scope: "me",
      icon: "globe",
      label: "mobile.me.language",
      path: pref,
      href: "/me/language",
      words: `${WORDS}.language`,
    },
    reach.about === true && {
      id: "about",
      scope: "me",
      icon: "info",
      label: "settings.section.about",
      path: pref,
      href: "/me/about",
      words: `${WORDS}.about`,
    },
  ];
  return rows.filter((r): r is SettingEntry => r !== false);
}

/**
 * The workspace's settings this person opens, named as its settings list them: a team's by group ("Configurações ›
 * Pessoas"), a personal workspace's short list straight under Configurações and the rest under Avançado (ADR 0159 §3);
 * and the AI accounts under IA e uso.
 */
function workspace(reach: SettingsReach): SettingEntry[] {
  const org = reach.org;
  const personal = isPersonal(org);
  const entry = (s: SettingsEntry, path: readonly string[]): SettingEntry => ({
    id: s.id,
    scope: "workspace",
    icon: (personal ? PERSONAL_ICON[s.id] : undefined) ?? s.icon,
    label: (personal ? undefined : SECTION_SHORT[s.id]) ?? settingsSectionNameKey(org, s.id),
    path,
    href: s.href,
    words: `${WORDS}.${s.id}`,
  });
  const sections = personal
    ? (() => {
        const { main, advanced } = personalSections(org, reach.others);
        return [...main.map((s) => entry(s, [SETTINGS])), ...advanced.map((s) => entry(s, [SETTINGS, ADVANCED]))];
      })()
    : visibleSections(org).map((s) => entry(s, [SETTINGS, GROUP_LABEL[s.group]]));
  const usage = sections.find((s) => s.id === "usage");
  // Under IA e uso, which a team's group already names ("Configurações › IA e uso", not twice).
  const underUsage = usage && (usage.path.at(-1) === usage.label ? usage.path : [...usage.path, usage.label]);
  const accounts: SettingEntry | null = underUsage
    ? {
        id: "aiAccounts",
        scope: "workspace",
        icon: "brain",
        label: personal ? "settings.section.keysPersonal" : "mobile.ai.row",
        path: underUsage,
        href: "/ai-accounts",
        words: `${WORDS}.aiAccounts`,
      }
    : null;
  return accounts ? [...sections, accounts] : sections;
}

/** Every setting this person has here: their own first, then the workspace's. */
export const settingsIndex = (reach: SettingsReach): SettingEntry[] => [...mine(reach), ...workspace(reach)];

/** A setting found: its entry, its name and where it lives in the person's language. */
export interface FoundSetting {
  entry: SettingEntry;
  name: string;
  where: string[];
}

/** How well a setting answers: its name first (from its start, a word's start, inside), then its words, then where. */
function rank(term: string, name: string, words: string, where: string): number | null {
  if (name.startsWith(term)) return 0;
  if (name.split(/[\s/-]+/).some((w) => w.startsWith(term))) return 1;
  if (name.includes(term)) return 2;
  if (words.includes(term)) return 3;
  if (where.includes(term)) return 4;
  return null;
}

/**
 * The settings `q` finds, best first (each of its words must be in the name, the other words or the path, accents and
 * case aside), in the index's order within the same rank. `t` gives each key's words in the person's language.
 */
export function findSettings(q: string, entries: readonly SettingEntry[], t: (key: string) => string): FoundSetting[] {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const found: { at: number; score: number; hit: FoundSetting }[] = [];
  entries.forEach((entry, at) => {
    const name = t(entry.label);
    const where = entry.path.map((key) => t(key));
    const folded = { name: fold(name), words: entry.words ? fold(t(entry.words)) : "", where: fold(where.join(" ")) };
    let score = 0;
    for (const term of terms) {
      const r = rank(term, folded.name, folded.words, folded.where);
      if (r === null) return;
      score = Math.max(score, r);
    }
    found.push({ at, score, hit: { entry, name, where } });
  });
  return found.sort((a, b) => a.score - b.score || a.at - b.at).map((f) => f.hit);
}
