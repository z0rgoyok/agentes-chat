import type { ConnectorCategory, ConnectorDef } from "@agenteschat/client";
import { type BrandLook, brandLook } from "@agenteschat/client/lib/brand-look";
import { composioOffText, hiddenWithoutComposio } from "@agenteschat/client/lib/composio";
import { POSTGRES_MARK } from "@agenteschat/client/lib/databases";
import { MAIL_BRANDS, type MailChoice } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorDescription, connectorName, scopeText } from "@agenteschat/client/lib/scopes";
import {
  AgentSearching,
  Button,
  codeAndBold,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Icon,
  Skeleton,
  SkeletonGroup,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { ConnectorIcon } from "./ConnectorIcon";

export { ConnectorIcon };

import { useTranslation } from "react-i18next";
import { BrandArt } from "@/components/BrandArt";
import { DatabaseIcon } from "@/components/DatabaseConnect";
import { FlowTitle } from "@/components/FlowTitle";
import { MailIcon, mailAuthKind, mailChoiceName } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";

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

/** Connector search over label, id and description, plus the text shown (`shown`: the name and description in the app's language). */
export function searchCatalog(list: ConnectorDef[], query: string, shown: (d: ConnectorDef) => string = () => "") {
  const q = query.trim().toLowerCase();
  return q ? list.filter((d) => `${d.label} ${d.id} ${d.description} ${shown(d)}`.toLowerCase().includes(q)) : list;
}

/** How it connects, for the card: one click (OAuth), OAuth or a key, a key only, or through Composio. */
export function authKind(d: ConnectorDef): "oneClick" | "oauthOrKey" | "key" | "composio" {
  if (d.via === "composio") return "composio";
  if (d.kind === "remote_mcp") return "oneClick";
  return d.oauthConfigured && d.auth.includes("oauth") ? "oauthOrKey" : "key";
}

/** How a service connects, for the detail pane. */
type HowKind = ReturnType<typeof authKind> | "appPassword" | "addressPassword";

/** One service in the store: a catalog connector, a mailbox kind or the Postgres database. */
export interface CatalogEntry {
  key: string;
  name: string;
  description: string;
  category: ConnectorCategory | "email";
  connected: boolean;
  available: boolean;
  /** Not connected, and the vendor hasn't approved agentes.chat yet: greyed out with a lock, its row opens nothing. */
  soon: boolean;
  icon: (size: "md" | "lg") => ReactNode;
  brandColor: string | null;
  /** Its mark and its brand's colors, for its art in the store. */
  look: BrandLook;
  how: HowKind;
  /** What agents could do there; `asks` = it always asks a person first. */
  can: { text: string; asks: boolean }[];
  /** What connecting does to who can use it, or why this server can't connect it yet. */
  after: string;
  /** A first connection is every agent's (a catalog connector); else no agent uses it until someone chooses. */
  everyone: boolean;
  /** Connected already, the button adds another account (mailboxes, databases, MCP servers) or signs in again. */
  again: "add" | "reconnect";
  /** Starts this service's connect flow. */
  pick: () => void;
}

/** A category tab of the store, or its two fixed ones. */
export type StoreTab = ConnectorCategory | "email" | "featured";

/** i18n key of an id (`cloudflare-bindings` → `cloudflare_bindings`). */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "_");

/**
 * The capability lines of a service: our plain-language lines (`connectors.can.<id>`: "1", "2", "3",
 * and "ask" for what always asks approval), or else its scopes.
 */
function capabilities(t: TFunction, exists: (key: string) => boolean, id: string, def?: ConnectorDef) {
  const tt = t as unknown as (key: string) => string;
  const base = `connectors.can.${safeId(id)}`;
  if (exists(`${base}.1`)) {
    const lines = (["1", "2", "3"] as const)
      .filter((n) => exists(`${base}.${n}`))
      .map((n) => ({ text: tt(`${base}.${n}`), asks: false }));
    if (exists(`${base}.ask`)) lines.push({ text: tt(`${base}.ask`), asks: true });
    return lines;
  }
  return (def?.scopes ?? []).map((s) => ({ text: scopeText(t, s).label, asks: s.sensitive }));
}

/**
 * Suggestions, in order: the tools a team reaches for every day (social, errors, docs, product, code, design, mail).
 * The store features the first six not connected yet and ready on this server; the rest stand in for those that aren't.
 */
const SUGGESTED = [
  "instagram",
  "sentry",
  "notion",
  "linear",
  "github",
  "figma",
  "canva",
  "mail-gmail",
  "mail-outlook",
  "slack",
  "hubspot",
  "drive",
  "stripe",
  "database",
];

