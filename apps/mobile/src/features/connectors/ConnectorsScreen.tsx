import {
  type ConnectorDef,
  type MailAccount,
  useCatalog,
  useComposioUsage,
  useConnections,
  useCustomServerAction,
  useCustomServers,
  useDisconnect,
  useMailAccounts,
  useMailAction,
  useMembers,
  useTakeConnectionOffAgent,
} from "@agenteschat/client";
import { composioOffText, composioUsageText, nearComposioLimit } from "@agenteschat/client/lib/composio";
import {
  type ConnectedItem,
  connectedItems,
  connectionActs,
  isMcpItem,
  itemName,
  personalAllowed,
  personalOfText,
} from "@agenteschat/client/lib/connected";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { choiceOf, MAIL_BRANDS, mailboxName } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorDescription, connectorName } from "@agenteschat/client/lib/scopes";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, useWindowDimensions, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  CodeWords,
  Disclosure,
  EmptyState,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Locked,
  PressScale,
  RowPressable,
  SearchField,
  SectionHeader,
  Segmented,
  SideScroll,
  SkeletonList,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { chooseAction, confirmAction } from "../settings/parts";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useErrorToast, useMeId, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useSurface } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { openConnection } from "./ConnectionScreen";
import { ConnectorIcon } from "./ConnectorIcon";
import { AddressSheet, ConnectSheet, ServerSheet } from "./ConnectSheet";
import { FeaturedCards } from "./FeaturedCards";
import {
  type ConnectionTab,
  catalogShelves,
  connectionTabs,
  galleryTiles,
  isHttpsUrl,
  SHELF_ROWS,
  type Shelf,
  SUGGESTED,
  searchConnectors,
  shelfColumns,
  shownMailboxes,
  suggestionsOf,
} from "./logic";
import { MailboxSheet } from "./MailboxSheet";
import { openTools } from "./ToolsScreen";

/** A catalog row's mark; the text column starts after it, where its hairline does. */
const LOCKUP_MARK = 44;
const LOCKUP_GAP = 12;
/** A connected row's mark, the grouped list's leading size. */
const ROW_MARK = 30;
/** The featured cards at the top: the suggested services that open here, not connected yet (`suggestionsOf`). */
const FEATURED = 6;
/** Between a shelf's columns, and how much of the next one shows past the screen's edge (the shelf slides on). */
const SHELF_GAP = 16;
const SHELF_PEEK = 78;
/** A shelf's column on a wide screen: never wider than a phone's. */
const SHELF_MAX = 360;

/** A service's own page (`ServicePage`), from Pessoal (`personal`) or the team's. */
export const openService = (id: string, personal: boolean) =>
  router.push({ pathname: "/connectors/service/[id]", params: { id, ...(personal ? { personal: "1" } : {}) } });

/**
 * Conectores on the phone, the large title and the search of the system with "+" in the bar, on the grouped gray of
 * the system's settings: what is connected as a grouped list (its mark, its name, its account or how many tools; what
 * waits on the person in amber in its place, a tap going where it is decided), then the catalog in shelves that slide
 * sideways, three services a column (the mark at 44, the name, one line of what it is, the kit's "Conectar"): the
 * suggestions first, then each category, "Ver todos" opening the whole category on a screen of its own. A search
 * lists what matches the same way, one column; a pasted address connects a server from the search itself. What isn't
 * open yet is left out rather than shown dead. A service not connected opens a sheet over the gallery with the flow
 * in steps; a connection opens its own screen; a mailbox, of any kind, opens a sheet of who uses it.
 */
export function ConnectorsScreen() {
  return (
    <SheetHostProvider>
      <Gallery />
    </SheetHostProvider>
  );
}

/**
 * What the gallery, a category's screen and a service's page read: the catalog, what is connected (the team's and
 * one's own, others' for who manages connectors), and what a service's row does when tapped: its page, pushed
 * (connected or not; the page says which and leads to the connection).
 */
