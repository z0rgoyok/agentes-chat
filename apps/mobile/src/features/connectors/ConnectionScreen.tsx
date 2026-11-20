import {
  useCatalog,
  useConnections,
  useCustomServerAction,
  useCustomServers,
  useMoveConnectionToTeam,
  useRenameConnection,
} from "@agenteschat/client";
import {
  accountUnchecked,
  connectedItems,
  connectionActs,
  itemName,
  reconnectAddsText,
} from "@agenteschat/client/lib/connected";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { appAccountsText } from "@agenteschat/client/lib/github-app";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorBrand } from "@agenteschat/client/lib/scopes";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type HeaderAction,
  SkeletonList,
  Text,
  useToast,
} from "@/ui";
import { CoverBarBackdrop, FadingHeaderTitle, useCoverScroll } from "@/ui/cover";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { RowBones } from "../roles/parts";
import { chooseAction, confirmAction, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useErrorToast, useMeId, useOrgId } from "../shared/hooks";
import { errorHaptic, goBack, PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { AgentLevelList, DisconnectRow } from "./Access";
import { ConnectorIcon } from "./ConnectorIcon";
import { AddressSheet, ConnectSheet } from "./ConnectSheet";
import { GitHubAppGroup } from "./GitHubApp";
import { accountActions, headerNamesText } from "./logic";
import { Problem } from "./Problem";
import { openTools } from "./ToolsScreen";

/** Opens a connection's own screen (from its tile or its icon in Conectores). */
export const openConnection = (id: string) => router.push(`/connectors/${id}`);

/** Renomear, pushed over a connection's screen. */
const openRename = (id: string) => router.push({ pathname: "/connectors/rename", params: { id } });

/**
 * A connection, a screen pushed over Conectores, laid out as the phone's settings (groups on the grouped gray): the
 * clear bar with a pen for renaming (its own screen), its title coming in once the name under the mark scrolls away
 * under it; its mark with the check, its name and its account under it; who uses
 * it (one row per agent, the level as its value, changed in place), what always asks as that group's footer; its
 * tools as one row (what waits on you under it, in amber; a screen of their own); the account (which, Reconectar,
 * another account of an MCP server, each in a sheet, and under them the request headers a server by address also
 * sends, by name); and Desconectar, alone in red, behind the system's confirmation. GitHub also lists its
 * repositories through the agentes.chat app, under who uses it. Connecting a new service stays in its sheet.
 */
export function ConnectionScreen({ id }: { id: string }) {
  return (
    <SheetHostProvider>
      <Connection id={id} />
    </SheetHostProvider>
  );
}

function Connection({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { org } = useOrg();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const me = useMeId() ?? "";
  const { refresh } = useCustomServerAction(orgId);
  const move = useMoveConnectionToTeam(orgId);
  const failed = useErrorToast();
  const toast = useToast();
  const sheet = useSheet();
  const { y, onScroll } = useCoverScroll();
  // Where the name sits under the clear bar: the bar's own title comes in only as it scrolls away under it, never
  // the same words twice on screen.
  const [nameBox, setNameBox] = useState({ top: 0, bottom: 0 });
  const item = connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
    (i) => i.id === id,
  );
  const loading = !item && (catalog.isPending || connections.isPending || servers.isPending);
  // The team's: who manages connectors changes it. One's own: its person, who may also hand it to the team.
  const acts = connectionActs(item ?? {}, me, can(org, "manage_connectors"));
  const admin = Boolean(item) && acts.change;
  const name = item ? itemName(t, item) : "";
  // The account when it says something the name doesn't (a server's host often is its name), else how it connects
  // through Composio (its address means nothing to people), else the category.
  const sub =
    item?.viaGithubApp && item.account
      ? appAccountsText(t, item.account)
      : item?.account && item.account !== name
        ? item.account
        : item?.viaComposio
          ? t("connectors.composio.via")
          : item?.def
            ? t(`connectors.category.${item.def.category}`)
            : "";
  const waiting = admin && item ? item.pending : 0;
  const actions = item ? accountActions(item) : [];
  const sent = item?.server?.headerNames ?? [];
  const toTeam = () =>
    confirmAction({
      title: t("connectors.personal.moveTitle", { name }),
      text: t("connectors.personal.moveText"),
      action: t("connectors.personal.moveToTeam"),
      cancel: t("common.cancel"),
      destructive: false,
      onConfirm: () =>
        item &&
        move.mutate(item.id, {
          onSuccess: () => {
            successHaptic();
            toast({ title: t("connectors.personal.moved", { name }), icon: "check" });
          },
          onError: failed,
        }),
    });
  // Renaming: the bar's pen (the system's own bar button) pushes its screen straight away (a menu of one item in
  // between was a step for nothing). One's own personal connection may also go to the team: then both sit in "…".
  const choices = [
    ...(acts.rename && item && actions.includes("rename")
      ? [
          {
            icon: "pen" as const,
            sf: "pencil" as const,
            label: t("connectors.rename"),
            onPress: () => openRename(item.id),
          },
        ]
      : []),
    ...(acts.moveToTeam && item
      ? [
          {
            icon: "members" as const,
            sf: "person.2" as const,
            label: t("connectors.personal.moveToTeam"),
            onPress: toTeam,
          },
        ]
      : []),
  ];
  const [only] = choices;
  const barAction: HeaderAction | null =
    choices.length > 1
      ? {
          icon: "more",
          sf: "ellipsis",
          label: t("mobile.chat.options"),
          disabled: move.isPending,
          onPress: () => chooseAction(name, choices, t("common.cancel")),
          menu: choices,
        }
      : only
        ? { ...only, disabled: move.isPending }
        : null;
  const missing = !item && !loading;

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={
          <FadingHeaderTitle y={y} from={nameBox.top - headerHeight} to={nameBox.bottom - headerHeight} text={name} />
        }
        plate
        solid={false}
        {...(barAction ? { actions: [barAction] } : {})}
      />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View style={[styles.head, { paddingTop: insets.top + 56 }]}>
          <ConnectorIcon
            def={item?.def ?? null}
            image={item?.image}
            label={name || "·"}
            size={60}
            check={Boolean(item)}
          />
          <Text
            variant="title2"
            numberOfLines={2}
            style={styles.center}
            onLayout={(e) => {
              const { y: top, height } = e.nativeEvent.layout;
              setNameBox({ top, bottom: top + height });
            }}
          >
            {name}
          </Text>
          {sub ? (
            <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.center}>
              {sub}
            </Text>
          ) : null}
        </View>

        {item?.ownerUserId ? (
          <View style={styles.personal}>
            <Note icon="lock">{t("connectors.personal.noteOne")}</Note>
          </View>
        ) : null}
        {loading ? (
          // The groups' shape while they load: nothing jumps when they come.
          <View style={styles.body}>
            <GroupedHeader>{t("mobile.connectors.whoTitle")}</GroupedHeader>
            <GroupedList>
              <RowBones />
              <RowBones name={56} />
            </GroupedList>
          </View>
        ) : missing && (catalog.isError || connections.isError || servers.isError) ? (
          // Not loaded is not gone: what happened, and the way to ask again.
          <LoadFailed onRetry={() => void Promise.all([catalog.refetch(), connections.refetch(), servers.refetch()])} />
        ) : missing ? (
          // Disconnected meanwhile (here, on the web, by someone else): said, never a blank page.
          <EmptyState size="inline" title={t("common.gone")} />
        ) : item ? (
          <View style={styles.body}>
            {item.needsReconnect ? (
              <Problem text={t("mobile.connectors.needsReconnect", { name })} />
            ) : item.toolsError ? (
              <View style={styles.problem}>
                <Problem text={t("mobile.connectors.noTools", { name })} />
                {admin && item.server ? (
                  <Button
                    variant="primary"
                    wide
                    label={t("mobile.connectors.readAgain")}
                    loading={refresh.isPending}
                    disabled={refresh.isPending}
                    onPress={() => {
                      const server = item.server;
                      if (server)
                        refresh.mutate(server.id, {
                          onError: () => {
                            errorHaptic();
                            toast({ title: t("mobile.connectors.review.refreshFailed") });
                          },
                        });
                    }}
                  />
                ) : null}
              </View>
            ) : item.reconnectAdds.length > 0 ? (
              <Text variant="footnote" tone="muted" style={styles.lead}>
                {reconnectAddsText(t, item)}
              </Text>
            ) : null}
            <AgentLevelList connectionId={id} personal={Boolean(item.ownerUserId)} />
            {/* Everyone sees the accounts the app is installed on; only admins get its actions. */}
            {item.def?.id === "github" && !item.viaComposio ? (
              <GitHubAppGroup
                onConnectAccount={() => {
                  const def = item.def;
                  if (def) sheet.open(<ConnectSheet def={def} account />);
                }}
              />
            ) : null}
            {admin ? (
              <>
                <GroupedHeader>{t("connectors.tools")}</GroupedHeader>
                <GroupedList>
                  {/* One row: how many, and what waits on you under it, in the waiting color. */}
                  <GroupedRow
                    key="tools"
                    icon="bolt"
                    label={t("connectors.tools")}
                    {...(waiting > 0
                      ? {
                          below: (
                            <Text variant="footnote" style={[styles.bold, { color: c.amber }]}>
                              {t("mobile.connectors.toolsWait", { count: waiting })}
                            </Text>
                          ),
                        }
                      : {})}
                    value={String(item.tools)}
                    chevron
                    onPress={() => openTools(id)}
                  />
                </GroupedList>
                <GroupedHeader>{t("mobile.connectors.accountTitle")}</GroupedHeader>
                <GroupedList>
                  {/* Which account, and that it is in: the one row with no step behind it. */}
                  <GroupedRow
                    key="which"
                    label={item.account || item.label}
                    sub={t("mobile.connectors.connectedState")}
                  />
                  {actions
                    .filter((action) => action !== "rename")
                    .map((action) => (
                      <GroupedRow
                        key={action}
                        label={t(action === "add" ? "connectors.detail.addAccount" : "connectors.detail.reconnect")}
                        chevron
                        onPress={() =>
                          sheet.open(
                            item.def ? (
                              <ConnectSheet def={item.def} item={item} mode={action} />
                            ) : (
                              <AddressSheet item={item} mode={action} />
                            ),
                          )
                        }
                      />
                    ))}
                </GroupedList>
                {/* The request headers a server by address is also sent, by name: their values are never shown. */}
                {sent.length > 0 ? (
                  <GroupedFooter>{headerNamesText(t, "connectors.sendsToo", sent)}</GroupedFooter>
                ) : null}
                {item.custom && accountUnchecked([item.server]) ? (
                  <GroupedFooter>{t("connectFlow.replaceUnchecked")}</GroupedFooter>
                ) : null}
                <View style={styles.gap} />
                <DisconnectRow item={item} name={name} onDone={goBack} />
                {item.viaComposio ? (
                  <GroupedFooter>
                    {t("connectors.composio.disconnectNote", {
                      name: item.def ? connectorBrand(item.def) : name,
                    })}
                  </GroupedFooter>
                ) : null}
              </>
            ) : null}
          </View>
        ) : null}
      </Animated.ScrollView>
      {/* What the clear bar becomes once the page scrolls under it, as on an agent's page and Você. */}
      <CoverBarBackdrop y={y} from={0} to={12} height={headerHeight} />
    </View>
  );
}

