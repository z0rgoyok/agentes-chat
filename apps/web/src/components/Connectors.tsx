import type { Agent, DatabaseConnection, MailAccount } from "@agenteschat/client";
import {
  keys,
  useAgents,
  useCatalog,
  useComposioUsage,
  useConnections,
  useCustomServerAction,
  useCustomServers,
  useDatabases,
  useDisconnect,
  useGitHubApp,
  useMailAccounts,
  useMailAction,
  useMailProviders,
  useMoveConnectionToTeam,
  useRenameConnection,
  useTakeConnectionOffAgent,
} from "@agenteschat/client";
import { levelIn } from "@agenteschat/client/lib/access-levels";
import { composioUsageText, nearComposioLimit } from "@agenteschat/client/lib/composio";
import {
  type ConnectedItem,
  connectedIds,
  connectedItems,
  connectionActs,
  connectionTabs,
  isMcpItem,
  itemName,
  outcomeText,
  personalAllowed,
  reconnectAddsText,
} from "@agenteschat/client/lib/connected";
import { sameServer } from "@agenteschat/client/lib/custom-tools";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { appAccountsText, githubDisconnectNote } from "@agenteschat/client/lib/github-app";
import { choiceOf, mailboxName, newestAccount } from "@agenteschat/client/lib/mail";
import { ownerScopeOf } from "@agenteschat/client/lib/owner-split";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorBrand } from "@agenteschat/client/lib/scopes";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  Input,
  List,
  Locked,
  Menu,
  MenuItem,
  MenuSeparator,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectedRow } from "@/components/ConnectedRow";
import { ConnectFlow, type FlowState, HeaderNames } from "@/components/ConnectFlow";
import { ConnectorCatalogDialog, ConnectorIcon } from "@/components/ConnectorCatalog";
import {
  DatabaseConnectFlow,
  DatabaseDisconnectDialog,
  type DatabaseFlowState,
  DatabaseReconnectDialog,
  DatabaseRow,
  DatabaseScopeDialog,
} from "@/components/DatabaseConnect";
import { GitHubAppPanel, GitHubAppServerCard } from "@/components/GitHubAppPanel";
import { LoadingList } from "@/components/Loading";
import {
  MailAddressesDialog,
  MailConnectFlow,
  MailDisconnectDialog,
  type MailFlowState,
  MailIcon,
  MailReconnectDialog,
  MailRow,
  mailChoices,
} from "@/components/MailConnect";
import { type OwnerTab, OwnerTabs, PersonalOf } from "@/components/OwnerScope";
import { useOrg } from "@/components/org-context";
import { useAgentsAccess } from "@/hooks/useAgentsAccess";
import { useDirectory } from "@/hooks/useDirectory";
import { useFocusHome } from "@/hooks/useFocusHome";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { takesConnectorReturn } from "@/lib/desktop";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/**
 * Settings → Conectores: what the organization connected, one row per
 * service whatever its kind (state, account, who uses it), "Adicionar
 * conector" (the catalog) and the 3-step connect flow.
 *
 * Back from OAuth: `?connected=github` (or `custom:{id}`) and `?outcome` say what
 * came in; a new account reopens the flow at "O que faz" for it (a numbered one
 * asks its name there first); `?review=1` (older returns) opens the newest
 * server waiting for review. Back from Gmail/Outlook:
 * `?mail=connected&account={id}` opens "O que faz" for that mailbox (older
 * returns without `account`: the newest); `?mail=failed` says it didn't work.
 * Each flow ends on who can use it. Mailboxes (ADR 0038) are rows of the same list.
 *
 * Where the workspace has more than one person (or personal connections exist), "Equipe | Pessoal" splits the lists as
 * the Vault does (ADR 0099 addendum): the team's, and the viewer's own, which any member adds. A mailbox is always its
 * person's. Who manages connectors also sees other people's personal ones under the team's, without their details,
 * and may only remove them or take them off an agent.
 */
