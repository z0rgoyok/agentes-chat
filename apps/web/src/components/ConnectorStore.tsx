import {
  useCatalog,
  useConnections,
  useCustomServers,
  useDatabases,
  useMailAccounts,
  useMailProviders,
} from "@agenteschat/client";
import { connectedIds, connectedItems, personalAllowed } from "@agenteschat/client/lib/connected";
import { choiceOf } from "@agenteschat/client/lib/mail";
import { ownerScopeOf } from "@agenteschat/client/lib/owner-split";
import { can } from "@agenteschat/client/lib/permissions";
import { Icon, SearchField } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import {
  type CatalogEntry,
  matchEntries,
  ServiceDialog,
  StoreEmpty,
  StoreFeatured,
  StoreFoot,
  StoreRows,
  StoreSkeleton,
  type StoreTab,
  useCatalogEntries,
} from "@/components/ConnectorCatalog";
import { DatabaseConnectFlow, type DatabaseFlowState } from "@/components/DatabaseConnect";
import { MailConnectFlow, type MailFlowState, mailChoices } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";

/**
 * The connectors store, a page of its own (`/connectors`, opened from Settings › Connectors): the suggestions as
 * features, a tab per category, search, and a line per service that opens its dialog (`?service=`), where it connects; a
 * service the store doesn't list connects by its address in the connect dialog. Who manages
 * connectors adds the team's by default, everyone else their own; the connect flow still asks "For whom". What is
 * connected is cared for in Settings › Connectors, where Settings at the top goes back.
 */
export function ConnectorStorePage({ service }: { service?: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const admin = can(org, "manage_connectors");
  const navigate = useNavigate();
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const servers = useCustomServers(org.id);
  const mailProviders = useMailProviders(org.id);
  const mailAccounts = useMailAccounts(org.id);
  const databases = useDatabases(org.id);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [mailFlow, setMailFlow] = useState<MailFlowState | null>(null);
  const [dbFlow, setDbFlow] = useState<DatabaseFlowState | null>(null);
  const [tab, setTab] = useState<StoreTab>("featured");
  const [q, setQ] = useState("");
  const defs = catalog.data?.connectors ?? [];
  const personal = !admin;
  // Connected, for the viewer: the team's for who adds the team's, else their own.
  const items = connectedItems(connections.data ?? [], servers.data ?? [], defs).filter((i) =>
    personal ? ownerScopeOf(i, me.user.id) === "mine" : !i.ownerUserId,
  );
  const boxes = (mailAccounts.data ?? []).filter((a) => ownerScopeOf(a, me.user.id) === "mine");
  const { entries, categories, composioOff } = useCatalogEntries({
    // GitHub connects for the team only.
    connectors: personal ? defs.filter((d) => personalAllowed(d.id)) : defs,
    connected: connectedIds(items),
    onPick: (def) => {
      // Connected already: a server by address takes another account, a catalog connector a new sign-in. GitHub
      // through the agentes.chat app alone has no sign-in: it offers the app on another account, or an account.
      const item = items.find((i) => i.def?.id === def.id);
      setFlow(
        item && !item.viaGithubApp
          ? { step: 0, def, mode: item.custom ? "add" : "reconnect", item }
          : { step: 0, def, personal },
      );
    },
    mail: {
      choices: mailChoices(mailProviders.data),
      connected: new Set(boxes.map(choiceOf)),
      onPick: (choice) => setMailFlow({ step: 0, choice }),
    },
    // Databases are the team's.
    database: admin
      ? { connected: (databases.data?.length ?? 0) > 0, onPick: () => setDbFlow({ step: 0 }) }
      : undefined,
  });
  const open = (key?: string) =>
    void navigate({ to: "/org/$orgId/connectors", params: { orgId: org.id }, search: key ? { service: key } : {} });
  const entry = service ? (entries.find((e) => e.key === service) ?? null) : null;
  // The dialog keeps the service it showed while it closes.
  const shown = useRef<CatalogEntry | null>(null);
  if (entry) shown.current = entry;
  const needle = q.trim();
  const found = needle ? matchEntries(t, entries, needle) : [];
  // Any service by its address: the connect dialog itself says what to paste.
  const other = () => setFlow({ step: 0, def: null, personal });
  const tabs: StoreTab[] = ["featured", ...categories];

  return (
    <div className="page store-wrap">
      <div className="store">
        <Link
          to="/org/$orgId/settings/$section"
          params={{ orgId: org.id, section: "connectors" }}
          className="store-back"
        >
          <Icon name="chevronLeft" size={16} />
          {t("settings.title")}
        </Link>
        <div className="store-top">
          <h1 className="store-title">{t("connectors.title")}</h1>
          <SearchField
            size="sm"
            className="store-search"
            aria-label={t("connectors.search")}
            placeholder={t("connectors.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ("")}
            clearLabel={t("filters.clearSearch")}
          />
        </div>
        <nav className="store-cats" aria-label={t("connectors.categories")}>
          {tabs.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={!needle && tab === c}
              onClick={() => {
                setQ("");
                setTab(c);
              }}
            >
              {c === "featured" ? t("connectors.store.featured") : t(`connectors.category.${c}`)}
            </button>
          ))}
        </nav>
        {needle ? (
          found.length > 0 ? (
            <StoreRows entries={found} onOpen={(e) => open(e.key)} />
          ) : (
            <StoreEmpty query={needle} onOther={other} />
          )
        ) : catalog.isLoading ? (
          <StoreSkeleton />
        ) : tab === "featured" ? (
          <>
            <StoreFeatured entries={entries} categories={categories} onOpen={(e) => open(e.key)} onCategory={setTab} />
            <StoreFoot onOther={other} composioOff={composioOff} />
          </>
        ) : entries.some((e) => e.category === tab) ? (
          <>
            <StoreRows entries={entries.filter((e) => e.category === tab)} onOpen={(e) => open(e.key)} />
            <StoreFoot onOther={other} />
          </>
        ) : (
          <StoreEmpty query="" onOther={other} />
        )}
        <ServiceDialog entry={entry ?? shown.current} open={entry !== null} onClose={() => open()} />
        <ConnectFlow flow={flow} onChange={setFlow} onClose={() => setFlow(null)} />
        <MailConnectFlow flow={mailFlow} onChange={setMailFlow} onClose={() => setMailFlow(null)} />
        <DatabaseConnectFlow flow={dbFlow} onChange={setDbFlow} onClose={() => setDbFlow(null)} />
      </div>
    </div>
  );
}