/**
 * Renomear, pushed over a connection's screen: the account's name, which people and agents tell it apart by (its tools
 * keep their names), the field on one line with the line under it saying so; "Salvar" in the bar saves and goes back,
 * and back with a new name not saved asks first.
 */
export function RenameConnectionScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const rename = useRenameConnection(orgId);
  const item = connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
    (i) => i.id === id,
  );
  const loading = !item && (catalog.isPending || connections.isPending || servers.isPending);
  const failed = !item && (catalog.isError || connections.isError || servers.isError);
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = label ?? item?.label ?? "";
  const wanted = value.trim();
  const ready = Boolean(item) && wanted.length > 0 && wanted !== item?.label && !rename.isPending;
  const leave = useUnsavedGuard(Boolean(item) && label !== null && wanted !== item?.label);
  const save = () => {
    if (!item || !ready) return;
    rename.mutate(
      { id: item.id, label: wanted },
      {
        onSuccess: (saved) => {
          successHaptic();
          toast({ title: t("connectors.renamed", { name: saved.label }) });
          leave();
          goBack();
        },
        onError: (err) => {
          errorHaptic();
          setError(knownErrorText(t, err) ?? t("mobile.connectors.renameFailed"));
        },
      },
    );
  };
  return (
    <SettingsPage
      title={t("connectors.rename")}
      {...(item ? { subtitle: itemName(t, item) } : {})}
      action={{ label: t("common.save"), disabled: !ready, onPress: save }}
      locked={rename.isPending}
    >
      {item ? (
        <>
          <GroupedHeader>{t("connectFlow.name")}</GroupedHeader>
          <TextArea
            value={value}
            onChangeText={(v) => {
              setLabel(v);
              setError(null);
            }}
            multiline={false}
            minHeight={50}
            maxLength={80}
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel={t("connectFlow.name")}
          />
          {error ? (
            <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : (
            <GroupedFooter>{t("connectors.renameHelp")}</GroupedFooter>
          )}
        </>
      ) : loading ? (
        <SkeletonList rows={1} />
      ) : failed ? (
        <LoadFailed onRetry={() => void Promise.all([catalog.refetch(), connections.refetch(), servers.refetch()])} />
      ) : (
        <EmptyState size="inline" title={t("common.gone")} />
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { alignItems: "center", gap: 8, paddingHorizontal: 24, paddingBottom: 6 },
  center: { textAlign: "center" },
  bold: { fontWeight: "600" },
  // The pushed screens' 16-point margin (the connectors list and the settings screens use it too).
  body: { paddingHorizontal: 16 },
  problem: { gap: 12 },
  lead: { paddingHorizontal: 16, paddingTop: 12 },
  personal: { paddingHorizontal: 32, paddingTop: 4 },
  gap: { height: 24 },
  error: { paddingTop: 8, paddingHorizontal: 16 },
});