export function ConnectorsSection({
  connected,
  outcome,
  review,
  mail,
  account,
}: {
  connected?: string;
  /** What the OAuth return did: `connected` (a new account), `reconnected` or `same_account`. */
  outcome?: string;
  review?: boolean;
  mail?: string;
  /** The mailbox Gmail/Outlook came back with. */
  account?: string;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const admin = can(org, "manage_connectors");
  const catalog = useCatalog();
  // Who manages connectors also gets other people's personal ones, as bare rows.
  const others = { others: admin };
  const connections = useConnections(org.id, true, others);
  const servers = useCustomServers(org.id, true, others);
  const members = useDirectory(org.id).members.length;
  const [picked, setPicked] = useState<OwnerTab | null>(null);
  const agents = useAgents(org.id);
  const composio = useComposioUsage(org.id);
  const [adding, setAdding] = useState(false);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [removing, setRemoving] = useState<ConnectedItem | null>(null);
  const [renaming, setRenaming] = useState<ConnectedItem | null>(null);
  const toast = useToast();
  const mailProviders = useMailProviders(org.id);
  const mailAccounts = useMailAccounts(org.id, true, others);
  const { connectComposio } = useMailAction(org.id);
  const [mailFlow, setMailFlow] = useState<MailFlowState | null>(null);
  const [reconnecting, setReconnecting] = useState<MailAccount | null>(null);
  const [addressesOf, setAddressesOf] = useState<MailAccount | null>(null);
  const [removingMail, setRemovingMail] = useState<MailAccount | null>(null);
  // People's Postgres databases (ADR 0039): rows of the same list, the same kind of flow.
  const databases = useDatabases(org.id);
  const [dbFlow, setDbFlow] = useState<DatabaseFlowState | null>(null);
  const [reconnectingDb, setReconnectingDb] = useState<DatabaseConnection | null>(null);
  const [scopingDb, setScopingDb] = useState<DatabaseConnection | null>(null);
  const [removingDb, setRemovingDb] = useState<DatabaseConnection | null>(null);
  const reconnect = (account: MailAccount) => {
    // Gmail/Outlook sign in again on the provider's page; the rest take a new app password or API key.
    if (account.via === "composio" && (account.provider === "gmail" || account.provider === "outlook")) {
      connectComposio.mutate(
        { provider: account.provider, accountId: account.id, desktop: takesConnectorReturn() },
        { onSuccess: (started) => navigateAway(started.redirectUrl) },
      );
    } else setReconnecting(account);
  };
  // Back from Gmail/Outlook: "O que faz" for the mailbox that came in, or why it didn't.
  const mailReturned = useRef(false);
  useEffect(() => {
    if (mailReturned.current || !mail) return;
    if (mail === "connected" && !mailAccounts.data && !mailAccounts.isError) return;
    mailReturned.current = true;
    const list = (mailAccounts.data ?? []).filter((a) => ownerScopeOf(a, me.user.id) !== "others");
    // Another mailbox may be newer (one started and left on the provider's page): the one that came back, by its id.
    const came = mail !== "connected" ? null : account ? list.find((a) => a.id === account) : newestAccount(list);
    if (came) {
      toast.show(t("mail.returned"));
      if (came.ownerUserId === me.user.id) setPicked("personal");
      setMailFlow({ step: 1, account: came });
    } else if (mail !== "connected") toast.show(t("mail.failed"), "error");
    window.history.replaceState(null, "", window.location.pathname);
  }, [mail, account, mailAccounts.data, mailAccounts.isError, me.user.id, t, toast]);
  const defs = catalog.data?.connectors ?? [];
  const everything = connectedItems(connections.data ?? [], servers.data ?? [], defs);
  const tabs = connectionTabs({
    items: everything,
    mailboxes: mailAccounts.data ?? [],
    me: me.user.id,
    members,
    manages: admin,
    picked,
    databases: databases.data?.length ?? 0,
  });
  const scope = tabs.tab;
  const personal = scope === "personal";
  const { items, mailboxes: accounts } = tabs;
  // On Pessoal a person's mailboxes are a group of their own: they keep their own rule (ADR 0038), not the note's.
  const listedMail = personal ? [] : accounts;
  // Databases are the team's.
  const dbList = personal ? [] : (databases.data ?? []);
  const mayAdd = admin || personal;
  const apps = items.filter((i) => !isMcpItem(i));
  const mcps = items.filter(isMcpItem);
  const agentList = agents.data ?? [];
  const access = useAgentsAccess(agentList, everything.length > 0);
  const using = (item: ConnectedItem) =>
    ownerScopeOf(item, me.user.id) === "others"
      ? agentList.filter((a) => item.agentIds.includes(a.id))
      : agentList.filter((a) => levelIn(access.byAgent.get(a.id), `connector:${item.id}`) !== "none");

  // Back from OAuth: the confirmation for the connection that just came in.
  const returned = useRef(false);
  const listsFetching = connections.isFetching || servers.isFetching;
  useEffect(() => {
    if (returned.current || (!connected && !review) || !connections.data || !servers.data || !catalog.data) return;
    // The desktop app's window comes back without a reload: the lists cached from before the sign-in don't have
    // the new connection until they are read again.
    if (listsFetching) return;
    returned.current = true;
    const all = connectedItems(connections.data, servers.data, catalog.data.connectors).filter(
      (i) => ownerScopeOf(i, me.user.id) !== "others",
    );
    const latest = (list: ConnectedItem[]) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const item = connected?.startsWith("custom:")
      ? all.find((i) => i.custom && i.id === connected.slice("custom:".length))
      : connected
        ? latest(all.filter((i) => !i.custom && i.def?.id === connected))
        : latest(all.filter((i) => i.custom && i.needsReview));
    const done = outcome === "reconnected" || outcome === "same_account" ? outcome : "connected";
    // Signing in elsewhere ends here: say what happened, as connecting with a key does (a toast, or the confirmation).
    const confirms = Boolean(item && connectionActs(item, me.user.id, admin).change) && done === "connected";
    if (item?.ownerUserId) setPicked("personal");
    if (item && connected && !confirms) toast.show(outcomeText(t, done, item));
    // Only a new account gets the confirmation; "Ajustar" there names another account its provider didn't name.
    const url = item?.server?.serverUrl;
    const naming =
      Boolean(url && !item?.server?.accountLabel) &&
      all.filter((i) => i.server && url && sameServer(i.server.serverUrl, url)).length > 1;
    if (item && confirms) setFlow({ step: "done", item, naming });
    // GitHub comes straight back when nothing is left to ask: the dialog says what it reaches now and where to add more.
    if (item?.def?.id === "github" && admin && done === "reconnected")
      setFlow({ step: 0, def: item.def, mode: "reconnect", item });
    window.history.replaceState(null, "", window.location.pathname);
  }, [
    connected,
    outcome,
    review,
    connections.data,
    servers.data,
    catalog.data,
    listsFetching,
    admin,
    me.user.id,
    t,
    toast,
  ]);

  const row = (item: ConnectedItem) => (
    <ServiceRow
      key={item.id}
      item={item}
      using={using(item)}
      total={agentList.length}
      acts={connectionActs(item, me.user.id, admin)}
      onTools={() => setFlow({ step: 1, item })}
      onWho={() => setFlow({ step: 2, item })}
      onRename={() => setRenaming(item)}
      onReconnect={() => setFlow({ step: 0, def: item.def, mode: "reconnect", item })}
      onAddAccount={() => setFlow({ step: 0, def: item.def, mode: "add", item })}
      onDisconnect={() => setRemoving(item)}
      onMove={() => setMoving(item)}
    />
  );
  const mailRow = (account: (typeof accounts)[number]) => (
    <MailRow
      key={`mail-${account.id}`}
      account={account}
      agents={agentList}
      admin={connectionActs(account, me.user.id, admin).change}
      onTools={() => setMailFlow({ step: 1, account })}
      onWho={() => setMailFlow({ step: 2, account })}
      onAddresses={() => setAddressesOf(account)}
      onReconnect={() => reconnect(account)}
      onDisconnect={() => setRemovingMail(account)}
    />
  );
  const loaded = connections.isSuccess && servers.isSuccess;
  // Pessoal is one list across both cards: its empty state shows only when nothing at all is there.
  const noneYet =
    loaded &&
    !mailAccounts.isLoading &&
    !databases.isLoading &&
    (personal ? items.length : apps.length) === 0 &&
    accounts.length === 0 &&
    dbList.length === 0;
  const look = useRightHandLook();
  const [moving, setMoving] = useState<ConnectedItem | null>(null);
  const [takingOff, setTakingOff] = useState<ConnectedItem | null>(null);
  const othersCount = tabs.others.length + tabs.othersMail.length;
  // A row taken off or removed leaves the focus on the list's heading, not on the page.
  useFocusHome("conn-sec", ["connected-others", "sec-conn"]);

  return (
    <>
      {/* The split covers both cards below, as the Vault's covers its whole list. */}
      {tabs.shown && loaded && (
        <OwnerTabs
          label={t("connectors.title")}
          value={scope}
          onValueChange={setPicked}
          team={tabs.team}
          personal={tabs.mine}
        />
      )}
      {personal && accounts.length > 0 && (
        <Card aria-labelledby="sec-own-mail">
          <CardHeader id="sec-own-mail" icon="mail" title={t("connectors.personal.mailTitle")} />
          <p className="small muted">{t("connectors.personal.mailNote")}</p>
          <List className="connected-list" aria-label={t("connectors.personal.mailTitle")}>
            {accounts.map(mailRow)}
          </List>
        </Card>
      )}
      {personal && items.length > 0 && (
        <p className="small muted ac-iconline connected-note">
          <Icon name="lock" size={14} />
          <span>{t("connectors.personal.note")}</span>
        </p>
      )}
      <Card id="conn-sec" aria-labelledby="sec-conn">
        <CardHeader
          id="sec-conn"
          icon="plug"
          title={t("connectors.title")}
          action={
            // The empty state takes over this button: one way in, in the middle of the card.
            mayAdd &&
            !noneYet && (
              <Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>
                {t("connectors.add")}
              </Button>
            )
          }
        />
        {composio.data && nearComposioLimit(composio.data) && (
          <p className="small muted">{composioUsageText(t, i18n.language, composio.data)}</p>
        )}
        {(connections.isLoading || servers.isLoading) && <LoadingList count={2} trailing />}
        {noneYet && (
          <EmptyState
            size="panel"
            agent={look}
            title={t(
              personal
                ? "connectors.personal.emptyTitle"
                : admin
                  ? modeKey(org, "connectors.noneTitle")
                  : "access.noConnectorsViewerTitle",
            )}
            actions={
              mayAdd && (
                <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
                  {t("connectors.add")}
                </Button>
              )
            }
          >
            {t(personal ? "connectors.personal.emptyText" : admin ? "connectors.none" : "access.noConnectorsViewer")}
          </EmptyState>
        )}
        {personal && loaded && !noneYet && apps.length === 0 && (
          <p className="small muted">{t("connectors.personal.noApps")}</p>
        )}
        {apps.length + listedMail.length + dbList.length > 0 && (
          <List className="connected-list" aria-label={t("connectors.connectedList")}>
            {listedMail.map(mailRow)}
            {dbList.map((connection) => (
              <DatabaseRow
                key={`db-${connection.id}`}
                connection={connection}
                agents={agentList}
                admin={admin}
                onTools={() => setDbFlow({ step: 1, connection })}
                onWho={() => setDbFlow({ step: 2, connection })}
                onReconnect={() => setReconnectingDb(connection)}
                onScope={() => setScopingDb(connection)}
                onDisconnect={() => setRemovingDb(connection)}
              />
            ))}
            {apps.map(row)}
          </List>
        )}
        {!personal && (
          <GitHubAppPanel
            onConnectAccount={() => {
              const github = defs.find((d) => d.id === "github");
              if (github) setFlow({ step: 0, def: github, account: true });
            }}
          />
        )}
        {admin && !personal && othersCount > 0 && (
          <OthersPersonal
            items={tabs.others}
            mail={tabs.othersMail}
            agents={agentList}
            onRemove={setRemoving}
            onRemoveMail={setRemovingMail}
            onTakeOff={setTakingOff}
          />
        )}
      </Card>
      <GitHubAppServerCard />
      <Card aria-labelledby="sec-mcp">
        <CardHeader
          id="sec-mcp"
          icon="code"
          title={t("connectors.mcp.title")}
          action={
            // The page's one primary is Add connector above; a server by address is the second way in.
            mayAdd && (
              <Button size="sm" icon="plus" onClick={() => setFlow({ step: 0, def: null, personal })}>
                {t("connectors.mcp.add")}
              </Button>
            )
          }
        />
        {loaded && mcps.length === 0 && !(personal && noneYet) && (
          <p className="small muted">{t("connectors.mcp.none")}</p>
        )}
        {mcps.length > 0 && (
          <List className="connected-list" aria-label={t("connectors.mcp.list")}>
            {mcps.map(row)}
          </List>
        )}

        <ConnectorCatalogDialog
          open={adding}
          onOpenChange={setAdding}
          // GitHub connects for the team only: not offered on Pessoal.
          connectors={personal ? defs.filter((d) => personalAllowed(d.id)) : defs}
          connected={connectedIds(items)}
          loading={catalog.isLoading}
          onPick={(def) => {
            setAdding(false);
            // Connected already: a server by address takes another account, a catalog connector a new sign-in. GitHub
            // through the agentes.chat app alone has no sign-in: it offers the app on another account, or an account.
            const item = items.find((i) => i.def?.id === def.id);
            setFlow(
              item && !item.viaGithubApp
                ? { step: 0, def, mode: item.custom ? "add" : "reconnect", item }
                : { step: 0, def, personal },
            );
          }}
          onOther={() => {
            setAdding(false);
            setFlow({ step: 0, def: null, personal });
          }}
          mail={{
            choices: mailChoices(mailProviders.data),
            connected: new Set(accounts.map(choiceOf)),
            onPick: (choice) => {
              setAdding(false);
              // A mailbox is its person's: it shows under Pessoal.
              if (tabs.shown) setPicked("personal");
              setMailFlow({ step: 0, choice });
            },
          }}
          database={
            personal
              ? undefined
              : {
                  connected: dbList.length > 0,
                  onPick: () => {
                    setAdding(false);
                    setDbFlow({ step: 0 });
                  },
                }
          }
        />
        <ConnectFlow flow={flow} onChange={setFlow} onClose={() => setFlow(null)} />
        <MailConnectFlow flow={mailFlow} onChange={setMailFlow} onClose={() => setMailFlow(null)} />
        <MailReconnectDialog account={reconnecting} onClose={() => setReconnecting(null)} />
        <MailAddressesDialog account={addressesOf} onClose={() => setAddressesOf(null)} />
        <MailDisconnectDialog account={removingMail} onClose={() => setRemovingMail(null)} />
        <DatabaseConnectFlow flow={dbFlow} onChange={setDbFlow} onClose={() => setDbFlow(null)} />
        <DatabaseReconnectDialog connection={reconnectingDb} onClose={() => setReconnectingDb(null)} />
        <DatabaseScopeDialog connection={scopingDb} onClose={() => setScopingDb(null)} />
        <DatabaseDisconnectDialog connection={removingDb} onClose={() => setRemovingDb(null)} />
        <DisconnectDialog
          item={removing}
          using={removing ? using(removing).length : 0}
          onClose={() => setRemoving(null)}
        />
        <RenameDialog item={renaming} onClose={() => setRenaming(null)} />
        <MoveToTeamDialog item={moving} onClose={() => setMoving(null)} />
        <TakeOffDialog item={takingOff} agents={takingOff ? using(takingOff) : []} onClose={() => setTakingOff(null)} />
      </Card>
    </>
  );
}

/**
 * One connected account: on its line the icon, name, state and who uses it; inside, the account and what you can do
 * (Quem usa, Ferramentas, and in ⋯ Renomear, Reconectar, another account of an MCP server, Desconectar).
 */
function ServiceRow({
  item,
  using,
  total,
  acts,
  onTools,
  onWho,
  onRename,
  onReconnect,
  onAddAccount,
  onDisconnect,
  onMove,
}: {
  item: ConnectedItem;
  using: Agent[];
  total: number;
  /** What the viewer may do with it (`connectionActs`). */
  acts: ReturnType<typeof connectionActs>;
  onTools: () => void;
  onWho: () => void;
  onRename: () => void;
  onReconnect: () => void;
  onAddAccount: () => void;
  onDisconnect: () => void;
  onMove: () => void;
}) {
  const { t, i18n } = useTranslation();
  const meta = [
    item.viaGithubApp && item.account
      ? appAccountsText(t, item.account)
      : item.account
        ? t("connectors.connectedAs", { account: item.account })
        : null,
    relativeTime(t, i18n.language, item.createdAt),
    t("connectors.toolsCount", { count: item.tools }),
  ].filter(Boolean);
  const adds = reconnectAddsText(t, item);
  const name = itemName(t, item);
  const sent = item.server?.headerNames ?? [];
  return (
    <ConnectedRow
      icon={<ConnectorIcon def={item.def} image={item.image} label={name} />}
      name={name}
      chips={
        item.needsReconnect ? (
          <Chip icon="alert" tone="waiting">
            {t("connectors.composio.needsReconnect")}
          </Chip>
        ) : item.toolsError ? (
          <Chip icon="alert" tone="waiting">
            {t("connectors.noToolsNow")}
          </Chip>
        ) : item.pending > 0 && item.server?.reviewedAt ? (
          <Chip icon="waiting" tone="waiting">
            {t("connectors.toReview", { count: item.pending })}
          </Chip>
        ) : item.needsReview ? (
          <Chip icon="waiting" tone="waiting">
            {t("connectors.notReviewed")}
          </Chip>
        ) : (
          <Chip icon="check" tone="done">
            {t("connectors.active")}
          </Chip>
        )
      }
      using={using}
      total={total}
      details={[
        meta.join(" · "),
        // The request headers a server by address is also sent, by name: their values are never shown.
        sent.length > 0 && <Trans i18nKey="connectors.sendsToo" components={{ names: <HeaderNames names={sent} /> }} />,
        !item.needsReconnect && adds,
      ]}
      actions={
        acts.change && (
          <>
            {(item.needsReconnect || adds) && (
              <Button
                size="sm"
                variant="primary"
                aria-label={t("connectors.reconnectName", { name })}
                onClick={onReconnect}
              >
                {t("connectors.detail.reconnect")}
              </Button>
            )}
            {item.needsReview && !item.needsReconnect && !adds && (
              <Button size="sm" variant="primary" aria-label={t("connectors.reviewName", { name })} onClick={onTools}>
                {t("connectors.review")}
              </Button>
            )}
            <Button variant="link" aria-label={t("connectors.whoName", { name })} onClick={onWho}>
              {t("connectors.who")}
            </Button>
            <Button variant="link" aria-label={t("connectors.toolsName", { name })} onClick={onTools}>
              {t("connectors.tools")}
            </Button>
            <Menu
              align="end"
              label={t("connectors.actionsName", { name })}
              trigger={
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="more"
                  aria-label={t("connectors.actionsName", { name })}
                />
              }
            >
              <MenuItem icon="edit" onSelect={onRename}>
                {t("connectors.rename")}
              </MenuItem>
              {/* GitHub through the app alone has no sign-in to renew: its accounts are on GitHub's side. */}
              {!item.viaGithubApp && (
                <MenuItem icon="refresh" onSelect={onReconnect}>
                  {t("connectors.detail.reconnect")}
                </MenuItem>
              )}
              {item.custom && (
                <MenuItem icon="plus" onSelect={onAddAccount}>
                  {t("connectors.detail.addAccount")}
                </MenuItem>
              )}
              {acts.moveToTeam && (
                <MenuItem icon="members" onSelect={onMove}>
                  {t("connectors.personal.moveToTeam")}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem icon="power" danger onSelect={onDisconnect}>
                {t("connectors.disconnect")}
              </MenuItem>
            </Menu>
          </>
        )
      }
    />
  );
}

/** "Renomear": the account's name, which people and agents tell it apart by (its tools keep their names). */
function RenameDialog({ item, onClose }: { item: ConnectedItem | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const rename = useRenameConnection(org.id);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const name = item ? itemName(t, item) : "";
  useEffect(() => {
    setLabel(item?.label ?? "");
    setError(null);
  }, [item]);
  const submit = () => {
    if (!item) return;
    const wanted = label.trim();
    if (!wanted || wanted === item.label) return onClose();
    rename.mutate(
      { id: item.id, label: wanted },
      {
        onSuccess: (saved) => {
          toast.show(t("connectors.renamed", { name: saved.label }));
          onClose();
        },
        onError: (failed) => setError(errorText(t, failed, i18n.language)),
      },
    );
  };
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("connectors.renameTitle", { name })}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Locked when={rename.isPending}>
          <DialogBody>
            <Field
              label={t("connectFlow.name")}
              id="connector-rename"
              hint={{ name: t("common.about", { label: t("connectFlow.name") }), text: t("connectors.renameHelp") }}
              error={error ?? undefined}
            >
              <Input
                value={label}
                maxLength={80}
                autoFocus
                onChange={(e) => {
                  setLabel(e.target.value);
                  setError(null);
                }}
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={rename.isPending} loading={rename.isPending}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * "Desconectar Linear?": always confirmed, whatever the kind. Someone else's personal connection reads "Remover", as
 * its row does.
 */
function DisconnectDialog({
  item,
  using,
  onClose,
}: {
  item: ConnectedItem | null;
  using: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const theirs = item ? ownerScopeOf(item, me.user.id) === "others" : false;
  const catalogDisconnect = useDisconnect(org.id);
  const { disconnect: customDisconnect } = useCustomServerAction(org.id);
  const pending = catalogDisconnect.isPending || customDisconnect.isPending;
  const name = item ? itemName(t, item) : "";
  // GitHub and the agentes.chat app: the app alone is uninstalled with it, an account goes and the app stays.
  const installations = useGitHubApp(org.id, item?.def?.id === "github").data?.installations ?? [];
  const githubNote = item ? githubDisconnectNote(t, item, installations) : null;
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t(theirs ? "connectors.personal.removeTitle" : "connectors.disconnectTitle", { name })}
      description={using > 0 ? t("connectors.disconnectText", { count: using }) : t("connectors.disconnectTextNone")}
      closeLabel={t("common.close")}
      width={440}
    >
      {item?.viaComposio && (
        <DialogBody>
          <p className="small muted">
            {t("connectors.composio.disconnectNote", { name: item.def ? connectorBrand(item.def) : name })}
          </p>
        </DialogBody>
      )}
      {githubNote && (
        <DialogBody>
          <p className="small muted">{githubNote}</p>
        </DialogBody>
      )}
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          disabled={pending}
          loading={pending}
          onClick={() => {
            if (!item) return;
            const done = {
              onSuccess: () => {
                // Agents lose the connection's grants.
                void qc.invalidateQueries({ queryKey: keys.access(org.id) });
                toast.show(
                  githubNote && !item.viaGithubApp ? t("githubApp.keptApp") : t("connectors.disconnected", { name }),
                );
                onClose();
              },
            };
            if (item.custom) customDisconnect.mutate(item.id, done);
            else catalogDisconnect.mutate(item.id, done);
          }}
        >
          {t(theirs ? "connectors.personal.remove" : "connectors.disconnect")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Other people's personal connections and mailboxes, for who manages connectors: what it is, whose it is and which
 * agents hold it, never its account, tools or settings. Only Remover and Tirar de um agente.
 */
function OthersPersonal({
  items,
  mail,
  agents,
  onRemove,
  onRemoveMail,
  onTakeOff,
}: {
  items: ConnectedItem[];
  mail: MailAccount[];
  agents: Agent[];
  onRemove: (item: ConnectedItem) => void;
  onRemoveMail: (account: MailAccount) => void;
  onTakeOff: (item: ConnectedItem) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  // A quiet group under the team's list: a few rows, the rest behind "Ver todas".
  const [all, setAll] = useState(false);
  const ownerOf = (id: string | null | undefined) => (id && dir.memberById.get(id)?.name) || t("channel.unknownPerson");
  const row = (
    key: string,
    icon: ReactNode,
    name: string,
    owner: string | null | undefined,
    using: Agent[],
    remove: () => void,
    takeOff?: () => void,
  ) => (
    <ConnectedRow
      key={key}
      icon={icon}
      name={name}
      chips={null}
      meta={
        <>
          <Icon name="lock" size={14} />
          <PersonalOf name={ownerOf(owner)} />
        </>
      }
      using={using}
      total={agents.length}
      details={[]}
      actions={
        <>
          {takeOff && using.length > 0 && (
            <Button variant="link" onClick={takeOff}>
              {t("connectors.personal.takeOff")}
            </Button>
          )}
          <Button variant="link" aria-label={t("connectors.personal.removeName", { name })} onClick={remove}>
            {t("connectors.personal.remove")}
          </Button>
        </>
      }
    />
  );
  const total = items.length + mail.length;
  const rows = [
    ...mail.map((account) =>
      row(
        `mail-${account.id}`,
        <MailIcon choice={choiceOf(account)} />,
        mailboxName(t, account),
        account.ownerUserId,
        agents.filter((a) => account.agents.some((x) => x.agentId === a.id)),
        () => onRemoveMail(account),
      ),
    ),
    ...items.map((item) => {
      const name = itemName(t, item);
      return row(
        item.id,
        <ConnectorIcon def={item.def} image={item.image} label={name} />,
        name,
        item.ownerUserId,
        agents.filter((a) => item.agentIds.includes(a.id)),
        () => onRemove(item),
        () => onTakeOff(item),
      );
    }),
  ];
  return (
    <section className="connected-others" aria-labelledby="connected-others">
      <h3 id="connected-others" className="ac-eyebrow">
        {t("connectors.personal.others")} · <span className="tabular">{total}</span>
      </h3>
      <List className="connected-list" aria-labelledby="connected-others">
        {all ? rows : rows.slice(0, OTHERS_INLINE)}
      </List>
      {total > OTHERS_INLINE && (
        <Button variant="link" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t("folded.less") : t("connectors.personal.seeAll", { count: total })}
        </Button>
      )}
    </section>
  );
}

/** How many of other people's personal connections show before "Ver todas". */
const OTHERS_INLINE = 5;

/** "Tirar de um agente": the agents that hold someone else's personal connection, each with Tirar. */
function TakeOffDialog({
  item,
  agents,
  onClose,
}: {
  item: ConnectedItem | null;
  agents: Agent[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const takeOff = useTakeConnectionOffAgent(org.id);
  const name = item ? itemName(t, item) : "";
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("connectors.personal.takeOffTitle", { name })}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>
        <ul className="connected-takeoff">
          {agents.map((a) => (
            <li key={a.id} className="connected-takeoff__row">
              <AgentAvatar agentId={a.id} name={a.name} size="sm" />
              <span className="connected-takeoff__name">{a.name}</span>
              <Button
                size="sm"
                aria-label={t("connectors.personal.takeOffName", { name, agent: a.name })}
                disabled={takeOff.isPending}
                loading={takeOff.isPending && takeOff.variables?.agentId === a.id}
                onClick={() =>
                  item &&
                  takeOff.mutate(
                    { connectionId: item.id, agentId: a.id },
                    {
                      onSuccess: () => {
                        toast.show(t("connectors.personal.takenOff", { name, agent: a.name }));
                        if (agents.length <= 1) onClose();
                      },
                      onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
                    },
                  )
                }
              >
                {t("connectors.personal.takeOffOne")}
              </Button>
            </li>
          ))}
        </ul>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** "Passar para a equipe": the person's own connection becomes the team's, which every member sees. */
function MoveToTeamDialog({ item, onClose }: { item: ConnectedItem | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const move = useMoveConnectionToTeam(org.id);
  const name = item ? itemName(t, item) : "";
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("connectors.personal.moveTitle", { name })}
      description={t("connectors.personal.moveText")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button disabled={move.isPending} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={move.isPending}
          loading={move.isPending}
          onClick={() =>
            item &&
            move.mutate(item.id, {
              onSuccess: () => {
                toast.show(t("connectors.personal.moved", { name }));
                onClose();
              },
              onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
            })
          }
        >
          {t("connectors.personal.moveToTeam")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
