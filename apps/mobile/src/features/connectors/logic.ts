import type { ConnectorCategory, ConnectorDef, CustomConnectStart } from "@agenteschat/client";
import { hiddenWithoutComposio } from "@agenteschat/client/lib/composio";
import { CONNECTOR_MARK, type ConnectedItem, OWN_MARK, SERVER_ICON } from "@agenteschat/client/lib/connected";
import { heldWhole, joinNames } from "@agenteschat/client/lib/format";
import { mixHex } from "@agenteschat/ui/agent/engine";
import type { TFunction } from "i18next";

export { type ConnectionTab, connectionTabs } from "@agenteschat/client/lib/connected";

/**
 * The connectors gallery on the phone: pure pieces the screen and
 * the tests share. No React Native imports.
 */

/**
 * Suggestions, in order (the web's list, catalog services only): the tools a team reaches for every day, the first
 * ready here and not connected yet featured, the rest standing in for those that aren't.
 */
export const SUGGESTED = [
  "instagram",
  "sentry",
  "notion",
  "linear",
  "github",
  "figma",
  "canva",
  "slack",
  "hubspot",
  "drive",
  "stripe",
];

/** Categories in the order their shelves stand. */
export const CATEGORIES: ConnectorCategory[] = [
  "dev",
  "product",
  "docs",
  "data",
  "payments",
  "sales",
  "support",
  "marketing",
  "automation",
  "social",
];

/**
 * The organization's live connection to a catalog service, counted as the web counts it (`connectedItems`:
 * our connector's connection, or a vendor's server connected by its address, like Sentry's or Linear's).
 */
export function connectionOf(def: ConnectorDef, items: ConnectedItem[]): ConnectedItem | undefined {
  return items.find((i) => i.def?.id === def.id);
}

/**
 * What an admin does with a connected account on its screen: rename it and sign it in again; an MCP server also
 * takes another account (a catalog connector has one). GitHub through the agentes.chat app alone has no sign-in to
 * renew: its accounts are the app's installations.
 */
export function accountActions(
  item: Pick<ConnectedItem, "custom" | "viaGithubApp">,
): ("rename" | "reconnect" | "add")[] {
  if (item.viaGithubApp) return ["rename"];
  return item.custom ? ["rename", "reconnect", "add"] : ["rename", "reconnect"];
}

/** A shelf of the catalog: one category's services. */
export interface Shelf {
  key: ConnectorCategory;
  defs: ConnectorDef[];
}

/**
 * The catalog as shelves (Conectores): each category in `CATEGORIES`' order with the services offered in it; a
 * category with none has no shelf. The suggested services are the featured cards above (`FeaturedCards`), and are on
 * their category's shelf too: each shelf is the whole of what it names.
 */
export function catalogShelves(offered: readonly ConnectorDef[]): Shelf[] {
  const shelves: Shelf[] = [];
  for (const key of CATEGORIES) {
    const defs = offered.filter((d) => d.category === key);
    if (defs.length > 0) shelves.push({ key, defs });
  }
  return shelves;
}

/** Rows in a shelf's column: the columns slide sideways, three services each. */
export const SHELF_ROWS = 3;

/** A shelf's columns, `rows` services each, in order. */
export function shelfColumns<T>(items: readonly T[], rows = SHELF_ROWS): T[][] {
  const columns: T[][] = [];
  for (let i = 0; i < items.length; i += rows) columns.push(items.slice(i, i + rows));
  return columns;
}

/** The suggestions that can be connected here and aren't yet, in `SUGGESTED`'s order (three by default). */
export function suggestionsOf(catalog: ConnectorDef[], items: ConnectedItem[], count = 3): ConnectorDef[] {
  const out: ConnectorDef[] = [];
  for (const id of SUGGESTED) {
    const def = catalog.find((d) => d.id === id);
    if (def?.available && !connectionOf(def, items)) out.push(def);
    if (out.length === count) break;
  }
  return out;
}

/** Search over the name, id and description (and the text shown in the app's language). */
export function searchConnectors(list: ConnectorDef[], query: string, shown: (d: ConnectorDef) => string = () => "") {
  const q = query.trim().toLowerCase();
  return q ? list.filter((d) => `${d.label} ${d.id} ${d.description} ${shown(d)}`.toLowerCase().includes(q)) : list;
}

/** The connected row's mailboxes: a sign-in still pending (or left unfinished) has no name or address to show. */
export const shownMailboxes = <T extends { status: string }>(accounts: T[]) =>
  accounts.filter((a) => a.status !== "pending");

