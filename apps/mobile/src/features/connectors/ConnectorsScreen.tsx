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
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useLocalSearchParams } from "expo-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  CodeWords,
  EmptyState,
  Filters,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  LineIcon,
  Locked,
  PressScale,
  RowPressable,
  SearchField,
  SectionHeader,
  Segmented,
  SkeletonList,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
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
import {
  CATEGORIES,
  type ConnectionTab,
  connectionOf,
  connectionTabs,
  galleryTiles,
  isHttpsUrl,
  SUGGESTED,
  searchConnectors,
  shownMailboxes,
  suggestionsOf,
} from "./logic";
import { MailboxSheet } from "./MailboxSheet";
import { openTools } from "./ToolsScreen";

/** The catalog row's mark; the text column starts after it, where its hairline does. */
const ROW_MARK = 36;
const ROW_SIDE = 16;
const ROW_GAP = 12;

/**
 * Conectores on the phone, the large title and the search of the system with "+" in the bar: what is connected as
 * a row of marks with a check (Adicionar as the dashed tile at its end), what waits on the person as one amber line
 * right under it, two suggestions as the app's cards with "Conectar" in words, then every service as a list (the
 * mark at 36, the name, one line of what it is, "Conectar" at the end), filtered by category; what isn't open yet
 * is left out rather than shown dead. A pasted address connects a server from the search itself. A service not
 * connected opens a sheet over the gallery with the flow in steps; a connection opens its own screen; a mailbox, of
 * any kind, opens a sheet of who uses it. A list people filter often: the rows don't each animate.
 */
export function ConnectorsScreen() {
  return (
    <SheetHostProvider>
      <Gallery />
    </SheetHostProvider>
  );
}