export function useGallery(picked: ConnectionTab | null) {
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const catalog = useCatalog();
  const me = useMeId() ?? "";
  const members = useMembers(orgId).data?.length ?? 0;
  // The team's connections are for who manages connectors; every member connects their own (Pessoal). Being deleted,
  // nothing connects, as on the web: what is connected still opens.
  const frozen = settingsFrozen(org, "connectors");
  const manages = can(org, "manage_connectors");
  // Who manages connectors also gets other people's personal ones, as bare rows.
  const others = { others: manages };
  const connections = useConnections(orgId, true, others);
  // Servers connected by address (a vendor's own, like Sentry's) come from their own list, as on the web.
  const servers = useCustomServers(orgId, true, others);
  // Mailboxes (ADR 0038): rows of what is connected; they connect on the web.
  const mailAccounts = useMailAccounts(orgId, true, others);
  const everything = useMemo(
    () => connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []),
    [connections.data, servers.data, catalog.data],
  );
  const tabs = connectionTabs({
    items: everything,
    mailboxes: shownMailboxes(mailAccounts.data ?? []),
    me,
    members,
    manages,
    picked,
  });
  const personal = tabs.tab === "personal";
  // GitHub connects for the team only: not offered on Pessoal.
  const list = useMemo(
    () => (catalog.data?.connectors ?? []).filter((d) => !personal || personalAllowed(d.id)),
    [catalog.data, personal],
  );
  const open = (def: ConnectorDef) => openService(def.id, personal);
  return {
    org,
    sheet,
    catalog,
    connections,
    servers,
    mailAccounts,
    everything,
    tabs,
    personal,
    list,
    me,
    frozen,
    manages,
    open,
  };
}