/** A category's row under the features shows these alone, in this order ("See all" opens the whole category). */
const FEATURED_ROWS: Partial<Record<ConnectorCategory | "email", string[]>> = {
  data: ["amplitude", "mixpanel", "posthog"],
};

/** How many suggestions the store's front features: one large, two beside it, three under them. */
const FEATURED = 6;

/** How many services a category shows under Featured before "See all". */
const ROW = 4;

/**
 * Every service the store offers, ready to connect first: the mailboxes this server connects (ADR 0038), the Postgres
 * database (ADR 0039) and the catalog's connectors. Without Composio here, the services that connect only through it
 * are left out (who manages connectors reads why: `composioOff`).
 */
export function useCatalogEntries({
  connectors,
  connected,
  onPick,
  mail,
  database,
}: {
  connectors: ConnectorDef[];
  /** Catalog ids already connected. */
  connected: Set<string>;
  /** Starts a service's connect flow; none where the list only shows the store's services (Settings' band). */
  onPick?: (def: ConnectorDef) => void;
  mail?: { choices: MailChoice[]; connected: Set<MailChoice>; onPick?: (choice: MailChoice) => void };
  /** It can be connected more than once. */
  database?: { connected: boolean; onPick?: () => void };
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const exists = (key: string) => i18n.exists(key);
  const entries: CatalogEntry[] = [
    ...(mail?.choices ?? []).map(
      (c): CatalogEntry => ({
        key: `mail-${c}`,
        name: mailChoiceName(t, c),
        description: t(`mail.choice.${c}.text`),
        category: "email",
        connected: mail?.connected.has(c) ?? false,
        available: true,
        soon: false,
        icon: (size) => <MailIcon choice={c} size={size} />,
        brandColor: c === "gmail" ? "#EA4335" : c === "icloud" ? "#3693F3" : null,
        look: brandLook(MAIL_BRANDS[c]?.iconUrl, MAIL_BRANDS[c]?.brandColor),
        how: mailAuthKind(c),
        can: capabilities(t, exists, `mail-${c}`),
        after: t("connectors.detail.afterText"),
        everyone: false,
        again: "add",
        pick: () => mail?.onPick?.(c),
      }),
    ),
    ...(database
      ? [
          {
            key: "database",
            name: t("database.name"),
            description: t("database.cardText"),
            category: "dev",
            connected: database.connected,
            available: true,
            soon: false,
            icon: (size: "md" | "lg") => <DatabaseIcon size={size} />,
            brandColor: null,
            look: brandLook(POSTGRES_MARK, null),
            how: "addressPassword",
            can: capabilities(t, exists, "database"),
            after: t("connectors.detail.afterText"),
            everyone: false,
            again: "add",
            pick: () => database.onPick?.(),
          } satisfies CatalogEntry,
        ]
      : []),
    ...connectors
      .filter((d) => !hiddenWithoutComposio(d) || connected.has(d.id))
      .map(
        (d): CatalogEntry => ({
          key: d.id,
          name: connectorName(t, d),
          description: connectorDescription(t, d),
          category: d.category,
          connected: connected.has(d.id),
          // One connected by its address (with a key) is a connection like any other: it opens, to connect again.
          available: d.available || (d.soon === true && connected.has(d.id)),
          soon: d.soon === true && !connected.has(d.id),
          icon: (size) => <ConnectorIcon def={d} label={d.label} size={size} />,
          brandColor: d.brandColor,
          look: brandLook(d.iconUrl, d.brandColor),
          how: authKind(d),
          can: capabilities(t, exists, d.id, d),
          // As the server does: a first connection is every agent's; then an MCP server takes another account
          // (no agent yet) and a catalog connector a new sign-in (who uses it stays).
          after: t(
            d.needsApp && !connected.has(d.id)
              ? "connectors.needsApp"
              : !connected.has(d.id)
                ? "connectors.detail.allText"
                : d.kind === "remote_mcp"
                  ? "connectors.detail.accountsText"
                  : "connectors.detail.replaceText",
            { name: connectorName(t, d) },
          ),
          everyone: !connected.has(d.id) && !d.needsApp,
          again: d.kind === "remote_mcp" ? "add" : "reconnect",
          pick: () => onPick?.(d),
        }),
      ),
  ];
  // Ready to connect first; "Em breve" last.
  entries.sort((a, b) => Number(b.available) - Number(a.available));
  const present = [
    ...((mail?.choices.length ?? 0) > 0 ? (["email"] as const) : []),
    ...CATEGORIES.filter((c) => entries.some((e) => e.category === c)),
  ].sort((a, b) => t(`connectors.category.${a}`).localeCompare(t(`connectors.category.${b}`), i18n.language));
  const composioOff = can(org, "manage_connectors") ? composioOffText(t, connectors, SUGGESTED) : null;
  return { entries, categories: present, composioOff };
}

/** The store's search: a service's name, what it does, its category and a few words people type for it. */
export function matchEntries(t: TFunction, entries: CatalogEntry[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) =>
    `${e.key} ${e.name} ${e.description} ${t(`connectors.category.${e.category}`)} ${e.key === "database" ? "postgres postgresql sql" : ""} ${e.category === "email" ? "email" : ""}`
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * A suggestion beside or under the large one: its mark on its brand's pixel sky, its name and what it does, and an
 * arrow. The whole card opens the service's dialog (its name is the control).
 */
function FeatureCard({ entry, onOpen }: { entry: CatalogEntry; onOpen: (entry: CatalogEntry) => void }) {
  const { t } = useTranslation();
  return (
    <article className="store-role">
      <BrandArt look={entry.look} template="glow" surface="--card-well" />
      <span className="store-role__mark">{entry.icon("lg")}</span>
      <span className="store-role__text">
        <span className="store-kicker">{t("connectors.store.suggested")}</span>
        <button type="button" className="store-open store-role__name" onClick={() => onOpen(entry)}>
          {entry.name}
        </button>
        <span className="store-role__sub">{entry.description}</span>
      </span>
      <Icon name="chevronRight" size={18} className="store-role__chev" />
    </article>
  );
}

/**
 * The store's front: six suggestions as features (the first one large, each on its brand's pixel sky), then a row of
 * services per category with "See all". A feature or a line opens the service's dialog, where it connects.
 */
export function StoreFeatured({
  entries,
  categories,
  onOpen,
  onCategory,
}: {
  entries: CatalogEntry[];
  categories: (ConnectorCategory | "email")[];
  onOpen: (entry: CatalogEntry) => void;
  onCategory: (category: ConnectorCategory | "email") => void;
}) {
  const { t } = useTranslation();
  const suggested = SUGGESTED.map((k) => entries.find((e) => e.key === k))
    .filter((e): e is CatalogEntry => !!e && !e.connected && e.available)
    .slice(0, FEATURED);
  const [hero, ...rest] = suggested;
  const side = rest.slice(0, 2);
  const under = rest.slice(2);
  return (
    <>
      {hero && (
        <div className="store-feats">
          <div className="store-feat" data-side={side.length || undefined}>
            <article className="store-hero">
              <BrandArt look={hero.look} template="glow" surface="--card-well" />
              <span className="store-hero__mark">{hero.icon("lg")}</span>
              <span className="store-kicker">{t("connectors.store.suggested")}</span>
              <h3 className="store-hero__name">
                <button type="button" className="store-open" onClick={() => onOpen(hero)}>
                  {hero.name}
                </button>
              </h3>
              <p className="store-hero__text">{hero.description}</p>
              <Button
                variant="primary"
                className="store-hero__more"
                aria-label={t("connectors.store.moreName", { name: hero.name })}
                onClick={() => onOpen(hero)}
              >
                {t("connectors.store.more")}
                <Icon name="chevronRight" size={16} />
              </Button>
            </article>
            {side.length > 0 && (
              <div className="store-side">
                {side.map((e) => (
                  <FeatureCard key={e.key} entry={e} onOpen={onOpen} />
                ))}
              </div>
            )}
          </div>
          {under.length > 0 && (
            <div className="store-trio">
              {under.map((e) => (
                <FeatureCard key={e.key} entry={e} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      )}
      {categories.map((c) => {
        const all = entries.filter((e) => e.category === c && !suggested.includes(e));
        const picked = FEATURED_ROWS[c];
        const list = picked
          ? picked.map((k) => all.find((e) => e.key === k)).filter((e): e is CatalogEntry => !!e)
          : all;
        if (list.length === 0) return null;
        return (
          <section key={c} className="store-sec" aria-labelledby={`store-cat-${c}`}>
            <div className="store-sec__head">
              <h3 id={`store-cat-${c}`}>{t(`connectors.category.${c}`)}</h3>
              {(list.length > ROW || all.length > list.length) && (
                <Button size="sm" variant="ghost" onClick={() => onCategory(c)}>
                  {t("connectors.store.seeAll")}
                </Button>
              )}
            </div>
            <StoreRows entries={list.slice(0, ROW)} onOpen={onOpen} />
          </section>
        );
      })}
    </>
  );
}

/**
 * Settings › Connectors' way to the store: a few services' marks (the suggestions first), how many this server
 * connects and "Browse connectors", on one line between hairlines.
 */
export function StoreBand({ entries, onOpen }: { entries: CatalogEntry[]; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const ready = entries.filter((e) => e.available && !e.connected);
  if (ready.length === 0) return null;
  const shown = [
    ...SUGGESTED.map((k) => ready.find((e) => e.key === k)).filter((e): e is CatalogEntry => !!e),
    ...ready.filter((e) => !SUGGESTED.includes(e.key)),
  ].slice(0, 5);
  const names = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
    shown.slice(0, 4).map((e) => e.name),
  );
  return (
    <div className="store-band">
      <span className="store-band__marks" aria-hidden="true">
        {shown.map((e) => (
          <span key={e.key}>{e.icon("md")}</span>
        ))}
      </span>
      <span className="store-band__text">
        <b>{t("connectors.store.bandTitle", { count: ready.length })}</b>
        <small>{t("connectors.store.bandText", { names })}</small>
      </span>
      <Button variant="primary" size="sm" onClick={onOpen}>
        {t("connectors.store.browse")}
      </Button>
    </div>
  );
}

/** A connection's line while the list loads: the mark, its name and what's under it, who uses it. */
function SkeletonLine({ seed }: { seed: number }) {
  return (
    <li className="store-item">
      <Skeleton shape="block" width={36} height={36} className="store-skeleton__mark" />
      <span className="store-item__text">
        <Skeleton width={[140, 180, 120][seed % 3]} height={14} />
        <Skeleton width={[260, 200, 300][seed % 3]} height={10} />
      </span>
      <Skeleton width={72} height={12} />
    </li>
  );
}

/** Settings › Connectors loading: the band's line (who may add), the list's heading and three lines, sized as they come. */
export function ConnectedSkeleton({ band }: { band: boolean }) {
  const { t } = useTranslation();
  return (
    <SkeletonGroup label={t("common.loadingList")} className="store-skeleton">
      {band && (
        <div className="store-band">
          <span className="store-band__marks">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i}>
                <Skeleton shape="block" width={34} height={34} className="store-skeleton__mark" />
              </span>
            ))}
          </span>
          <span className="store-band__text">
            <Skeleton width={180} height={14} />
            <Skeleton width={260} height={10} />
          </span>
          <Skeleton shape="block" width={116} height={32} />
        </div>
      )}
      <Skeleton width={120} height={20} />
      <ul className="store-list">
        {[0, 1, 2].map((i) => (
          <SkeletonLine key={i} seed={i} />
        ))}
      </ul>
    </SkeletonGroup>
  );
}

/** The store loading: the features' blocks and a category's lines in two columns. */
export function StoreSkeleton() {
  const { t } = useTranslation();
  return (
    <SkeletonGroup label={t("common.loadingList")} className="store-skeleton">
      <div className="store-feat" data-side>
        <Skeleton shape="block" height={272} className="store-skeleton__hero" />
        <div className="store-side">
          <Skeleton shape="block" height={128} className="store-skeleton__hero" />
          <Skeleton shape="block" height={128} className="store-skeleton__hero" />
        </div>
      </div>
      <Skeleton width={160} height={20} />
      <ul className="store-rows">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonLine key={i} seed={i} />
        ))}
      </ul>
    </SkeletonGroup>
  );
}