/**
 * The gallery's tiles: the ones that open first, "Em breve" last (as on the web). A connected one opens its
 * connection, even one connected by its address whose vendor hasn't approved agentes.chat yet (`soon`); a `soon`
 * one not connected gets a lock and opens nothing. One that connects only through Composio, on a server without it,
 * isn't shown unless connected.
 */
export function galleryTiles(list: ConnectorDef[], items: ConnectedItem[]) {
  return list
    .filter((def) => !hiddenWithoutComposio(def) || connectionOf(def, items))
    .map((def) => {
      const connected = Boolean(connectionOf(def, items));
      return {
        def,
        connected,
        opens: (def.available && !def.soon) || connected,
        locked: def.soon === true && !connected,
      };
    })
    .sort((a, b) => Number(b.opens) - Number(a.opens));
}

/**
 * Why the sheet asks for a key: the server only lets in apps it approved (`not_approved`, with its own words on the
 * next line when it gave any), it said no to the request headers sent alone (`sentHeaders`), or it has no sign-in.
 */
export function needsKeyText(
  t: TFunction,
  start: Extract<CustomConnectStart, { status: "needs_key" }>,
  name: string,
  sentHeaders = false,
  /** Who may give the workspace its own OAuth app is pointed there instead of to a key. */
  ownClient = false,
) {
  if (start.reason !== "not_approved") {
    return t(sentHeaders ? "connectFlow.headers.refused" : "mobile.connectors.needsKey");
  }
  const text = t(ownClient ? "connectFlow.ownClient.notApproved" : "connectFlow.notApproved", { name });
  return start.detail ? `${text}\n${t("connectFlow.serverSaid", { detail: start.detail })}` : text;
}

/**
 * A shared line about request headers with its `<names/>` said as a list ("X-API-Key e X-Tenant"): the web draws each
 * name as code there, the phone as words. A name never breaks at its hyphens. The names go in through a function:
 * `$&` and `$'` in a name are its own characters, not patterns of the replacement.
 */
export const headerNamesText = (
  t: TFunction,
  key: "connectors.sendsToo" | "connectFlow.headers.saved" | "connectFlow.headers.dropping",
  names: readonly string[],
) => t(key, { count: names.length }).replace("<names/>", () => joinNames(names.map(heldWhole), t));

/** How a service connects on the phone: signing in in the browser, a key, or either. */
export type ConnectHow = "signIn" | "key" | "either";

export function connectHow(def: ConnectorDef): ConnectHow {
  // A vendor's official server: its own sign-in (or a key when it asks for one).
  if (def.kind === "remote_mcp") return "signIn";
  const signIn = def.oauthConfigured && def.auth.includes("oauth");
  const key = def.auth.includes("api_key");
  return signIn && key ? "either" : signIn ? "signIn" : "key";
}

/** i18n key of an id (`cloudflare-bindings` → `cloudflare_bindings`). */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "_");

/**
 * What agents could do there, in plain words: our lines (`connectors.can.<id>`: "1", "2", "3", and "ask"
 * for what always asks approval, the same as the web), or else the service's scopes.
 */
export function capabilityLines(
  tr: (key: string) => string,
  exists: (key: string) => boolean,
  def: Pick<ConnectorDef, "id" | "scopes">,
  scopeLabel: (scope: ConnectorDef["scopes"][number]) => string,
): { text: string; asks: boolean; said?: boolean }[] {
  const base = `connectors.can.${safeId(def.id)}`;
  if (exists(`${base}.1`)) {
    const lines: { text: string; asks: boolean; said?: boolean }[] = (["1", "2", "3"] as const)
      .filter((n) => exists(`${base}.${n}`))
      .map((n) => ({ text: tr(`${base}.${n}`), asks: false }));
    // Our own line for what asks already says it asks ("… sempre pedem sua aprovação"): `said`, nothing to add.
    if (exists(`${base}.ask`)) lines.push({ text: tr(`${base}.ask`), asks: true, said: true });
    return lines;
  }
  return def.scopes.map((s) => ({ text: scopeLabel(s), asks: s.sensitive }));
}

/** The state an authorize URL carries (to recognize the answer the browser brings back). */
export function stateOf(authorizeUrl: string): string | null {
  try {
    return new URL(authorizeUrl).searchParams.get("state");
  } catch {
    return null;
  }
}

/** Where the browser brings the answer back (APP_OAUTH_REDIRECT on the server). */
export const APP_RETURN_URL = "agenteschat://connectors/oauth";

/**
 * What the browser brought back to the app (`agenteschat://connectors/oauth?state=…&code=…` or `?error=…`); the
 * agentes.chat GitHub app's install adds the installation (`installation_id`), finished with `…/github-app/complete`.
 */