function Gallery() {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const composio = useComposioUsage(orgId);
  const [picked, setPicked] = useState<ConnectionTab | null>(null);
  const {
    org,
    sheet,
    catalog,
    connections,
    servers,
    mailAccounts,
    everything,
    tabs,
    personal,
    list,
    me,
    frozen,
    manages,
    open,
  } = useGallery(picked);
  const pull = usePullRefresh(async () => {
    await Promise.all([catalog.refetch(), connections.refetch(), servers.refetch(), mailAccounts.refetch()]);
  });
  const [q, setQ] = useState("");
  const { items, mailboxes } = tabs;
  const admin = manages && !frozen;
  // Adding: the team's for who manages connectors, one's own for everyone.
  const mayAdd = !frozen && (manages || personal);
  const apps = items.filter((i) => !isMcpItem(i));
  const mcps = items.filter(isMcpItem);
  const rowMail = personal ? [] : mailboxes;
  const connectedCount = items.length + rowMail.length;
  const name = (d: ConnectorDef) => connectorName(t, d);
  const searching = q.trim().length > 0;
  // What can be connected (not yet connected, open here): what isn't open yet isn't listed, a dead row teaches nothing.
  const offered = useMemo(
    () =>
      galleryTiles(list, items)
        .filter((x) => x.opens && !x.connected)
        .map((x) => x.def),
    [list, items],
  );
  // The suggested services are the featured cards above what is connected (each opens its page); the shelves under
  // them are the catalog by category.
  const featured = useMemo(() => {
    const opens = new Set(offered.map((d) => d.id));
    return suggestionsOf(list, items, FEATURED * 2)
      .filter((d) => opens.has(d.id))
      .slice(0, FEATURED);
  }, [offered, list, items]);
  const shelves = useMemo(() => catalogShelves(offered), [offered]);
  // A search finds what is connected too (it opens its connection).
  const results = useMemo(
    () =>
      searching
        ? galleryTiles(
            searchConnectors(list, q, (d) => `${connectorName(t, d)} ${connectorDescription(t, d)}`),
            items,
          ).filter((x) => x.opens)
        : [],
    [searching, list, q, items, t],
  );
  // Without Composio here, the services that connect only through it are left out: admins read why.
  const composioOff = admin ? composioOffText(t, list, SUGGESTED) : null;
  // Connecting by an address: the one typed in the search when it is one.
  const openAddress = () =>
    sheet.open(<AddressSheet personal={personal} {...(isHttpsUrl(q.trim()) ? { url: q.trim() } : {})} />);
  // A connection opens its own screen (a server connected by an address we don't know included); tools waiting on the
  // person open where they are decided.
  const openItem = (item: ConnectedItem) =>
    connectionActs(item, me, manages).change && item.pending > 0 ? openTools(item.id) : openConnection(item.id);
  const mailRow = (a: (typeof mailboxes)[number]) => (
    <GroupedRow
      key={a.id}
      leading={<ConnectorIcon def={MAIL_BRANDS[choiceOf(a)] ?? null} label={a.label} size={ROW_MARK} />}
      label={a.label}
      {...(a.status === "needs_reconnect"
        ? { sub: t("connectors.composio.needsReconnect"), subTone: "amber" as const }
        : a.address
          ? { sub: a.address }
          : {})}
      chevron
      onPress={() => sheet.open(<MailboxSheet accountId={a.id} />)}
    />
  );
  // From an agent's card in the chat (`?connect=<catalog id>` or `?mcp=<address>`, `?mcp=` alone: any address): the
  // same sheet the gallery opens, once the catalog is in.
  const { connected, connect, mcp } = useLocalSearchParams<{ connected?: string; connect?: string; mcp?: string }>();
  const offeredOnce = useRef(false);
  useEffect(() => {
    if (offeredOnce.current || (connect === undefined && mcp === undefined) || !catalog.data || frozen) return;
    // Who may not add the team's connects it as their own, on Pessoal; GitHub stays with who manages connectors.
    if (!manages && !personalAllowed(connect)) return;
    offeredOnce.current = true;
    const def = connect ? catalog.data.connectors.find((d) => d.id === connect) : undefined;
    const theirs = !manages || personal;
    if (!manages) setPicked("personal");
    if (def) sheet.open(<ConnectSheet def={def} personal={theirs} />);
    else sheet.open(<AddressSheet url={mcp || undefined} personal={theirs} />);
  });
  // Back from a sign-in that finished on the link route (`?connected=<id>`): the confirmation, as the web shows
  // for the connection that just came in (admins; anyone else had the toast).
  const returned = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || returned.current === connected || !connections.data || !servers.data || !catalog.data) return;
    returned.current = connected;
    const item = everything.find((i) => i.id === connected);
    if (!item || frozen || !connectionActs(item, me, manages).change) return;
    if (item.ownerUserId) setPicked("personal");
    sheet.open(
      item.def ? (
        <ConnectSheet def={item.def} item={item} start="done" personal={Boolean(item.ownerUserId)} />
      ) : (
        <ServerSheet item={item} start="done" />
      ),
    );
  }, [connected, connections.data, servers.data, catalog.data, everything, me, manages, frozen, sheet]);
  const shelfTitle = (shelf: Shelf) => t(`connectors.category.${shelf.key}`);

  return (
    <PushedLargeTitle
      title={t("mobile.connectors.title")}
      grouped
      // Adding by an address lives in the bar, as every list's "+".
      {...(mayAdd
        ? { actions: [{ icon: "plus", sf: "plus", label: t("connectors.otherConnect"), onPress: openAddress }] }
        : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      // The search's results make room for the keyboard, which a drag takes away.
      keyboard
    >
      {composio.data && nearComposioLimit(composio.data) ? (
        <Text variant="small" tone="muted" style={styles.usage}>
          {composioUsageText(t, i18n.language, composio.data)}
        </Text>
      ) : null}
      {tabs.shown && connections.isSuccess && servers.isSuccess ? (
        <View style={styles.tabs}>
          <Segmented
            wide
            items={[
              { key: "team", label: t(modeKey(org, "vault.tab.team")), count: tabs.team },
              { key: "personal", label: t("vault.tab.personal"), count: tabs.mine },
            ]}
            value={tabs.tab}
            onChange={(k) => setPicked(k as ConnectionTab)}
          />
        </View>
      ) : null}
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.connectors.search")}
          accessibilityLabel={t("mobile.connectors.search")}
          returnKeyType="search"
        />
      </View>
      {catalog.isLoading || connections.isLoading || servers.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : catalog.isError && !catalog.data ? (
        // A catalog that didn't load is not an empty one: what happened, and the way to ask again.
        <LoadFailed onRetry={() => void catalog.refetch()} />
      ) : searching ? (
        <>
          {/* A pasted address connects a server by it, from the search itself. */}
          {mayAdd && isHttpsUrl(q.trim()) ? <AddressRow url={q.trim()} onPress={openAddress} /> : null}
          {results.length === 0 ? (
            <EmptyState
              size="inline"
              title={t("mobile.connectors.noResults")}
              action={
                mayAdd ? (
                  <Button variant="secondary" size="sm" label={t("connectors.otherConnect")} onPress={openAddress} />
                ) : (
                  <Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />
                )
              }
            />
          ) : (
            <Locked when={frozen} readable keepKeyboard style={styles.results}>
              {results.map(({ def: d, connected: isConnected }, i) => (
                <Lockup
                  key={d.id}
                  def={d}
                  name={name(d)}
                  text={connectorDescription(t, d)}
                  connected={isConnected}
                  divider={i > 0}
                  onPress={() => open(d)}
                />
              ))}
            </Locked>
          )}
        </>
      ) : (
        <>
          <Locked when={frozen} readable keepKeyboard>
            <FeaturedCards defs={featured} name={name} text={(d) => connectorDescription(t, d)} onOpen={open} />
          </Locked>
          {/* On Pessoal a person's mailboxes are a group of their own: they keep their own rule (ADR 0038). */}
          {personal && mailboxes.length > 0 ? (
            <View style={styles.group}>
              <GroupedHeader>{`${t("connectors.personal.mailTitle")} · ${mailboxes.length}`}</GroupedHeader>
              <View style={styles.groupNote}>
                <Note icon="mail">{t("connectors.personal.mailNote")}</Note>
              </View>
              <GroupedList>{mailboxes.map(mailRow)}</GroupedList>
            </View>
          ) : null}
          {personal && items.length > 0 ? (
            <View style={styles.personalNote}>
              <Note icon="lock">{t("connectors.personal.note")}</Note>
            </View>
          ) : null}
          {connectedCount > 0 ? (
            <View style={styles.group}>
              <GroupedHeader>{`${t("mobile.connectors.connected")} · ${connectedCount}`}</GroupedHeader>
              <GroupedList>
                {/* Mailboxes first, as on the web, by their name ("Suporte"). */}
                {rowMail.map(mailRow)}
                {/* Services, then servers connected by address (oldest first, as on the web). */}
                {[...apps, ...mcps].map((item) => (
                  <ConnectedRow
                    key={item.id}
                    item={item}
                    review={connectionActs(item, me, manages).change && item.pending > 0}
                    admin={admin}
                    onPress={() => openItem(item)}
                  />
                ))}
              </GroupedList>
            </View>
          ) : (
            // Nothing connected yet: what connecting gives, as every empty place says it. No button: the catalog
            // right under it is the next step (who can't connect is told who does).
            <FirstUse place="connectors" acts={mayAdd} size="inline" {...(personal ? { copy: PERSONAL_EMPTY } : {})} />
          )}
          {tabs.others.length + tabs.othersMail.length > 0 ? (
            <OthersPersonal items={tabs.others} mailboxes={tabs.othersMail} />
          ) : null}
          <Locked when={frozen} readable keepKeyboard>
            {shelves.map((shelf) => (
              <ShelfRow
                key={shelf.key}
                title={shelfTitle(shelf)}
                defs={shelf.defs}
                name={name}
                text={(d) => connectorDescription(t, d)}
                onOpen={open}
                // The whole category on a screen of its own, when the shelf has more than its first column.
                {...(shelf.defs.length > SHELF_ROWS
                  ? {
                      onAll: () =>
                        router.push({
                          pathname: "/connectors/category",
                          params: { c: shelf.key, ...(personal ? { personal: "1" } : {}) },
                        }),
                    }
                  : {})}
              />
            ))}
          </Locked>
        </>
      )}
      {composioOff ? (
        <Text variant="small" tone="muted" style={styles.note}>
          <CodeWords text={composioOff} />
        </Text>
      ) : null}
    </PushedLargeTitle>
  );
}

/**
 * A category's every service, from its shelf's "Ver todos" (`/connectors/category?c=<category>`, `personal=1` on
 * Pessoal): the large title in the category's name, one column of the catalog's rows, what is connected with its
 * check and no button (a tap opens its connection).
 */
export function ConnectorCategoryScreen({ category, personal }: { category: string; personal: boolean }) {
  return (
    <SheetHostProvider>
      <Category category={category} personal={personal} />
    </SheetHostProvider>
  );
}

function Category({ category, personal }: { category: string; personal: boolean }) {
  const { t } = useTranslation();
  const { catalog, connections, servers, tabs, list, frozen, open } = useGallery(personal ? "personal" : "team");
  const rows = galleryTiles(
    list.filter((d) => d.category === category),
    tabs.items,
  ).filter((x) => x.opens);
  return (
    <PushedLargeTitle title={t(`connectors.category.${category}`)} grouped>
      {catalog.isLoading || connections.isLoading || servers.isLoading ? (
        <SkeletonList rows={4} />
      ) : catalog.isError && !catalog.data ? (
        <LoadFailed onRetry={() => void catalog.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState size="inline" title={t("connectors.emptyCategory")} />
      ) : (
        <Locked when={frozen} readable style={styles.results}>
          {rows.map(({ def: d, connected }, i) => (
            <Lockup
              key={d.id}
              def={d}
              name={connectorName(t, d)}
              text={connectorDescription(t, d)}
              connected={connected}
              divider={i > 0}
              onPress={() => open(d)}
            />
          ))}
        </Locked>
      )}
    </PushedLargeTitle>
  );
}

/** The Pessoal side's own empty words. */
const PERSONAL_EMPTY = { title: "connectors.personal.emptyTitle", text: "connectors.personal.emptyText" };

/**
 * Other people's personal connections and mailboxes, for who manages connectors, in a quiet group under the team's:
 * the service, its name and whose it is, the agents that hold it. Never its account, tools or settings. A tap offers
 * only "Tirar de um agente" (a connection some agent holds) and "Remover".
 */
function OthersPersonal({
  items,
  mailboxes,
}: {
  items: ConnectedItem[];
  mailboxes: Pick<MailAccount, "id" | "label" | "provider" | "preset" | "ownerUserId" | "agents">[];
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const failed = useErrorToast();
  const takeOff = useTakeConnectionOffAgent(orgId);
  const { disconnect: removeMail } = useMailAction(orgId);
  const { disconnect: removeServer } = useCustomServerAction(orgId);
  const removeConnection = useDisconnect(orgId);
  const busy = takeOff.isPending || removeMail.isPending || removeServer.isPending || removeConnection.isPending;
  const ownerOf = (id: string | null | undefined) =>
    personalOfText(t, (id && dir.memberById.get(id)?.name) || t("channel.unknownPerson"));
  const holders = (ids: string[]) =>
    ids.map((id) => dir.agentById.get(id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const remove = (name: string, run: (done: { onSuccess: () => void; onError: (e: unknown) => void }) => void) =>
    confirmAction({
      title: t("connectors.personal.removeTitle", { name }),
      action: t("connectors.personal.remove"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        run({
          onSuccess: () => toast({ title: t("mobile.connectors.disconnected", { name }), icon: "check" }),
          onError: failed,
        }),
    });
  const offAgent = (item: ConnectedItem, name: string) =>
    chooseAction(
      t("connectors.personal.takeOffTitle", { name }),
      holders(item.agentIds).map((a) => ({
        label: a.name,
        onPress: () =>
          takeOff.mutate(
            { connectionId: item.id, agentId: a.id },
            {
              onSuccess: () =>
                toast({ title: t("connectors.personal.takenOff", { name, agent: a.name }), icon: "check" }),
              onError: failed,
            },
          ),
      })),
      t("common.cancel"),
    );
  const actions = (item: ConnectedItem) => {
    const name = itemName(t, item);
    chooseAction(
      name,
      [
        ...(item.agentIds.length > 0
          ? [{ label: t("connectors.personal.takeOff"), onPress: () => offAgent(item, name) }]
          : []),
        {
          label: t("connectors.personal.remove"),
          destructive: true,
          onPress: () =>
            remove(name, (done) =>
              item.custom ? removeServer.mutate(item.id, done) : removeConnection.mutate(item.id, done),
            ),
        },
      ],
      t("common.cancel"),
    );
  };
  const usedBy = (ids: string[]) =>
    holders(ids)
      .map((a) => a.name)
      .join(", ");
  return (
    <>
      <GroupedHeader>{`${t("connectors.personal.others")} · ${items.length + mailboxes.length}`}</GroupedHeader>
      <View style={styles.others}>
        <GroupedList>
          {mailboxes.map((m) => {
            const name = mailboxName(t, m);
            return (
              <GroupedRow
                key={`mail-${m.id}`}
                icon="mail"
                label={name}
                sub={ownerOf(m.ownerUserId)}
                labelLines={0}
                subLines={0}
                {...(m.agents.length > 0 ? { below: <UsedBy names={usedBy(m.agents.map((a) => a.agentId))} /> } : {})}
                more
                disabled={busy}
                // The same choice a connection's row opens, with only Remover: a mailbox has no take-off here.
                onPress={() =>
                  chooseAction(
                    name,
                    [
                      {
                        label: t("connectors.personal.remove"),
                        destructive: true,
                        onPress: () => remove(name, (done) => removeMail.mutate(m.id, done)),
                      },
                    ],
                    t("common.cancel"),
                  )
                }
              />
            );
          })}
          {items.map((item) => (
            <GroupedRow
              key={item.id}
              leading={<ConnectorIcon def={item.def} image={item.image} label={itemName(t, item)} size={30} />}
              label={itemName(t, item)}
              sub={ownerOf(item.ownerUserId)}
              labelLines={0}
              subLines={0}
              {...(item.agentIds.length > 0 ? { below: <UsedBy names={usedBy(item.agentIds)} /> } : {})}
              more
              disabled={busy}
              onPress={() => actions(item)}
            />
          ))}
        </GroupedList>
      </View>
    </>
  );
}

/** The agents that hold someone else's connection, wrapping as the row needs. */
function UsedBy({ names }: { names: string }) {
  return (
    <Text variant="footnote" tone="faint">
      {names}
    </Text>
  );
}

/** Searching with an address: connecting a server by it, one tap. */
function AddressRow({ url, onPress }: { url: string; onPress: () => void }) {
  const { t } = useTranslation();
  const surface = useSurface();
  // The suggestions' own card, with "Conectar" where the eye lands: it opens the sheet, so no haptic of its own.
  return (
    <PressScale
      haptic={false}
      fill={false}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${t("connectors.otherConnect")}. ${url}`}
      style={[styles.card, styles.address, surface]}
      contentStyle={styles.cardIn}
    >
      <View style={styles.grow}>
        <Text variant="body" numberOfLines={1} style={styles.bold}>
          {t("connectors.otherConnect")}
        </Text>
        <Text variant="subhead" tone="muted" numberOfLines={1}>
          {url}
        </Text>
      </View>
      <ConnectWord />
    </PressScale>
  );
}

/** "Conectar" in words at a row's or a card's end: the whole row is the button, this is where the eye lands. */
function ConnectWord() {
  const { t } = useTranslation();
  return (
    <Text variant="subhead" tone="ink2" style={styles.bold}>
      {t("mobile.connectors.connect")}
    </Text>
  );
}

/**
 * A connection in the grouped list: its mark, its name, and under it its account (or how many tools it gives); when
 * it waits on the person (its sign-in stopped working, its tools couldn't be read, or tools to decide), that, in amber,
 * in its place. A tap opens it, or where its tools are decided.
 */
function ConnectedRow({
  item,
  review,
  admin,
  onPress,
}: {
  item: ConnectedItem;
  review: boolean;
  admin: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const name = itemName(t, item);
  const why = item.needsReconnect
    ? t("connectors.composio.needsReconnect")
    : item.toolsError
      ? t("connectors.noToolsNow")
      : review && admin
        ? t("mobile.connectors.waitLine", { count: item.pending })
        : null;
  const fact = item.account ?? (item.tools > 0 ? t("connectors.toolsCount", { count: item.tools }) : null);
  return (
    <GroupedRow
      leading={<ConnectorIcon def={item.def} image={item.image} label={name} size={ROW_MARK} />}
      label={name}
      {...(why ? { sub: why, subTone: "amber" as const } : fact ? { sub: fact } : {})}
      chevron
      onPress={onPress}
    />
  );
}

/**
 * A shelf of the catalog: its header ("Ver todos ›" opening the whole category, when there is more than its first
 * column), then its columns of three sliding sideways, each snapping to the screen's side with the next one's edge in
 * sight, so the shelf reads as going on.
 */
export function ShelfRow({
  title,
  defs,
  name,
  text,
  onOpen,
  onAll,
  grouped = false,
}: {
  title: string;
  defs: readonly ConnectorDef[];
  name: (d: ConnectorDef) => string;
  text: (d: ConnectorDef) => string;
  onOpen: (d: ConnectorDef) => void;
  onAll?: () => void;
  /** Under the grouped lists' own header (a service's page, where every section has it). */
  grouped?: boolean;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const c = useColors();
  const column = Math.min(width - SHELF_PEEK, SHELF_MAX);
  const columns = shelfColumns(defs);
  return (
    <View>
      {grouped ? (
        <View style={styles.groupedHead}>
          <GroupedHeader
            aside={
              onAll ? (
                <Button variant="text" size="sm" label={t("mobile.connectors.seeAll")} onPress={onAll} />
              ) : undefined
            }
          >
            {title}
          </GroupedHeader>
        </View>
      ) : (
        <SectionHeader
          title={title}
          {...(onAll ? { action: { label: t("mobile.connectors.seeAll"), onPress: onAll } } : {})}
        />
      )}
      <SideScroll
        fade={c.grouped}
        // A column at a time, as the system's shelves move: snapped to the screen's side, never left between two; a
        // fade at the edge where more columns wait.
        snapToInterval={column + SHELF_GAP}
        decelerationRate="fast"
        disableIntervalMomentum
        scrollEnabled={columns.length > 1}
        contentContainerStyle={styles.shelf}
      >
        {columns.map((col) => (
          <View key={col[0]?.id} style={{ width: column }}>
            {col.map((d, i) => (
              <Lockup
                key={d.id}
                def={d}
                name={name(d)}
                text={text(d)}
                connected={false}
                divider={i > 0}
                onPress={() => onOpen(d)}
              />
            ))}
          </View>
        ))}
      </SideScroll>
    </View>
  );
}

/**
 * One service of the catalog: its mark at 44 (a check on it once it is connected), its name, one line of what it is,
 * and the chevron: the whole row opens it, as a store's row opens its app (no button of its own in the list).
 */
function Lockup({
  def,
  name,
  text,
  connected,
  divider,
  onPress,
}: {
  def: ConnectorDef;
  name: string;
  text: string;
  connected: boolean;
  divider: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    // A row of a list: it lights as the settings' rows do, a beat late so a scroll never flashes it.
    <RowPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${text}`}
      style={styles.lockup}
    >
      {divider ? <View style={[styles.lockupLine, { backgroundColor: c.separator }]} /> : null}
      <ConnectorIcon def={def} label={name} size={LOCKUP_MARK} check={connected} />
      <View style={styles.grow}>
        <Text variant="body" numberOfLines={1} style={styles.bold}>
          {name}
        </Text>
        <Text variant="footnote" tone="faint" numberOfLines={1}>
          {text}
        </Text>
      </View>
      <Disclosure />
    </RowPressable>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 6 },
  tabs: { paddingHorizontal: 16, paddingBottom: 12 },
  personalNote: { paddingHorizontal: 16, paddingTop: 8 },
  group: { paddingHorizontal: 16, paddingTop: 8 },
  groupNote: { paddingBottom: 8 },
  others: { paddingHorizontal: 16 },
  note: { paddingHorizontal: 16, paddingTop: 16 },
  usage: { paddingHorizontal: 16, paddingBottom: 8 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  // A grouped header over a shelf: at the screen's sides, as the grouped lists over it.
  groupedHead: { paddingHorizontal: 16 },
  // The app's card with its cut corner (no hairline box), as every card standing on the page.
  card: { borderRadius: 20, borderBottomLeftRadius: 6 },
  cardIn: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  address: { marginHorizontal: 16, marginTop: 8 },
  // A shelf's columns, at the screen's sides, the next one's edge past the right one.
  shelf: { gap: SHELF_GAP, paddingHorizontal: 16 },
  // A search's matches: one column at the screen's sides.
  results: { paddingHorizontal: 16, paddingTop: 4 },
  lockup: { flexDirection: "row", alignItems: "center", gap: LOCKUP_GAP, minHeight: 66, paddingVertical: 10 },
  // The hairline starts where the text does.
  lockupLine: {
    position: "absolute",
    top: 0,
    right: 0,
    left: LOCKUP_MARK + LOCKUP_GAP,
    height: StyleSheet.hairlineWidth,
  },
});