/**
 * Services in two columns of lines (one on narrow screens): the mark, the name, what it does, its state and an arrow.
 * A line opens the service's dialog wherever it is clicked; one coming soon opens nothing.
 */
export function StoreRows({ entries, onOpen }: { entries: CatalogEntry[]; onOpen: (entry: CatalogEntry) => void }) {
  const { t } = useTranslation();
  return (
    <ul className="store-rows">
      {entries.map((e) => (
        <li
          key={e.key}
          className={e.soon ? "store-item" : "store-item store-item--link"}
          data-soon={!e.available || undefined}
        >
          <button
            type="button"
            className="store-item__open"
            disabled={e.soon}
            aria-label={
              e.connected
                ? t("connectors.tileConnected", { name: e.name })
                : e.soon
                  ? t("connectors.tileSoon", { name: e.name })
                  : e.name
            }
            onClick={() => onOpen(e)}
          >
            {e.icon("md")}
            <span className="store-item__text">
              <b className="ac-captop">{e.name}</b>
              <small>{e.description}</small>
            </span>
          </button>
          {e.connected ? (
            <span className="store-state" data-s="ok">
              {t("connectors.store.connected")}
            </span>
          ) : (
            !e.available && (
              <span className="store-state" data-s="soon">
                <Icon name="lock" size={14} />
                {t("connectors.soon")}
              </span>
            )
          )}
          {!e.soon && <Icon name="chevronRight" size={16} className="store-item__chev" />}
        </li>
      ))}
    </ul>
  );
}

