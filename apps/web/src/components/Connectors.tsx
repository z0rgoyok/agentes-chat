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
  useServerDatabases,
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
  itemName,
  outcomeText,
  personalAllowed,
  reconnectAddsText,
} from "@agenteschat/client/lib/connected";
import { sameServer } from "@agenteschat/client/lib/custom-tools";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { appAccountsText, githubDisconnectNote, missingEventsText } from "@agenteschat/client/lib/github-app";
import { choiceOf, mailboxName, newestAccount } from "@agenteschat/client/lib/mail";
import { ownerScopeOf } from "@agenteschat/client/lib/owner-split";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorBrand } from "@agenteschat/client/lib/scopes";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  AvatarStack,
  Button,
  codeAndBold,
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
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectedRow } from "@/components/ConnectedRow";
import { ConnectFlow, type FlowState, HeaderNames } from "@/components/ConnectFlow";
import { ConnectedSkeleton, StoreBack, StoreBand, StoreFoot, useCatalogEntries } from "@/components/ConnectorCatalog";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import {
  DatabaseConnectFlow,
  DatabaseDisconnectDialog,
  type DatabaseFlowState,
  DatabaseIcon,
  DatabaseReconnectDialog,
  DatabaseScopeDialog,
} from "@/components/DatabaseConnect";
import { GitHubAppPanel, RemoveServerAppDialog, useCreateServerApp } from "@/components/GitHubAppPanel";
import {
  MailAddressesDialog,
  MailConnectFlow,
  MailDisconnectDialog,
  type MailFlowState,
  MailIcon,
  MailReconnectDialog,
  mailChoiceName,
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

/** One connection as the Connected tab and its page show it, whatever its kind (a service, a mailbox, a database). */
interface Linked {
  key: string;
  icon: ReactNode;
  name: string;
  /** Under the name: the account, how many tools. */
  sub: string[];
  /** What it needs from a person, and the button that settles it (`name`: the button's name for screen readers). */
  need: { text: string; label?: string; name?: string; run?: () => void } | null;
  /** Who uses it; null where agents don't use it (this server's GitHub app). */
  using: Agent[] | null;
  /** The viewer may change it (its own, or the team's for who manages connectors). */
  mayChange: boolean;
  /** Its page's lines: a title, what is set now and the button that changes it. */
  lines: { id: string; title: string; text: ReactNode; end?: ReactNode; action?: ReactNode }[];
  more: { id: string; icon: "edit" | "plus" | "members"; label: string; run: () => void }[];
  disconnect?: () => void;
  /** The page's last button, when it isn't "Disconnect {name}". */
  disconnectLabel?: string;
}

/**
 * Settings → Conectores: a line with a few services' marks and "Browse connectors" (the store, a page of its own:
 * `/connectors`), then what is connected, one line per connection whatever its kind (a service, an MCP server, a
 * mailbox, a database, this server's GitHub app). Only what needs a person shows a state, with the button that settles
 * it; a line opens its page (`?service=on:…`: who uses it, tools, account). Connecting runs the same 3-step flows.
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
  service,
}: {
  connected?: string;
  /** What the OAuth return did: `connected` (a new account), `reconnected` or `same_account`. */
  outcome?: string;
  review?: boolean;
  mail?: string;
  /** The mailbox Gmail/Outlook came back with. */
  account?: string;
  /** The connection whose page is open (`on:…`). */
  service?: string;
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
  const navigate = useNavigate();
  const openService = (key?: string) =>
    void navigate({
      to: "/org/$orgId/settings/$section",
      params: { orgId: org.id, section: "connectors" },
      search: key ? { service: key } : {},
    });
  const [flow, setFlow] = useState<FlowState | null>(null);
  const serverApp = useGitHubApp(org.id).data?.setup;
  const createApp = useCreateServerApp();
  const [removingApp, setRemovingApp] = useState(false);
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

  const loaded = connections.isSuccess && servers.isSuccess;
  const look = useRightHandLook();
  const [moving, setMoving] = useState<ConnectedItem | null>(null);
  const [takingOff, setTakingOff] = useState<ConnectedItem | null>(null);
  const othersCount = tabs.others.length + tabs.othersMail.length;
  // A row taken off or removed leaves the focus on the list's heading, not on the page.
  useFocusHome("conn-sec", ["connected-others", "sec-conn"]);

  // Who uses a connection, in words: the agents by name while they are few, else how many of the team.
  const whoText = (list: Agent[]) =>
    list.length === 0
      ? t("connectors.usedByNone")
      : list.length === agentList.length
        ? t("connectors.store.whoEvery", { count: list.length })
        : list.length <= 3
          ? t("connectors.store.whoSome", {
              names: new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(list.map((a) => a.name)),
              count: agentList.length - list.length,
            })
          : t("connectors.usedBy", { count: list.length, total: agentList.length });
  const faces = (list: Agent[]) =>
    list.length > 0 && (
      <AvatarStack>
        {list.slice(0, 3).map((a) => (
          <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="xs" />
        ))}
      </AvatarStack>
    );
  const act = (label: string, name: string, run: () => void) => (
    <Button size="sm" aria-label={name} onClick={run}>
      {label}
    </Button>
  );
  const whoLine = (list: Agent[], name: string, run: () => void) => ({
    id: "who",
    title: t("connectors.who"),
    text: whoText(list),
    end: faces(list),
    action: act(t("connectors.store.change"), t("connectors.whoName", { name }), run),
  });

  const fromItem = (item: ConnectedItem): Linked => {
    const acts = connectionActs(item, me.user.id, admin);
    const name = itemName(t, item);
    const list = using(item);
    const adds = item.needsReconnect ? null : reconnectAddsText(t, item);
    const signIn = () => setFlow({ step: 0, def: item.def, mode: "reconnect", item });
    const tools = () => setFlow({ step: 1, item });
    const account =
      item.viaGithubApp && item.account
        ? appAccountsText(t, item.account)
        : item.account
          ? t("connectors.connectedAs", { account: item.account })
          : null;
    const sent = item.server?.headerNames ?? [];
    const reconnectLabel = t("connectors.detail.reconnect");
    const reconnectName = t("connectors.reconnectName", { name });
    const reviewName = t("connectors.reviewName", { name });
    return {
      key: `on:${item.id}`,
      icon: <ConnectorIcon def={item.def} image={item.image} label={name} />,
      name,
      sub: [item.account, t("connectors.toolsCount", { count: item.tools })].filter((x): x is string => !!x),
      need: item.needsReconnect
        ? { text: t("connectors.composio.needsReconnect"), label: reconnectLabel, name: reconnectName, run: signIn }
        : adds
          ? { text: adds, label: reconnectLabel, name: reconnectName, run: signIn }
          : item.toolsError
            ? { text: t("connectors.noToolsNow") }
            : item.pending > 0 && item.server?.reviewedAt
              ? {
                  text: t("connectors.toReview", { count: item.pending }),
                  label: t("connectors.review"),
                  name: reviewName,
                  run: tools,
                }
              : item.needsReview
                ? { text: t("connectors.notReviewed"), label: t("connectors.review"), name: reviewName, run: tools }
                : null,
      using: list,
      mayChange: acts.change,
      lines: [
        whoLine(list, name, () => setFlow({ step: 2, item })),
        {
          id: "tools",
          title: t("connectors.tools"),
          text: t("connectors.toolsCount", { count: item.tools }),
          action: act(t("connectors.store.see"), t("connectors.toolsName", { name }), tools),
        },
        {
          id: "account",
          title: t("connectors.store.account"),
          text: (
            <>
              {[account, relativeTime(t, i18n.language, item.createdAt)].filter(Boolean).join(" · ")}
              {/* The request headers a server by address is also sent, by name: their values are never shown. */}
              {sent.length > 0 && (
                <>
                  <br />
                  <Trans i18nKey="connectors.sendsToo" components={{ names: <HeaderNames names={sent} /> }} />
                </>
              )}
            </>
          ),
          // GitHub through the app alone has no sign-in to renew: its accounts are on GitHub's side.
          action: item.viaGithubApp ? undefined : act(reconnectLabel, t("connectors.reconnectName", { name }), signIn),
        },
      ],
      more: [
        { id: "rename", icon: "edit" as const, label: t("connectors.rename"), run: () => setRenaming(item) },
        ...(item.custom
          ? [
              {
                id: "add",
                icon: "plus" as const,
                label: t("connectors.detail.addAccount"),
                run: () => setFlow({ step: 0, def: item.def, mode: "add", item }),
              },
            ]
          : []),
        ...(acts.moveToTeam
          ? [
              {
                id: "move",
                icon: "members" as const,
                label: t("connectors.personal.moveToTeam"),
                run: () => setMoving(item),
              },
            ]
          : []),
      ],
      disconnect: () => setRemoving(item),
    };
  };
  const fromMail = (box: (typeof accounts)[number]): Linked => {
    const name = box.address;
    const list = agentList.filter((a) => box.agents.some((x) => x.agentId === a.id));
    const signIn = () => reconnect(box);
    return {
      key: `on:mail-${box.id}`,
      icon: <MailIcon choice={choiceOf(box)} />,
      name: mailChoiceName(t, choiceOf(box)),
      sub: [box.address],
      need:
        box.status === "needs_reconnect"
          ? {
              text: t("mail.status.needs_reconnect"),
              label: t("mail.reconnect"),
              name: t("mail.reconnectName", { name }),
              run: signIn,
            }
          : box.status === "pending"
            ? { text: t("mail.status.pending") }
            : null,
      using: list,
      mayChange: connectionActs(box, me.user.id, admin).change,
      lines: [
        whoLine(list, name, () => setMailFlow({ step: 2, account: box })),
        {
          id: "tools",
          title: t("connectors.tools"),
          text: t("connectors.store.toolsText"),
          action: act(t("connectors.store.see"), t("connectors.toolsName", { name }), () =>
            setMailFlow({ step: 1, account: box }),
          ),
        },
        {
          id: "addresses",
          title: t("mail.addresses.button"),
          text: t("connectors.store.addressesText"),
          action: act(t("connectors.store.change"), t("mail.addresses.buttonName", { name }), () =>
            setAddressesOf(box),
          ),
        },
        {
          id: "account",
          title: t("connectors.store.account"),
          text: [
            t("connectors.connectedAs", { account: box.address }),
            relativeTime(t, i18n.language, box.createdAt),
          ].join(" · "),
          action: act(t("mail.reconnect"), t("mail.reconnectName", { name }), signIn),
        },
      ],
      more: [],
      disconnect: () => setRemovingMail(box),
      // Two mailboxes of one provider share its name: the address says which one goes.
      disconnectLabel: t("connectors.disconnectName", { name: box.address }),
    };
  };
  const fromDatabase = (db: DatabaseConnection): Linked => {
    const name = db.label;
    const list = agentList.filter((a) => db.agents.some((x) => x.agentId === a.id));
    const signIn = () => setReconnectingDb(db);
    const where = db.wholeServer ? `${db.username}@${db.host}` : `${db.username}@${db.host}/${db.database}`;
    return {
      key: `on:db-${db.id}`,
      icon: <DatabaseIcon />,
      name,
      sub: [t("database.readOnlyChip"), where],
      need:
        db.status === "needs_reconnect"
          ? {
              text: t("mail.status.needs_reconnect"),
              label: t("mail.reconnect"),
              name: t("mail.reconnectName", { name }),
              run: signIn,
            }
          : null,
      using: list,
      mayChange: admin,
      lines: [
        whoLine(list, name, () => setDbFlow({ step: 2, connection: db })),
        {
          id: "tools",
          title: t("connectors.tools"),
          text: t("connectors.store.toolsText"),
          action: act(t("connectors.store.see"), t("connectors.toolsName", { name }), () =>
            setDbFlow({ step: 1, connection: db }),
          ),
        },
        {
          id: "scope",
          title: t("database.scopeEdit"),
          text: db.wholeServer ? (
            <>
              <DatabaseCount connection={db} />
              {db.databasePrefix && ` · ${t("database.prefixRow", { prefix: db.databasePrefix })}`}
            </>
          ) : (
            db.database
          ),
          action: (
            <>
              {db.wholeServer && <DatabaseRefresh connection={db} />}
              {act(t("connectors.store.change"), t("database.scopeEditName", { name }), () => setScopingDb(db))}
            </>
          ),
        },
        {
          id: "account",
          title: t("connectors.store.account"),
          text: [t("connectors.connectedAs", { account: where }), relativeTime(t, i18n.language, db.createdAt)].join(
            " · ",
          ),
          action: act(t("mail.reconnect"), t("mail.reconnectName", { name }), signIn),
        },
      ],
      more: [],
      disconnect: () => setRemovingDb(db),
    };
  };
  // This server's GitHub app (its owner's, never on agentes.chat Cloud): to create while missing, then its own page.
  const fromServerApp = (setup: NonNullable<typeof serverApp>): Linked => {
    const name = t("githubApp.server.title");
    const events = missingEventsText(t, setup);
    const note =
      setup.source === "env"
        ? t("githubApp.server.line.env")
        : setup.state === "invalid"
          ? t("githubApp.server.line.invalid")
          : null;
    const outside = (href: string, label: string) => (
      <Button asChild size="sm">
        <a href={href} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={14} />
          {label}
        </a>
      </Button>
    );
    const create = (
      <Button
        size="sm"
        variant="primary"
        loading={createApp.pending}
        disabled={createApp.pending}
        onClick={createApp.run}
      >
        {t("githubApp.server.create")}
      </Button>
    );
    return {
      key: "on:github-app",
      icon: <ConnectorIcon def={defs.find((d) => d.id === "github") ?? null} label="GitHub" />,
      name,
      sub: [setup.canCreate ? t("githubApp.server.lead") : (setup.slug ?? "")].filter(Boolean),
      need: setup.canCreate
        ? { text: t("connectors.store.appMissing"), label: t("githubApp.server.create"), run: createApp.run }
        : setup.state === "invalid"
          ? { text: t("githubApp.server.state.invalid") }
          : events
            ? { text: t("connectors.store.appEvents") }
            : null,
      using: null,
      mayChange: true,
      lines: setup.canCreate
        ? [{ id: "app", title: t("connectors.store.appLine"), text: t("githubApp.server.without"), action: create }]
        : [
            {
              id: "app",
              title: t("connectors.store.appLine"),
              text: (
                <>
                  {setup.slug ?? name}
                  {note && (
                    <>
                      <br />
                      {codeAndBold(note)}
                    </>
                  )}
                </>
              ),
              action: setup.htmlUrl ? outside(setup.htmlUrl, t("githubApp.server.open")) : undefined,
            },
            ...(events
              ? [
                  {
                    id: "events",
                    title: t("connectors.store.eventsLine"),
                    text: events,
                    action: setup.events ? outside(setup.events.url, t("githubApp.server.events")) : undefined,
                  },
                ]
              : []),
          ],
      more: [],
      disconnect: setup.source === "settings" && !setup.canCreate ? () => setRemovingApp(true) : undefined,
      disconnectLabel: t("githubApp.server.remove"),
    };
  };
  // What needs a person first; the rest in the order they came.
  const first = (list: Linked[]) => [...list.filter((l) => l.need), ...list.filter((l) => !l.need)];
  const ownMail = personal ? accounts.map(fromMail) : [];
  const linked = [...listedMail.map(fromMail), ...dbList.map(fromDatabase), ...items.map(fromItem)];
  // Nothing connected yet shows the empty state; this server's GitHub app still lists under it.
  const noneYet = loaded && !mailAccounts.isLoading && !databases.isLoading && ownMail.length + linked.length === 0;
  const listed = first([...(serverApp && !personal ? [fromServerApp(serverApp)] : []), ...linked]);
  const everyLinked = [...ownMail, ...listed];

  // The store is a page of its own (Browse connectors); a service by its address connects in the dialog right here.
  const openStore = () => void navigate({ to: "/org/$orgId/connectors", params: { orgId: org.id } });
  const { entries } = useCatalogEntries({
    connectors: personal ? defs.filter((d) => personalAllowed(d.id)) : defs,
    connected: connectedIds(items),
    mail: { choices: mailChoices(mailProviders.data), connected: new Set(accounts.map(choiceOf)) },
    database: personal ? undefined : { connected: dbList.length > 0 },
  });
  // One skeleton until the list, the mailboxes, the databases and the catalog (the band's count) are all in.
  const loading = !loaded || mailAccounts.isLoading || databases.isLoading || catalog.isLoading;
  const current = service ? (everyLinked.find((l) => l.key === service) ?? null) : null;
  const back = () => openService();

  const linkedRow = (l: Linked) => (
    <li key={l.key} className="store-item store-item--link">
      <button type="button" className="store-item__open" onClick={() => openService(l.key)}>
        {l.icon}
        <span className="store-item__text">
          <b className="ac-captop">{l.name}</b>
          <small>
            {l.need && (
              <>
                <span className="store-state" data-s="wait">
                  {l.need.text}
                </span>
                {l.sub.length > 0 && " · "}
              </>
            )}
            {l.sub.join(" · ")}
          </small>
        </span>
      </button>
      {l.need?.run && l.mayChange ? (
        <Button size="sm" variant="primary" aria-label={l.need.name ?? l.need.label} onClick={l.need.run}>
          {l.need.label}
        </Button>
      ) : (
        l.using && (
          <span className="store-who">
            {faces(l.using)}
            {l.using.length > 0 ? t("connectors.store.agents", { count: l.using.length }) : t("connectors.usedByNone")}
          </span>
        )
      )}
      <Icon name="chevronRight" size={16} className="store-item__chev" />
    </li>
  );

  return (
    <div className="store" id="conn-sec">
      {current ? (
        <div className="store-page">
          <StoreBack onBack={back} />
          <div className="store-page__head">
            <span className="store-page__icon">{current.icon}</span>
            <div className="store-page__title">
              <h3>{current.name}</h3>
              <p>
                <span className="store-state" data-s={current.need ? "wait" : "ok"}>
                  {current.need ? current.need.text : t("connectors.store.connected")}
                </span>
                {current.sub.length > 0 && ` · ${current.sub.join(" · ")}`}
              </p>
            </div>
            {current.mayChange && current.more.length > 0 && (
              <Menu
                align="end"
                label={t("connectors.actionsName", { name: current.name })}
                trigger={
                  <Button
                    variant="ghost"
                    iconOnly
                    icon="more"
                    aria-label={t("connectors.actionsName", { name: current.name })}
                  />
                }
              >
                {current.more.map((m) => (
                  <MenuItem key={m.id} icon={m.icon} onSelect={m.run}>
                    {m.label}
                  </MenuItem>
                ))}
              </Menu>
            )}
          </div>
          {current.mayChange ? (
            <>
              <ul className="store-list store-list--lines">
                {current.lines.map((line) => (
                  <li key={line.id} className="store-item store-item--tall">
                    <span className="store-item__text">
                      <b>{line.title}</b>
                      <small>{line.text}</small>
                    </span>
                    {line.end && <span className="store-who">{line.end}</span>}
                    {line.action}
                  </li>
                ))}
              </ul>
              {current.disconnect && (
                <p className="store-foot">
                  <Button variant="link" className="store-danger" onClick={current.disconnect}>
                    {current.disconnectLabel ?? t("connectors.disconnectName", { name: current.name })}
                  </Button>
                </p>
              )}
            </>
          ) : (
            current.using && <p className="store-foot">{whoText(current.using)}</p>
          )}
        </div>
      ) : (
        <>
          {/* The split covers the band and the list, as the Vault's covers its whole list. */}
          {tabs.shown && loaded && (
            <OwnerTabs
              label={t("connectors.title")}
              value={scope}
              onValueChange={setPicked}
              team={tabs.team}
              personal={tabs.mine}
            />
          )}
          {composio.data && nearComposioLimit(composio.data) && (
            <p className="small muted">{composioUsageText(t, i18n.language, composio.data)}</p>
          )}
          {loading ? (
            <ConnectedSkeleton band={mayAdd} />
          ) : noneYet ? (
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
                  <Button variant="primary" onClick={() => openStore()}>
                    {t("connectors.store.browse")}
                  </Button>
                )
              }
            >
              {t(personal ? "connectors.personal.emptyText" : admin ? "connectors.none" : "access.noConnectorsViewer")}
            </EmptyState>
          ) : (
            mayAdd && <StoreBand entries={entries} onOpen={() => openStore()} />
          )}
          {!loading && ownMail.length > 0 && (
            <section className="store-sec" aria-labelledby="sec-own-mail">
              <div className="store-sec__head">
                <h3 id="sec-own-mail">{t("connectors.personal.mailTitle")}</h3>
              </div>
              <p className="small muted">{t("connectors.personal.mailNote")}</p>
              <ul className="store-list">{first(ownMail).map(linkedRow)}</ul>
            </section>
          )}
          {!loading && personal && items.length > 0 && (
            <p className="small muted ac-iconline connected-note">
              <Icon name="lock" size={14} />
              <span>{t("connectors.personal.note")}</span>
            </p>
          )}
          {!loading && listed.length > 0 && (
            <section className="store-sec" aria-labelledby="sec-conn">
              <div className="store-sec__head">
                <h3 id="sec-conn" tabIndex={-1}>
                  {t("connectors.connectedFilter")}
                </h3>
              </div>
              <ul className="store-list">{listed.map(linkedRow)}</ul>
            </section>
          )}
          {!loading && !personal && (
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
          {!loading && mayAdd && <StoreFoot onOther={() => setFlow({ step: 0, def: null, personal })} />}
        </>
      )}
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
        onClose={() => {
          // Its page is gone with it: back to the list.
          if (removing && service === `on:${removing.id}` && !everything.some((i) => i.id === removing.id)) back();
          setRemoving(null);
        }}
      />
      <RenameDialog item={renaming} onClose={() => setRenaming(null)} />
      <RemoveServerAppDialog open={removingApp} onClose={() => setRemovingApp(false)} />
      <MoveToTeamDialog item={moving} onClose={() => setMoving(null)} />
      <TakeOffDialog item={takingOff} agents={takingOff ? using(takingOff) : []} onClose={() => setTakingOff(null)} />
    </div>
  );
}

/** How many databases a whole-server connection reaches now. */
function DatabaseCount({ connection }: { connection: DatabaseConnection }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const servers = useServerDatabases(org.id, connection.id, connection.wholeServer);
  const count = servers.data?.length ?? connection.databaseCount;
  return <>{count !== null ? t("database.count", { count }) : connection.host}</>;
}

/** Reads a whole-server connection's databases again. */
function DatabaseRefresh({ connection }: { connection: DatabaseConnection }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const servers = useServerDatabases(org.id, connection.id, connection.wholeServer);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={t("database.refreshName", { name: connection.label })}
      disabled={servers.refresh.isPending}
      loading={servers.refresh.isPending}
      onClick={() => servers.refresh.mutate()}
    >
      {t("database.refresh")}
    </Button>
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
