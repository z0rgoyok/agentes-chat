import type { TFunction } from "i18next";
import type { Connection, ConnectOutcome, ConnectorDef, CustomServer } from "../api/types";
import { exposedTools, sameServer, toolsToReview } from "./custom-tools";
import { isolate } from "./format";
import { type Owned, ownerScopeOf, ownerSplit, ownerTabOf } from "./owner-split";
import { connectorName } from "./scopes";
import { reviewToolsOf } from "./tool-review";

/** A one-color mark the web app serves, drawn in its brand color. Only a file of ours by name, never any URL. */
export const CONNECTOR_MARK = /^\/connectors\/[a-z0-9-]+\.svg$/;
/** A mark in its maker's colors the web app serves, drawn as it is. */
export const OWN_MARK = /^\/brands\/[a-z0-9-]+\.svg$/;
/** `Connection.authType` of GitHub through the agentes.chat app alone (mirror of `GITHUB_APP_AUTH` in the engine). */
export const GITHUB_APP_AUTH = "github_app";
/** A server's own icon, as the backend keeps and serves it behind the session (never the server's URL). */
export const SERVER_ICON = /^\/api\/app\/connector-icons\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f]{16}\.(jpg|png|webp)$/;

/**
 * One row of "Conectados", whatever the kind: a catalog connection (GitHub
 * with our scopes) or an MCP server connected by address (a one-click
 * preset or any other). Both are connections: the id is the connection id.
 */