function Gallery() {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const catalog = useCatalog();
  const composio = useComposioUsage(orgId);
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
  const pull = usePullRefresh(async () => {
    await Promise.all([catalog.refetch(), connections.refetch(), servers.refetch(), mailAccounts.refetch()]);
  });
  const [picked, setPicked] = useState<ConnectionTab | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
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
  const { items, mailboxes } = tabs;
  const admin = manages && !frozen;
  // Adding: the team's for who manages connectors, one's own for everyone.
  const mayAdd = !frozen && (manages || personal);
  // GitHub connects for the team only: not offered on Pessoal.
  const list = (catalog.data?.connectors ?? []).filter((d) => !personal || personalAllowed(d.id));
  const apps = items.filter((i) => !isMcpItem(i));
  const mcps = items.filter(isMcpItem);
  const rowMail = personal ? [] : mailboxes;
  const connectedCount = items.length + rowMail.length;
  const name = (d: ConnectorDef) => connectorName(t, d);
  const suggestions = useMemo(() => suggestionsOf(list, items, 2), [list, items]);
  const searching = q.trim().length > 0;
  const rest = useMemo(() => {
    const pool = searching ? list : list.filter((d) => !suggestions.includes(d));
    const inCat = cat === "all" ? pool : pool.filter((d) => d.category === cat);
    return searchConnectors(inCat, q, (d) => `${connectorName(t, d)} ${connectorDescription(t, d)}`);
  }, [list, suggestions, cat, q, searching, t]);
  const cats = CATEGORIES.filter((k) => list.some((d) => d.category === k));
  // What is already connected is in the row above; the list shows it only to a search. What can't be connected
  // yet isn't listed: a dead row teaches nothing.
  const rows = galleryTiles(rest, items).filter((x) => x.opens && (searching || !x.connected));
  // What waits on the person among the connected: a sign-in that stopped, tools that couldn't be read, tools to
  // decide (admins).
  const waiting = items.filter(
    (i) => i.needsReconnect || i.toolsError || (connectionActs(i, me, manages).change && i.pending > 0),
  );
  // Without Composio here, the services that connect only through it are left out: admins read why.
  const composioOff = admin ? composioOffText(t, list, SUGGESTED) : null;
  const open = (def: ConnectorDef) => {
    const existing = connectionOf(def, items);
    if (existing) openConnection(existing.id);
    else sheet.open(<ConnectSheet def={def} personal={personal} />);
  };
  // Connecting by an address: the one typed in the search when it is one.
  const openAddress = () =>
    sheet.open(<AddressSheet personal={personal} {...(isHttpsUrl(q.trim()) ? { url: q.trim() } : {})} />);
  // A connection opens its own screen (a server connected by an address we don't know included).
  const openItem = (item: ConnectedItem) => openConnection(item.id);
  const mailTile = (a: (typeof mailboxes)[number]) => (
    <MiniTile
      key={a.id}
      onPress={() => sheet.open(<MailboxSheet accountId={a.id} />)}
      label={t("mobile.connectors.connectedCheck", { name: a.label })}
    >
      <ConnectorIcon def={MAIL_BRANDS[choiceOf(a)] ?? null} label={a.label} size={48} check />
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {a.label}
      </Text>
    </MiniTile>
  );
  // From an agent's card in the chat (`?connect=<catalog id>` or `?mcp=<address>`, `?mcp=` alone: any address): the
  // same sheet the gallery opens, once the catalog is in.
  const { connected, connect, mcp } = useLocalSearchParams<{ connected?: string; connect?: string; mcp?: string }>();
  const offered = useRef(false);
  useEffect(() => {
    if (offered.current || (connect === undefined && mcp === undefined) || !catalog.data || frozen) return;
    // Who may not add the team's connects it as their own, on Pessoal; GitHub stays with who manages connectors.
    if (!manages && !personalAllowed(connect)) return;
    offered.current = true;
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

  return (
    <PushedLargeTitle
      title={t("mobile.connectors.title")}
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
      ) : (
        <>
          {/* A pasted address connects a server by it, from the search itself. */}
          {searching && mayAdd && isHttpsUrl(q.trim()) ? <AddressRow url={q.trim()} onPress={openAddress} /> : null}
          {searching ? null : (
            <>
              {/* On Pessoal a person's mailboxes are a group of their own: they keep their own rule (ADR 0038). */}
              {personal && mailboxes.length > 0 ? (
                <>
                  <SectionHeader title={t("connectors.personal.mailTitle")} count={mailboxes.length} />
                  <View style={styles.personalNote}>
                    <Note icon="mail">{t("connectors.personal.mailNote")}</Note>
                  </View>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                    {mailboxes.map(mailTile)}
                  </ScrollView>
                </>
              ) : null}
              {personal && items.length > 0 ? (
                <View style={styles.personalNote}>
                  <Note icon="lock">{t("connectors.personal.note")}</Note>
                </View>
              ) : null}
              {mayAdd || connectedCount > 0 ? (
                <>
                  <SectionHeader
                    title={t("mobile.connectors.connected")}
                    {...(connectedCount > 0 ? { count: connectedCount } : {})}
                  />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                    {/* A connection made or removed while the row is in sight fades, and the others slide over. */}
                    <LayoutAnimationConfig skipEntering>
                      {/* Mailboxes first, as on the web, by their name ("Suporte"). */}
                      {rowMail.map(mailTile)}
                      {/* Services, then servers connected by address (oldest first, as on the web). */}
                      {[...apps, ...mcps].map((item) => (
                        <ConnectedTile
                          key={item.id}
                          item={item}
                          review={connectionActs(item, me, manages).change && item.pending > 0}
                          fresh={item.id === connected}
                          onPress={() => openItem(item)}
                        />
                      ))}
                      {/* Adding comes after what is there: the row reads what is connected first. */}
                      {mayAdd ? <AddTile onPress={() => sheet.open(<AddressSheet personal={personal} />)} /> : null}
                    </LayoutAnimationConfig>
                  </ScrollView>
                  {waiting.length > 0 ? (
                    <WaitLine
                      items={waiting}
                      admin={admin}
                      onOpen={(i) =>
                        connectionActs(i, me, manages).change && i.pending > 0 ? openTools(i.id) : openItem(i)
                      }
                    />
                  ) : null}
                </>
              ) : null}
              {/* Nothing connected yet: what connecting gives, as every empty place says it. No button: the
                  catalog right under it is the next step (who can't connect is told who does). */}
              {connectedCount === 0 ? (
                <FirstUse
                  place="connectors"
                  acts={mayAdd}
                  size="inline"
                  {...(personal ? { copy: PERSONAL_EMPTY } : {})}
                />
              ) : null}
              {tabs.others.length + tabs.othersMail.length > 0 ? (
                <OthersPersonal items={tabs.others} mailboxes={tabs.othersMail} />
              ) : null}
            </>
          )}
          {!searching && suggestions.length > 0 ? (
            <>
              {/* A personal workspace's are suggested for its person, never "for Personal" (ADR 0159). */}
              <SectionHeader
                title={
                  isPersonal(org) || personal
                    ? t("connectors.suggestedPersonal")
                    : t("mobile.connectors.suggested", { org: org?.name ?? "" })
                }
              />
              <Locked when={frozen} readable keepKeyboard style={styles.suggestions}>
                {suggestions.map((d) => (
                  <Suggestion
                    key={d.id}
                    mark={d}
                    name={name(d)}
                    text={connectorDescription(t, d)}
                    onPress={() => open(d)}
                  />
                ))}
              </Locked>
            </>
          ) : null}
          {searching ? null : <SectionHeader title={t("mobile.connectors.allServices")} count={rows.length} />}
          {cats.length > 1 ? (
            <View style={styles.filters}>
              <Filters
                items={[
                  { key: "all", label: t("mobile.connectors.all") },
                  ...cats.map((k) => ({ key: k, label: t(`connectors.category.${k}`) })),
                ]}
                value={cat}
                onChange={setCat}
              />
            </View>
          ) : null}
          {rows.length === 0 ? (
            <EmptyState
              size="inline"
              title={t("mobile.connectors.noResults")}
              action={
                mayAdd ? (
                  <Button variant="secondary" size="sm" label={t("connectors.otherConnect")} onPress={openAddress} />
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("filters.clearSearch")}
                    onPress={() => {
                      setQ("");
                      setCat("all");
                    }}
                  />
                )
              }
            />
          ) : (
            <Locked when={frozen} readable keepKeyboard style={styles.list}>
              {rows.map(({ def: d, connected: isConnected }, i) => (
                <ServiceRow
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
          {composioOff ? (
            <Text variant="small" tone="muted" style={styles.note}>
              <CodeWords text={composioOff} />
            </Text>
          ) : null}
        </>
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

/**
 * What waits on the person, in one line under the connected row, in the waiting color: tools to decide ("2
 * ferramentas precisam de você · Serviço T"), a sign-in that stopped, tools that couldn't be read. The first
 * service names what, every one waiting is named after it. A tap opens where it is decided.
 */
function WaitLine({
  items,
  admin,
  onOpen,
}: {
  items: ConnectedItem[];
  admin: boolean;
  onOpen: (item: ConnectedItem) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const first = items[0];
  if (!first) return null;
  const what = first.needsReconnect
    ? t("connectors.composio.needsReconnect")
    : first.toolsError
      ? t("connectors.noToolsNow")
      : admin
        ? t("mobile.connectors.waitLine", { count: first.pending })
        : "";
  const names = items.map((i) => itemName(t, i)).join(", ");
  return (
    // It opens a screen: the press shows, with no haptic (plain navigation).
    <PressScale
      haptic={false}
      fill={false}
      onPress={() => onOpen(first)}
      accessibilityRole="button"
      accessibilityLabel={`${what} · ${names}`}
      style={styles.waitPress}
      contentStyle={styles.wait}
    >
      <LineIcon variant="small" name="wait" size={16} color={c.amber} />
      <Text variant="small" numberOfLines={1} style={styles.grow}>
        <Text variant="small" style={[styles.bold, { color: c.amber }]}>
          {what}
        </Text>
        <Text variant="small" tone="muted">
          {` · ${names}`}
        </Text>
      </Text>
    </PressScale>
  );
}

/**
 * A connection in the row: its mark with the check, its name; when it waits on you (its sign-in stopped working, its
 * tools couldn't be read, or a server's new or unclear tools), the amber wait mark instead (the line under the row
 * says why, its screen too).
 */
function ConnectedTile({
  item,
  review,
  fresh = false,
  onPress,
}: {
  item: ConnectedItem;
  review: boolean;
  /** Just connected (back from its sign-in): it lands in the row once. */
  fresh?: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  // The rare moment of the gallery: what you just connected settles into the row (from 0.9 and half seen, ease-out).
  // No tap of its own: the way back from the sign-in already buzzed (`OAuthReturn`), one per connection. Reduced
  // motion: it is simply there.
  const land = useSharedValue(fresh && !reduced ? 0 : 1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the tile first shows
  useEffect(() => {
    if (fresh) land.set(withTiming(1, { duration: 360, easing: LAND }));
  }, []);
  const landed = useAnimatedStyle(() => ({
    opacity: 0.5 + land.get() * 0.5,
    transform: [{ translateY: (1 - land.get()) * 6 }, { scale: 0.9 + land.get() * 0.1 }],
  }));
  const name = itemName(t, item);
  const why = item.needsReconnect
    ? t("connectors.composio.needsReconnect")
    : item.toolsError
      ? t("connectors.noToolsNow")
      : review
        ? t("toolReview.decideTitle", { count: item.pending })
        : null;
  const waiting = why !== null;
  return (
    <MiniTile onPress={onPress} label={why ? `${name}, ${why}` : t("mobile.connectors.connectedCheck", { name })}>
      <Animated.View style={landed}>
        <ConnectorIcon def={item.def} image={item.image} label={name} size={48} check={!waiting} />
        {waiting ? (
          <View style={[styles.waitBadge, { backgroundColor: c.amber, borderColor: c.bg }]}>
            <Icon name="wait" size={12} color={c.bg} />
          </View>
        ) : null}
      </Animated.View>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {name}
      </Text>
    </MiniTile>
  );
}

/** A strong ease-out: what lands starts fast and settles. */
const LAND = Easing.bezier(0.23, 1, 0.32, 1);
const TILE_IN = FadeIn.duration(160);
const TILE_OUT = FadeOut.duration(120);
const TILE_SLIDE = LinearTransition.duration(220);

/**
 * A tile of the connected row: it gives under the finger (opening it is plain navigation, so no haptic), and it fades
 * in or out as a connection is made or removed while the row is in sight (none of it with reduced motion).
 */
function MiniTile({ onPress, label, children }: { onPress: () => void; label: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <Animated.View
      entering={reduced ? undefined : TILE_IN}
      exiting={reduced ? undefined : TILE_OUT}
      layout={reduced ? undefined : TILE_SLIDE}
    >
      <PressScale
        haptic={false}
        fill={false}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.mini}
        contentStyle={styles.miniIn}
      >
        {children}
      </PressScale>
    </Animated.View>
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

/** The dashed tile at the end of the connected row: a server by its address. */
function AddTile({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <MiniTile onPress={onPress} label={t("connectors.otherConnect")}>
      <View style={[styles.addTile, { borderColor: c.line2 }]}>
        <Icon name="plus" size={20} color={c.muted} />
      </View>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {t("mobile.connectors.add")}
      </Text>
    </MiniTile>
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

/** A suggestion: the app's card with the service's mark, its name, what it is and "Conectar" in words. */
function Suggestion({
  mark,
  name,
  text,
  onPress,
}: {
  mark: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
  name: string;
  text: string;
  onPress: () => void;
}) {
  const surface = useSurface();
  return (
    <PressScale
      haptic={false}
      fill={false}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${text}`}
      style={[styles.card, surface]}
      contentStyle={styles.cardIn}
    >
      <ConnectorIcon def={mark} label={name} size={40} />
      <View style={styles.grow}>
        <Text variant="body" numberOfLines={1} style={styles.bold}>
          {name}
        </Text>
        <Text variant="subhead" tone="muted" numberOfLines={2}>
          {text}
        </Text>
      </View>
      <ConnectWord />
    </PressScale>
  );
}

/** One service of the catalog: its mark at 36, its name, one line of what it is, "Conectar" (a check once it is). */
function ServiceRow({
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
      style={styles.service}
    >
      {divider ? <View style={[styles.serviceLine, { backgroundColor: c.line2 }]} /> : null}
      <ConnectorIcon def={def} label={name} size={ROW_MARK} check={connected} />
      <View style={styles.grow}>
        <Text variant="body" numberOfLines={1} style={styles.bold}>
          {name}
        </Text>
        <Text variant="subhead" tone="muted" numberOfLines={1}>
          {text}
        </Text>
      </View>
      {connected ? null : <ConnectWord />}
    </RowPressable>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 6 },
  tabs: { paddingHorizontal: 16, paddingBottom: 12 },
  personalNote: { paddingHorizontal: 16, paddingBottom: 8 },
  others: { paddingHorizontal: 16 },
  note: { paddingHorizontal: 16, paddingTop: 16 },
  usage: { paddingHorizontal: 16, paddingBottom: 8 },
  row: { gap: 16, paddingHorizontal: 16, paddingBottom: 6 },
  mini: { width: 64 },
  miniIn: { alignItems: "center", gap: 6 },
  addTile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  // On the margin of 16, under the connected row: one line with its icon beside it, its row a finger's 44 points tall
  // (the line alone was a 20-point target), so the space above and below it is part of the tap.
  waitPress: { marginHorizontal: 16 },
  wait: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  suggestions: { gap: 12, paddingHorizontal: 16 },
  filters: { paddingBottom: 4 },
  // The app's card with its cut corner (no hairline box), as every card standing on the page.
  card: { borderRadius: 20, borderBottomLeftRadius: 6 },
  cardIn: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  list: { paddingTop: 4 },
  service: {
    flexDirection: "row",
    alignItems: "center",
    gap: ROW_GAP,
    paddingHorizontal: ROW_SIDE,
    paddingVertical: 10,
    minHeight: 60,
  },
  // The hairline starts where the text does.
  serviceLine: {
    position: "absolute",
    top: 0,
    right: 0,
    left: ROW_SIDE + ROW_MARK + ROW_GAP,
    height: StyleSheet.hairlineWidth,
  },
  waitBadge: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  address: { marginHorizontal: 16, marginTop: 8 },
});
