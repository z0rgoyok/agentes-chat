import type { i18n as I18n, TFunction } from "i18next";
import { useEffect } from "react";

/**
 * Apps whose name may start a tool's (`github_…`, `GOOGLEDRIVE_…`, `mcp__higgsfield__…`), by that name with no spaces
 * or marks, and how each writes its own name. A word that is also a noun (drive, docs, teams) stays out: it starts
 * real tool names (`teams_list`).
 */
const APPS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  gitserver: "Git",
  linear: "Linear",
  jira: "Jira",
  confluence: "Confluence",
  atlassian: "Atlassian",
  slack: "Slack",
  notion: "Notion",
  googledrive: "Google Drive",
  gdrive: "Google Drive",
  googledocs: "Google Docs",
  googlesheets: "Google Sheets",
  googlecalendar: "Google Calendar",
  gcal: "Google Calendar",
  gmail: "Gmail",
  figma: "Figma",
  canva: "Canva",
  vercel: "Vercel",
  sentry: "Sentry",
  stripe: "Stripe",
  higgsfield: "Higgsfield",
  asana: "Asana",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  intercom: "Intercom",
  zendesk: "Zendesk",
  square: "Square",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  microsoftteams: "Microsoft Teams",
  supabase: "Supabase",
  neon: "Neon",
  composio: "Composio",
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  pinterest: "Pinterest",
  reddit: "Reddit",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  x: "X",
  tiktok: "TikTok",
  metaads: "Meta Ads",
};

/** Not an app, only where a tool came from: `mcp__server__tool`, `mcp.server.ai`. */
const SKIPPED = new Set(["mcp", "ai", "com", "io", "app", "dev"]);
const ARTICLES = new Set(["a", "an", "the"]);

/** A name's words: `mergePullRequest`, `merge-pull-request`, `github.merge_pull_request`, `SLACK_SEND_MESSAGE`. */
const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * A tool's own name as the catalog keys it, and the app its name starts with (null: none known), however it is
 * written: `github.merge_pull_request`, `GITHUB_CREATE_AN_ISSUE` (`create_issue`), `mcp__higgsfield__generate_image`,
 * `ONE_DRIVE_ONEDRIVE_LIST_ITEMS` (`list_items`).
 */
export function toolKey(name: string): { app: string | null; key: string } {
  let words = wordsOf(name);
  let app: string | null = null;
  for (let moved = true; moved && words.length > 1; ) {
    moved = false;
    // A later account's tools carry its number after the app's name (`stripe_2_list_customers`).
    if (SKIPPED.has(words[0] ?? "") || (app && /^\d+$/.test(words[0] ?? ""))) {
      words = words.slice(1);
      moved = true;
      continue;
    }
    for (const n of [3, 2, 1]) {
      const brand = words.length > n ? APPS[words.slice(0, n).join("")] : undefined;
      if (!brand) continue;
      app ??= brand;
      words = words.slice(n);
      moved = true;
      break;
    }
  }
  return { app, key: words.filter((w) => !ARTICLES.has(w)).join("_") };
}

/**
 * Whether a tool's label only says its name again (the server starts a custom tool's label as `Generate image` for
 * `generate_image`): nobody named it, so the catalog words it. A name someone typed (`Gerar capa`) is theirs to keep.
 */
export const labelIsName = (label: string, name: string) => !label.trim() || toolKey(label).key === toolKey(name).key;

/**
 * How an app writes its own name, by the word a tool's name starts with (`github` → GitHub); null: not one we know.
 * Own keys only: a word from an address (`?connector=constructor`) names no property of Object's.
 */
export const appNameOf = (word: string): string | null => {
  const key = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  return Object.hasOwn(APPS, key) ? (APPS[key] ?? null) : null;
};

/**
 * The words for a tool agents use often, in the language `t` speaks, so no card, list or line shows a name like
 * `merge_pull_request`: the strings' `toolNames.label`, by the tool's own name (`toolKey`). Null: no words for it,
 * and its name is built from its verb and nouns (`toolName` in `tool-review.ts`).
 */
export function catalogLabel(t: TFunction, name: string): string | null {
  const key = `toolNames.label.${toolKey(name).key}`;
  const label = (t as unknown as (key: string) => unknown)(key);
  // i18next answers a key it lacks with the key itself, and a name that is also a property of every object
  // (`constructor`) with that property.
  return typeof label === "string" && label !== key ? label : null;
}

/**
 * Where a connector tool's words come from when the catalog has none (`connectorToolWords`): the workspace's own,
 * written once per language by its cheap model (`POST …/tool-labels`), added to the catalog of the language shown.
 * Each name is asked for once a session; English needs none (its words are the name's).
 */
export interface LabelSource {
  i18n: I18n;
  ask(locale: string, keys: string[]): Promise<Record<string, string>>;
}

let source: LabelSource | null = null;
const asked = new Set<string>();
const queued = new Map<string, string[]>();
let flushing = false;

/** Mirrors the server's `TOOL_LABEL_KEY` and `TOOL_LABELS_MAX` (engine `tool-label-words.ts`). */
const LABEL_KEY = /^[a-z0-9]+(?:_[a-z0-9]+){0,11}$/;
const LABELS_PER_ASK = 30;

function flush() {
  flushing = false;
  const s = source;
  for (const [locale, keys] of queued) {
    queued.delete(locale);
    for (let i = 0; s && i < keys.length; i += LABELS_PER_ASK)
      s.ask(locale, keys.slice(i, i + LABELS_PER_ASK)).then(
        (labels) => {
          // Only into a language already loaded: a bundle begun here would read as that language's whole one.
          if (Object.keys(labels).length === 0 || !s.i18n.hasResourceBundle(locale, "translation")) return;
          s.i18n.addResources(
            locale,
            "translation",
            Object.fromEntries(Object.entries(labels).map(([k, v]) => [`toolNames.label.${k}`, v])),
          );
        },
        () => {},
      );
  }
}

function want(key: string) {
  const s = source;
  const locale = s?.i18n.language;
  if (!s || !locale || locale.startsWith("en") || key.length > 100 || !LABEL_KEY.test(key)) return;
  if (asked.has(`${locale}:${key}`)) return;
  asked.add(`${locale}:${key}`);
  queued.set(locale, [...(queued.get(locale) ?? []), key]);
  // One ask for all the names a screen draws at once.
  if (flushing) return;
  flushing = true;
  setTimeout(flush, 50);
}

/**
 * A connector tool's name in a work line ("list available accounts"): the catalog's words, else the words written
 * for this workspace once they come (asked for here, the first time), else its own.
 */
export function connectorToolWords(t: TFunction, name: string): string {
  const label = catalogLabel(t, name);
  if (label) return label;
  want(toolKey(name).key);
  return name;
}

/**
 * Lets work lines ask for the words of tools the catalog lacks, in `orgId`, while mounted. The i18n instance must
 * redraw on added strings (`react.bindI18nStore: "added"`) for the words to show once they come.
 */
export function useToolLabelSource(
  i18n: I18n,
  orgId: string | null | undefined,
  ask: ((orgId: string, locale: string, keys: string[]) => Promise<Record<string, string>>) | undefined,
) {
  useEffect(() => {
    if (!orgId || !ask) return;
    return setToolLabelSource({ i18n, ask: (locale, keys) => ask(orgId, locale, keys) });
  }, [i18n, orgId, ask]);
}

/** Where words are asked for from now on (`useToolLabelSource`); the cleanup returned stops it. */
export function setToolLabelSource(own: LabelSource): () => void {
  source = own;
  return () => {
    if (source === own) source = null;
  };
}