/** A search with no match, or an empty category: an agent searching, with the way in by address. */
export function StoreEmpty({ query, onOther }: { query: string; onOther: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      className="catalog__empty"
      art={<AgentSearching />}
      title={query ? t("connectors.empty", { q: query }) : t("connectors.emptyCategory")}
      actions={
        <Button icon="link" onClick={onOther}>
          {t("connectors.otherConnect")}
        </Button>
      }
    >
      {t("connectors.emptyText")}
    </EmptyState>
  );
}

/** Under the store: the way in for a service it doesn't list, and why some are missing on this server. */
export function StoreFoot({ onOther, composioOff }: { onOther: () => void; composioOff?: string | null }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="store-foot">
        {t("connectors.store.notListed")}{" "}
        <Button variant="link" onClick={onOther}>
          {t("connectors.otherConnect")}
        </Button>
      </p>
      {composioOff && <p className="small muted">{codeAndBold(composioOff)}</p>}
    </>
  );
}

/** "Connectors" over a connection's page in Settings › Connectors: back to the list. */
export function StoreBack({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="store-back" onClick={onBack}>
      <Icon name="chevronLeft" size={16} />
      {t("connectors.title")}
    </button>
  );
}

/**
 * A service's dialog in the store: its brand's art on top, its mark on the art's edge, its name and what it is; a strip saying how it connects, who uses it and
 * whether something asks a person; what agents could do and what connecting changes; how it connects beside its one
 * button. Connecting closes it and opens the connect flow.
 */