export type AuthAnswer =
  | { kind: "code"; state: string; code: string; installationId?: number }
  | { kind: "error"; error: string };

export function authAnswerOf(url: string): AuthAnswer | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const error = parsed.searchParams.get("error");
  if (error) return { kind: "error", error };
  const state = parsed.searchParams.get("state");
  const code = parsed.searchParams.get("code");
  const installationId = installationIdOf(parsed.searchParams.get("installation_id"));
  if (!state || !code) return null;
  return installationId ? { kind: "code", state, code, installationId } : { kind: "code", state, code };
}

/** The agentes.chat GitHub app's installation an answer carries (`installation_id`), when it is one. */
export function installationIdOf(value: string | null | undefined): number | undefined {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Authorizations the open sheet is finishing itself: the deep link route (Android also opens the app with
 * the answer) leaves those alone, so the same code is never sent twice.
 */
const finishing = new Set<string>();
export const markFinishing = (state: string) => finishing.add(state);
export const isFinishing = (state: string) => finishing.has(state);
export const doneFinishing = (state: string) => finishing.delete(state);

/** A one-color brand icon's address on the server (`/connectors/{name}.svg`, tinted), or null. */
export function iconUri(base: string, iconUrl: string | null): string | null {
  return iconUrl && CONNECTOR_MARK.test(iconUrl) ? `${base}${iconUrl}` : null;
}

/** A mark's address on the server when it keeps its maker's colors (`/brands/{name}.svg`, never tinted), or null. */
export function ownMarkUri(base: string, iconUrl: string | null): string | null {
  return iconUrl && OWN_MARK.test(iconUrl) ? `${base}${iconUrl}` : null;
}

/** A server's own icon's address on the server (`/api/app/connector-icons/…`), or null. */
export function serverIconUri(base: string, image: string | null | undefined): string | null {
  return image && SERVER_ICON.test(image) ? `${base}${image}` : null;
}

/** A brand color we can trust ("#rrggbb"), else null. */
export const brandOf = (color: string | null) => (color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null);

/** The suggestion card's strip: tones from the surface into the brand's color, deep last. */
export function brandTones(surface: string, brand: string): string[] {
  return [
    surface,
    mixHex(surface, brand, 0.1),
    mixHex(surface, brand, 0.2),
    mixHex(surface, brand, 0.34),
    mixHex(surface, brand, 0.5),
  ];
}

/** "GitHub" → "G", "Google Drive" → "GD": the monogram of a service without an icon. */
export function monogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0]?.[0] ?? "?");
  return letters.toUpperCase();
}

/** A plausible MCP server address (https only, like the server). */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

// ── A service's own page ─────────────────────────────────────────────────────────────────────────────────────────

/** Each category's icon on a service's page (its facts' first column). */
const CATEGORY_ICONS: Record<ConnectorCategory, string> = {
  dev: "code",
  product: "issue",
  docs: "doc",
  data: "chart",
  payments: "wallet",
  sales: "target",
  support: "help",
  marketing: "sparkle",
  automation: "bolt",
  social: "members",
};

export const categoryIcon = (category: ConnectorCategory): string => CATEGORY_ICONS[category] ?? "plug";

/**
 * What a service's page says of it before it is connected: how many tools it brings and how many always ask for
 * approval (only our own connectors list them; a vendor's server shows its tools once connected: null), how it signs
 * in, and the host it connects to (a vendor's server; ours connect through this server: null).
 */
export function serviceFacts(def: Pick<ConnectorDef, "kind" | "tools" | "auth" | "oauthConfigured" | "serverUrl">): {
  tools: number | null;
  asks: number;
  how: ConnectHow;
  host: string | null;
} {
  const known = def.kind === "catalog" && def.tools.length > 0;
  let host: string | null = null;
  if (def.kind === "remote_mcp" && def.serverUrl) {
    try {
      host = new URL(def.serverUrl).host || null;
    } catch {
      host = null;
    }
  }
  return {
    tools: known ? def.tools.length : null,
    asks: known ? def.tools.filter((x) => x.sensitive).length : 0,
    how: connectHow(def as ConnectorDef),
    host,
  };
}

/** "Mais em <categoria>" on a service's page: the others of its category it could connect, in the catalog's order. */
export function relatedServices(
  def: Pick<ConnectorDef, "id" | "category">,
  offered: readonly ConnectorDef[],
  max = 6,
): ConnectorDef[] {
  return offered.filter((d) => d.category === def.category && d.id !== def.id).slice(0, max);
}