export interface ConnectedItem {
  id: string;
  /** An MCP server by address: its tools are reviewed here. */
  custom: boolean;
  label: string;
  /** The catalog entry (also the preset a custom server came from): icon, scopes. */
  def: ConnectorDef | null;
  /** A server's own icon (`/api/app/connector-icons/…`), shown when the catalog has none for it. */
  image?: string | null;
  /** "acme" (the account) when the name doesn't already say it, or the server's host (never Composio's). */
  account: string | null;
  /** Connected through Composio (ADR 0107): its page signs in, and no address shows. */
  viaComposio: boolean;
  /**
   * GitHub through the agentes.chat app alone (ADR 0156): no account signed in, so nothing to reconnect; `account`
   * holds the accounts it is installed on.
   */
  viaGithubApp?: boolean;
  /** Its sign-in stopped working (a refresh refused, a 401, a Composio account gone): no tools until Reconectar. */
  needsReconnect: boolean;
  /** OAuth scopes its sign-in lacks (GitHub's `project`): Reconectar adds what they let agents do. */
  reconnectAdds: string[];
  /** A server by address whose tools couldn't be read last time (its words): agents have none from it now. */
  toolsError: string | null;
  createdAt: string;
  /** Tools agents can be given. */
  tools: number;
  /** Tools waiting for a decision. */
  pending: number;
  /** Never reviewed, or new tools to review. */
  needsReview: boolean;
  server: CustomServer | null;
  /** A personal connection's person; null: the team's (older servers say nothing: the team's). */
  ownerUserId: string | null;
  /** Someone else's personal connection: the agents that hold it (the only detail its row may show). */
  agentIds: string[];
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The account as the provider names it, unless the connection's name already says it ("Stripe (Acme)"). */
const accountNote = (label: string, account: string | null | undefined) =>
  account && !label.includes(account) ? account : null;

export function fromConnection(c: Connection, catalog: ConnectorDef[]): ConnectedItem {
  const def = catalog.find((d) => d.id === c.connector) ?? null;
  return {
    id: c.id,
    custom: false,
    label: c.label,
    def,
    image: null,
    account: accountNote(c.label, c.accountLabel),
    viaComposio: false,
    viaGithubApp: c.authType === GITHUB_APP_AUTH,
    needsReconnect: c.status === "needs_reconnect",
    reconnectAdds: c.reconnectAdds ?? [],
    toolsError: null,
    createdAt: c.createdAt,
    tools: def?.tools.length ?? 0,
    pending: 0,
    needsReview: false,
    server: null,
    ownerUserId: c.ownerUserId ?? null,
    agentIds: c.agentIds ?? [],
  };
}

export function fromServer(s: CustomServer, catalog: ConnectorDef[]): ConnectedItem {
  const pending = toolsToReview(s);
  return {
    id: s.id,
    custom: true,
    label: s.label,
    def: catalog.find((d) => d.kind === "remote_mcp" && sameServer(d.serverUrl, s.serverUrl)) ?? null,
    image: s.iconUrl ?? null,
    // Composio's address means nothing to people: only the account, when it is known.
    account: s.accountLabel ? accountNote(s.label, s.accountLabel) : s.via === "composio" ? null : host(s.serverUrl),
    viaComposio: s.via === "composio",
    needsReconnect: s.status === "needs_reconnect",
    reconnectAdds: [],
    toolsError: s.toolsError ?? null,
    createdAt: s.createdAt,
    tools: exposedTools(s).length,
    pending,
    needsReview: !s.reviewedAt || pending > 0,
    server: s,
    ownerUserId: s.ownerUserId ?? null,
    agentIds: s.agentIds ?? [],
  };
}

/**
 * The line that says what Reconectar adds to a connection whose sign-in lacks scopes the connector asks for now
 * ("Reconecte o GitHub para os agentes usarem também o GitHub Projects"); null when nothing is missing.
 */
export function reconnectAddsText(t: TFunction, item: Pick<ConnectedItem, "reconnectAdds" | "label" | "def">) {
  if (item.reconnectAdds.length === 0) return null;
  const tt = t as unknown as (key: string, options: { defaultValue: string }) => string;
  const what = item.reconnectAdds
    .map((scope) =>
      tt(`connectors.adds.${`${item.def?.id ?? ""}_${scope}`.replace(/[^a-zA-Z0-9]/g, "_")}`, { defaultValue: scope }),
    )
    .join(", ");
  return t("connectors.reconnectAdds", { name: item.label, what });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The catalog entry a work log's app is ("GitHub", "himetrica"): by id or name, else by a connection's name without
 * its number and its account ("Stripe (Acme) 2" is Stripe).
 */
export function appConnector<T extends Pick<ConnectorDef, "id" | "label">>(catalog: T[], app: string): T | null {
  const unnumbered = app.replace(/\s+\d+$/, "");
  for (const name of [app, unnumbered, unnumbered.replace(/\s*\([^)]*\)$/, "")]) {
    const key = slug(name);
    const def = catalog.find((d) => slug(d.id) === key || slug(d.label) === key);
    if (def) return def;
  }
  return null;
}

/** Every active connection, oldest first. */
export function connectedItems(connections: Connection[], servers: CustomServer[], catalog: ConnectorDef[]) {
  return [
    ...connections.filter((c) => !c.revokedAt).map((c) => fromConnection(c, catalog)),
    ...servers.map((s) => fromServer(s, catalog)),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * An MCP server the catalog doesn't list, connected by its address ("Can't find it", "Add MCP"): the MCPs section,
 * apart from the catalog's connectors (a one-click server and a service through Composio are the catalog's).
 */
export const isMcpItem = (item: Pick<ConnectedItem, "custom" | "def" | "viaComposio">) =>
  item.custom && !item.def && !item.viaComposio;

/** Catalog ids that are connected (a preset counts when a server has its address). */
export function connectedIds(items: ConnectedItem[]) {
  return new Set(items.flatMap((i) => (i.def ? [i.def.id] : [])));
}

/**
 * The name a connected service shows: its connection's own ("Stripe (Acme)", "Stripe 2", a rename), so two
 * accounts read apart everywhere; a name nobody changed is the catalog's, in the app's language ("Supabase (somente
 * leitura) 2" for "Supabase (read-only) 2").
 */
export function itemName(t: TFunction, item: Pick<ConnectedItem, "def" | "label">) {
  if (!item.def) return item.label;
  const name = connectorName(t, item.def);
  if (item.label === item.def.label || item.label === name) return name;
  const number = item.label.startsWith(`${item.def.label} `) ? item.label.slice(item.def.label.length + 1) : "";
  return /^\d+$/.test(number) ? `${name} ${number}` : item.label;
}

/**
 * What a connect did, as a toast: another account came in, an account got its new sign-in, or the account was
 * already there (with the way to add another when the provider named it).
 */
export function outcomeText(t: TFunction, outcome: ConnectOutcome, item: ConnectedItem) {
  const name = itemName(t, item);
  if (outcome === "reconnected") return t("connectors.outcome.reconnected", { name });
  if (outcome === "connected") return t("connectors.connectedToast", { name });
  const service = item.def ? connectorName(t, item.def) : name;
  return item.server?.accountLabel
    ? t("connectors.outcome.sameAccount", { name, service })
    : t("connectors.outcome.already", { name });
}

/**
 * How many of a connection's actions ask in the chat at the levels it has: a server's tools at "pede aprovação" (the
 * decision, else our suggestion, which is what applying them saves), a catalog connector's sensitive ones.
 */
export function asksCount(t: TFunction, item: Pick<ConnectedItem, "server" | "def">) {
  return item.server
    ? reviewToolsOf(t, item.server).filter((x) => x.level === "approval").length
    : (item.def?.tools ?? []).filter((x) => x.sensitive).length;
}

/**
 * What a connection just made is, in a sentence or two: every agent has it and how many actions ask ("Todos os
 * agentes podem usar. 4 ações pedem aprovação no chat."). A server whose tools no one gave a level yet says
 * that instead: agents get none of them until someone does (`pending`). Nothing asking adds no second sentence.
 */
export function connectedSummary(t: TFunction, item: Pick<ConnectedItem, "server" | "def" | "pending">) {
  const lead =
    item.pending > 0 ? t("connectFlow.done.waiting", { count: item.pending }) : t("connectFlow.done.everyone");
  const asks = asksCount(t, item);
  return asks > 0 ? t("common.joinSentences", { a: lead, b: t("connectFlow.done.asks", { count: asks }) }) : lead;
}

/** What changed in the GitHub organizations we reach since `before`, in a sentence; it says so when nothing did. */
export function orgAccessChange(t: TFunction, before: readonly string[], now: readonly string[]) {
  const added = now.filter((o) => !before.includes(o));
  const removed = before.filter((o) => !now.includes(o));
  if (added.length === 0 && removed.length === 0) return t("connectFlow.githubOrgs.same");
  return [
    added.length > 0 ? t("connectFlow.githubOrgs.added", { names: added.join(", ") }) : "",
    removed.length > 0 ? t("connectFlow.githubOrgs.removed", { names: removed.join(", ") }) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Whether a server's sign-in can't be told apart by account: none of its accounts here was named by the provider
 * (ADR 0099). Then Reconectar can't refuse another account and a new connect can't spot one already here, so the
 * step asks the person to pick the right one.
 */
export function accountUnchecked(accounts: readonly (Pick<CustomServer, "accountLabel"> | null | undefined)[]) {
  return !accounts.some((a) => a?.accountLabel);
}

/** The connectors that are git hosts (engine `git/hosts/refs.ts`): a person's own is their account in code sessions. */
const GIT_HOST_CONNECTORS = new Set(["github", "gitlab", "bitbucket", "git"]);
export const isGitHostConnector = (id: string | undefined) => Boolean(id && GIT_HOST_CONNECTORS.has(id));

/**
 * Connectors that connect for the team only (mirror of `requireConnect` in the engine): none now. GitHub as a
 * person's own is their account in code sessions (ADR 0215), never the workspace's GitHub.
 */
export const TEAM_ONLY_CONNECTORS: ReadonlySet<string> = new Set();

/** Whether "Para quem: Pessoal" is offered for a catalog entry (any server by address may be personal). */
export const personalAllowed = (connectorId: string | null | undefined) =>
  !connectorId || !TEAM_ONLY_CONNECTORS.has(connectorId);

/**
 * Whether a member may connect, as their own, an app an agent asked for: a git host of one's own gives agents no
 * tools (it is the person's account in code sessions), so what an agent asks of one is the team's to connect.
 */
export const personalServesAgents = (connectorId: string | null | undefined) =>
  personalAllowed(connectorId) && !isGitHostConnector(connectorId ?? undefined);

/**
 * What a viewer may do with a connection's row (mirror of `mayConnection` in the engine). Their own: everything, and
 * moving it to the team when they manage connectors. Someone else's personal one: who manages connectors removes it
 * or takes it off an agent, never opens it. The team's: every member sees it, who manages connectors changes it.
 */
export function connectionActs(item: Owned & { viaComposio?: boolean }, userId: string, managesConnectors: boolean) {
  const scope = ownerScopeOf(item, userId);
  const mine = scope === "mine";
  const team = scope === "team";
  return {
    /** See its details (tools, account, address) and open its sheet. */
    open: scope !== "others",
    rename: mine || (team && managesConnectors),
    /** Reconnect, classify its tools, set its headers. */
    change: mine || (team && managesConnectors),
    remove: mine || managesConnectors,
    /** Turn it on for an agent. */
    giveToAgents: mine || (team && managesConnectors),
    /** "Tirar de um agente". */
    takeOffAgent: mine || managesConnectors,
    /** A one-click account lives under its person's own id at the hosted adapter: it connects again for the team. */
    moveToTeam: mine && managesConnectors && !item.viaComposio,
  };
}

export type ConnectionTab = "team" | "personal";

/**
 * Conectores split as the Vault's (ADR 0099 addendum), on the web and the phone: "Equipe | Pessoal" where the
 * workspace has more than one person or someone has a personal connection. A mailbox is always its person's, so in a
 * workspace of one it never splits the list: it stays in the one list. It opens as Skills does
 * (`ownerTabOf`). Each tab's connections and mailboxes, and other people's
 * personal ones (who manages connectors gets those from the server) for the group under Equipe. `databases`: the
 * team's databases the list shows on Equipe, counted there.
 */
export function connectionTabs<I extends Owned, M extends Owned>(input: {
  items: readonly I[];
  mailboxes: readonly M[];
  me: string;
  members: number;
  manages: boolean;
  picked: ConnectionTab | null;
  databases?: number;
}) {
  const byOwner = ownerSplit(input.items, input.me);
  const mail = ownerSplit(input.mailboxes, input.me);
  const shown = input.members > 1 || input.items.some((i) => i.ownerUserId);
  const team = byOwner.team.length + mail.team.length + (input.databases ?? 0);
  const mine = byOwner.mine.length + mail.mine.length;
  const tab: ConnectionTab = ownerTabOf(shown, input.picked, input.manages, { team, mine });
  const personal = tab === "personal";
  return {
    shown,
    tab,
    team,
    mine,
    items: personal ? byOwner.mine : byOwner.team,
    mailboxes: !shown ? [...mail.team, ...mail.mine] : personal ? mail.mine : mail.team,
    others: input.manages && !personal ? byOwner.others : [],
    othersMail: input.manages && !personal ? mail.others : [],
  };
}

/** "Pessoal de <name>": whose someone else's connection or mailbox is, the name kept in its own direction. */
export const personalOfText = (t: TFunction, name: string) => t("connectors.personal.of", { name: isolate(name) });

/**
 * "Pessoal de <name>" as the words before and after the name, in the language's order, so a screen can cut the name
 * alone in its own direction (a right-to-left name keeps its start).
 */
export const personalOfParts = (t: TFunction) => {
  const [before = "", after = ""] = t("connectors.personal.of", { name: "\u0000" }).split("\u0000");
  return { before, after };
};