export function ServiceDialog({
  entry,
  open,
  onClose,
}: {
  entry: CatalogEntry | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!entry) return null;
  const asks = entry.can.some((c) => c.asks);
  const label = t(
    !entry.connected
      ? "connectors.connectName"
      : entry.again === "add"
        ? "connectors.addAccountName"
        : "connectors.reconnectName",
    { name: entry.name },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={<FlowTitle tile={entry.icon("lg")}>{entry.name}</FlowTitle>}
      description={
        <>
          {entry.connected && (
            <>
              <span className="store-state" data-s="ok">
                {t("connectors.store.connected")}
              </span>
              {" · "}
            </>
          )}
          {entry.description}
        </>
      }
      closeLabel={t("common.close")}
      width={620}
      className="store-dialog"
      cover={<BrandArt look={entry.look} template="pattern" surface="--surface-raised" />}
    >
      <DialogBody className="store-dialog__body">
        <dl className="store-strip">
          <div>
            <dt>{t("connectors.store.howLabel")}</dt>
            <dd>{t(`connectors.howShort.${entry.how}`)}</dd>
          </div>
          <div>
            <dt>{t("connectors.who")}</dt>
            <dd>{t(entry.everyone ? "connectors.store.whoAll" : "connectors.store.whoChoose")}</dd>
          </div>
          {asks && (
            <div>
              <dt>{t("connectors.store.asksLabel")}</dt>
              <dd>{t("connectors.store.asksSensitive")}</dd>
            </div>
          )}
        </dl>
        {entry.can.length > 0 && (
          <section>
            <h4>{t("connectors.detail.can")}</h4>
            <ul className="store-caps">
              {entry.can.map((c) => (
                <li key={c.text} className="ac-iconline" data-asks={c.asks || undefined}>
                  <Icon name={c.asks ? "shield" : "check"} size={14} />
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h4>{t("connectors.store.afterTitle")}</h4>
          <p className="store-after">{entry.after}</p>
        </section>
      </DialogBody>
      <DialogFooter note={t(`connectors.how.${entry.how}`)}>
        {entry.available ? (
          <Button
            variant="primary"
            aria-label={label}
            onClick={() => {
              onClose();
              entry.pick();
            }}
          >
            {!entry.connected
              ? label
              : entry.again === "add"
                ? t("connectors.detail.addAccount")
                : t("connectors.detail.reconnect")}
          </Button>
        ) : (
          <Button variant="primary" disabled>
            {t("connectors.soon")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
