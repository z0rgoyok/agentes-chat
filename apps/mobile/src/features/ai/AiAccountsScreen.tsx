import type { AccountOrderGroup, AiAccounts as AiAccountsView, Credential } from "@agenteschat/client";
import {
  keys,
  useAccountOrder,
  useAiAccounts,
  useAiStatus,
  useApi,
  useCredentials,
  useMachines,
  useMoveAccountInOrder,
  usePlatformKey,
  useSettings,
  useUpdateSettings,
} from "@agenteschat/client";
import {
  accountSub,
  accountTitle,
  againLogin,
  agentsToGive,
  endsOnClaude,
  identityUnknown,
  keyRemovalText,
  newestUsage,
  offersSignInAgain,
  onSeveralComputers,
  orderAccounts,
  orderMover,
  orderPlaces,
  ownSignIns,
  ownSignInTitle,
  signInNote,
  unnamedAccount,
} from "@agenteschat/client/lib/ai-accounts";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { errorText, keyRefusal } from "@agenteschat/client/lib/errors";
import { joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { agentAi, aiStateOf, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { settingsSectionNameKey, settingsSectionTextKey } from "@agenteschat/client/lib/personal-view";
import { planOf } from "@agenteschat/client/lib/plans";
import { keyCopiesLine, keyName, keyNamedAfterProvider, keySource, shownKeys } from "@agenteschat/client/lib/providers";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  InfoHint,
  Locked,
  ProviderLogo,
  SkeletonList,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { personalAiParts } from "../settings/logic";
import { chooseAction, Gap, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, usePullRefresh } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { errorHaptic, goBack, PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { overLimit, TextArea } from "../shared/TextArea";
import { PlanMeter } from "../usage/parts";
import { openKeyForAll } from "./KeyForAllScreen";
import { orderMoves, ownAccountRows } from "./logic";
import { openConnectAi } from "./NoAiCard";
import { alertKeyRefused, Note, openRenameAiAccount, PasteField, PlanHoldNote, usePlanHold } from "./parts";

/*
 * Contas de IA, as the web's Settings › Contas de IA (ADR 0059, ADR 0061), as the settings screens are: grouped lists
 * under their headers. "Seus planos" (its ⓘ says where a plan lives): first the sign-ins of the computers the person
 * connected ("Conta deste computador", the agents there think with them), then their own accounts on every computer,
 * each with its plan's meter and the agents it thinks for, renamed (on a screen of its own), signed in again (a new key
 * for a coding plan) on its plan's page of Connect an AI, given to one more agent where it thinks for all of them, or
 * disconnected here. An account a run may move to at a limit sits instead in its plan's "Ordem de uso" (ADR 0041
 * §6), numbered. "Conectar uma IA" comes after every account (the same picker as everywhere). Then the workspace's API
 * keys (admins), the default one, a key swapped (in a sheet) or deleted, and "Adicionar chave" ending theirs.
 */

type Account = AiAccountsView["accounts"][number];

/**
 * An account's actions (the web's row buttons): the system's action sheet on iOS, the app's sheet on Android, which
 * holds them all (Android's dialog kept three, and "Usar para …" for a fourth agent was lost).
 */
const choose = chooseAction;

/** An account's name, as the server keeps it. */
const NAME_LIMIT = { max: 40 };
/** No provider's key is shorter: a key cut short never goes. */
const KEY_MIN = 8;

export function AiAccountsScreen() {
  return (
    <SheetHostProvider>
      <AiAccounts />
    </SheetHostProvider>
  );
}

function AiAccounts() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  /** A computer's name in this workspace's words (a personal one's: its person's agents', ADR 0159). */
  const computerOf = (name: string) => computerNameOf(t, org?.name ?? "", name, isPersonal(org));
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const ai = useAiAccounts(orgId);
  const machines = useMachines(orgId);
  const dir = useDirectory();
  const meId = useMeId();
  const status = useAiStatus(orgId);
  const hold = usePlanHold(orgId, org);
  const order = useAccountOrder(orgId);
  const move = useMoveAccountInOrder(orgId);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);
  // A pull asks the plans for their usage again and reads the accounts and the keys again.
  const pull = usePullRefresh(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
    return Promise.allSettled([
      ai.refetch(),
      machines.refetch(),
      status.refetch(),
      order.refetch(),
      qc.invalidateQueries({ queryKey: keys.credentials(orgId) }),
    ]);
  });
  // The viewer's logins of one account (one per agent) are one row; disconnecting it removes every one of them.
  const owned = ownAccountRows(ai.data?.accounts ?? []);
  const rows = owned.map((o) => o.account);
  const ownOf = (a: Account) => owned.find((o) => o.account.id === a.id) ?? { logins: [a], signedOut: [], unknown: [] };
  const loginsOf = (a: Account) => ownOf(a).logins;
  const own = ownSignIns(ai.data);
  const several = onSeveralComputers(rows);
  const refetch = () => void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
  const failed = () => {
    errorHaptic();
    toast({ title: t("agentPage.work.failed"), icon: "x" });
  };

  // Renaming on a screen of its own, on every system (screens, not sheets): its field waits for the person's tap.
  const rename = (a: Account) => openRenameAiAccount(a.machineId, a.id);
  // Signing in again (a coding plan's new key) on its plan's page of Connect an AI, a screen with room for the keyboard:
  // that exact login, for one of the person's agents that thinks with it, else on its own.
  const signInAgain = (a: Account) => {
    const agentId = a.usedByIds?.find((id) => {
      const agent = dir.agentById.get(id);
      return agent !== undefined && (agent.ownerUserId === meId || isRightHand(agent));
    });
    openConnectAi({
      plan: planOfAccount(a),
      again: a.id,
      ...(a.email ? { email: a.email } : {}),
      ...(agentId ? { agentId } : {}),
    });
  };
  const names = (list: string[]) => joinNames(list, t);
  const machineOf = (a: Account) => machines.data?.find((m) => m.id === a.machineId);
  // One more of the person's agents thinks with an account made for all of them there: no sign-in.
  const give = (a: Account, agent: { id: string; name: string }) =>
    api.agents.setBrain(orgId, agent.id, { brain: a.kind, account: a.id }).then(() => {
      successHaptic();
      toast({ title: t("aiAccounts.done.savedAgent", { agent: agent.name, label: a.label }), icon: "check" });
      refetch();
      for (const key of [keys.agents(orgId), keys.aiStatus(orgId), keys.agentBrain(orgId, agent.id)])
        void qc.invalidateQueries({ queryKey: key });
    }, failed);
  const remove = (a: Account) =>
    Alert.alert(
      t("aiAccounts.page.disconnectTitle", { label: a.label }),
      [
        a.usedBy.length > 0
          ? t("aiAccounts.page.disconnectAgents", {
              count: a.usedBy.length,
              agents: names(a.usedBy),
              computer: computerOf(a.computer),
            })
          : t("aiAccounts.page.disconnectNone", { computer: computerOf(a.computer) }),
        ...(endsOnClaude(a, machineOf(a)) ? [t("aiAccounts.page.revokeOnClaude")] : []),
      ].join(" "),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("aiAccounts.page.disconnect"),
          style: "destructive",
          onPress: () =>
            Promise.all(loginsOf(a).map((l) => api.machines.removeAccount(orgId, l.machineId, l.id))).then(
              () => {
                successHaptic();
                toast({ title: t("aiAccounts.page.disconnected", { label: a.label }), icon: "check" });
                refetch();
                void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
              },
              () => {
                // Some logins may be gone already: the list is read again either way.
                failed();
                refetch();
              },
            ),
        },
      ],
    );
  // An order of one account shows nothing of an order; an account signed in once per agent is one place in it.
  const groups = (order.data?.groups ?? []).filter((g) => orderAccounts(g.accounts).length > 1);
  const placed = new Set(groups.flatMap((g) => g.accounts.map((a) => a.id)));
  const severalOrders = new Set(groups.map((g) => g.machineId)).size > 1;
  const put = (accountId: string, index: number | null) => {
    if (index === null) return;
    move.mutate(
      { accountId, index },
      {
        onSuccess: () => successHaptic(),
        onError: (e) => {
          errorHaptic();
          toast({ title: errorText(t, e), icon: "x" });
        },
      },
    );
  };
  /** Move up and Move down for an account of `g`, when the viewer may move it: none at that end. */
  const moves = (g: AccountOrderGroup, a: OrderAccount) =>
    orderMoves(g.accounts, a).map((m) => ({
      label: t(m.step < 0 ? "contextMenu.moveUp" : "contextMenu.moveDown"),
      onPress: () => put(orderMover(g.accounts, a.id), m.index),
    }));
  const actions = (a: Account, g?: AccountOrderGroup) => {
    const plan = planOf(a.provider);
    const placedAs = g?.accounts.find((x) => x.id === a.id);
    const out = loginsOf(a).some(offersSignInAgain);
    const toGive = meId
      ? agentsToGive({
          account: a,
          agents: dir.agents,
          machine: machineOf(a),
          viewerId: meId,
          onKey: (id) => agentAi(dir.agentById.get(id), aiStateOf(status.data, id)) === "key",
        })
      : [];
    choose(
      accountTitle(t, a),
      [
        ...(g && placedAs ? moves(g, placedAs) : []),
        ...toGive.map((g) => ({
          label: t("aiAccounts.page.useFor", agentGrammar(g.name)),
          onPress: () => void give(a, g),
        })),
        ...(plan && a.status === "active"
          ? [{ label: t("aiAccounts.page.useAll"), onPress: () => openKeyForAll(a.machineId, a.id) }]
          : []),
        { label: t("aiAccounts.page.rename"), onPress: () => rename(a) },
        ...(out || plan
          ? [
              {
                label: plan ? t("aiAccounts.page.newKey") : t("aiAccounts.page.signInAgain"),
                onPress: () => signInAgain(againLogin(ownOf(a)) ?? a),
              },
            ]
          : []),
        { label: t("aiAccounts.page.disconnect"), destructive: true, onPress: () => remove(a) },
      ],
      t("common.cancel"),
    );
  };

  /**
   * One of the viewer's accounts: its meter and actions, with its place `n` when it is in an order (`g`), blank (null)
   * when a run never moves to it.
   */
  const accountRow = (a: Account, g?: AccountOrderGroup, n?: number | null) => {
    const plan = planOf(a.provider);
    // Every login of the account: one agent's sign-in may have ended while the row goes by another's.
    const note = signInNote(t, ownOf(a), Boolean(plan));
    const off = ownOf(a).signedOut.length === loginsOf(a).length;
    const facts = [
      accountSub(a) ??
        (a.keyHint
          ? t("aiAccounts.page.keyEnds", { hint: a.keyHint })
          : identityUnknown(a, machineOf(a))
            ? t("aiAccounts.page.identityUnknown")
            : null),
      several ? t("aiAccounts.page.on", { computer: computerOf(a.computer) }) : null,
      a.usedBy.length > 0
        ? t("aiAccounts.page.usedBy", { count: a.usedBy.length, agents: names(a.usedBy) })
        : t("aiAccounts.page.noAgent"),
    ].filter(Boolean);
    return (
      <GroupedRow
        key={a.id}
        leading={
          n !== undefined ? (
            <Text variant="callout" tone="muted" style={styles.place}>
              {n ?? ""}
            </Text>
          ) : (
            <ProviderLogo id={a.provider ?? a.kind} size="sm" off={off} />
          )
        }
        leadingSaid={n?.toString()}
        label={accountTitle(t, a)}
        faint={unnamedAccount(a)}
        sub={facts.join(" · ")}
        subLines={2}
        more
        disabled={g !== undefined && move.isPending}
        onPress={() => actions(a, g)}
        below={
          note || a.usage || (plan && !plan.usage) ? (
            <View style={styles.below}>
              {note ? <Note icon={note.state === "out" ? "x" : "info"}>{note.text}</Note> : null}
              {a.usage ? (
                <PlanMeter usage={a.usage} compact />
              ) : plan && !plan.usage ? (
                <Text variant="footnote" tone="faint">
                  {t("aiAccounts.usage.notShared", { maker: plan.maker })}
                </Text>
              ) : null}
            </View>
          ) : undefined
        }
      />
    );
  };

  // Under a hold its note says what comes first: an invitation to connect a plan would contradict it.
  const none = !hold && ai.isSuccess && rows.length === 0 && own.length === 0;
  const adds = !none && !hold;
  const connect =
    adds && ai.isSuccess ? (
      <GroupedRow icon="plus" label={t("aiAccounts.page.connect")} onPress={() => openConnectAi()} />
    ) : null;
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t(isPersonal(org) ? "settings.section.keysPersonal" : "mobile.ai.row")}
        solid={false}
        grouped
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <GroupedHeader
          hint={{ name: t("common.about", { label: t("aiAccounts.page.title") }), text: t("aiAccounts.page.hint") }}
        >
          {t("aiAccounts.page.title")}
        </GroupedHeader>
        {ai.isLoading ? <SkeletonList rows={2} /> : null}
        {ai.isError && !ai.data ? <LoadFailed onRetry={() => void ai.refetch()} /> : null}
        {none ? (
          <FirstUse place="ai" size="panel" acts label={t("aiAccounts.page.connect")} onPress={() => openConnectAi()} />
        ) : null}
        {/* One list, as Settings' own: the computers' sign-ins, the person's accounts not in an order, then the way to
            one more, which follows the orders when there are any. The mark sits in the rows' leading column and the
            hairlines start at the words. */}
        <GroupedList>
          {own.map((o) => (
            <GroupedRow
              key={o.key}
              leading={<ProviderLogo id={o.kind} size="sm" />}
              label={ownSignInTitle(t, o)}
              sub={t("aiAccounts.page.ownOn", { computer: o.computer })}
              below={
                o.usage ? (
                  <View style={styles.below}>
                    <PlanMeter usage={o.usage} compact />
                  </View>
                ) : undefined
              }
            />
          ))}
          {rows.filter((a) => !placed.has(a.id)).map((a) => accountRow(a))}
          {groups.length === 0 ? connect : null}
        </GroupedList>
        {hold ? <PlanHoldNote org={org} inset /> : null}
        {groups.map((g) => (
          <OrderSection
            key={`${g.machineId}:${g.kind}`}
            group={g}
            computer={severalOrders ? computerOf(g.computer) : null}
          >
            {orderAccounts(g.accounts).map((block, i) => {
              const a = block.find((l) => rows.some((r) => r.id === l.id)) ?? block[0];
              if (!a) return null;
              const n = orderPlaces(g.accounts)[i] ?? null;
              const mine = rows.find((r) => r.id === a.id);
              if (mine) return accountRow(mine, g, n);
              const them = moves(g, a);
              const usage = newestUsage(block);
              return (
                <GroupedRow
                  key={a.id}
                  leading={
                    <Text variant="callout" tone="muted" style={styles.place}>
                      {n ?? ""}
                    </Text>
                  }
                  leadingSaid={n?.toString()}
                  label={accountTitle(t, a)}
                  sub={a.ownerName ?? undefined}
                  more={them.length > 0}
                  disabled={move.isPending}
                  {...(them.length > 0 ? { onPress: () => choose(accountTitle(t, a), them, t("common.cancel")) } : {})}
                  below={
                    usage ? (
                      <View style={styles.below}>
                        <PlanMeter usage={usage} compact />
                      </View>
                    ) : undefined
                  }
                />
              );
            })}
          </OrderSection>
        ))}
        {ai.isSuccess && order.isError && !order.data ? <LoadFailed onRetry={() => void order.refetch()} /> : null}
        {groups.length > 0 && connect ? (
          <>
            <Gap />
            <GroupedList>{connect}</GroupedList>
          </>
        ) : null}
        {can(org, "manage_credentials") ? <KeysSection locale={i18n.language} /> : null}
        <PersonalParts />
      </ScrollView>
    </View>
  );
}

type OrderAccount = AccountOrderGroup["accounts"][number];

/**
 * "Ordem de uso" (ADR 0041 §6), as the web's groups in IA e uso: one computer's Claude or ChatGPT accounts a run goes
 * through at a limit, numbered first to last, with the plan's terms on a quiet line. Whoever may move an account (its
 * owner or an admin) moves it with Move up and Move down in its ⋯.
 */
function OrderSection({
  group,
  computer,
  children,
}: {
  group: AccountOrderGroup;
  computer: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const plan = t(`aiAccounts.connect.${group.kind}`);
  const title = t("usageViews.order.title", { plan });
  return (
    <View>
      <GroupedHeader hint={{ name: t("common.about", { label: title }), text: t("usageViews.order.hint") }}>
        {computer ? `${title} ${t("aiAccounts.page.on", { computer })}` : title}
      </GroupedHeader>
      <View style={styles.terms}>
        <InfoHint
          name={t("common.about", { label: t("usageViews.order.termsLabel", { plan }) })}
          text={t("usageViews.order.termsHint", { plan })}
          variant="footnote"
        >
          <Text variant="footnote" tone="muted">
            {t("usageViews.order.terms", { plan })}
          </Text>
        </InfoHint>
      </View>
      <GroupedList>{children}</GroupedList>
    </View>
  );
}

/**
 * AI and apps in a personal workspace (ADR 0159 §3): Connectors and MCPs and Skills at the foot of the AI accounts,
 * those this person opens, each a row to its own screen as in Settings. Nothing in a team's workspace.
 */
function PersonalParts() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const parts = isPersonal(org) ? personalAiParts(org) : [];
  if (parts.length === 0) return null;
  return (
    <>
      <Gap />
      <GroupedList>
        {parts.map((s) => (
          <GroupedRow
            key={s.id}
            icon={s.icon}
            label={t(settingsSectionNameKey(org, s.id))}
            sub={t(settingsSectionTextKey(org, s.id))}
            subLines={2}
            chevron
            onPress={() => router.push(s.href as never)}
          />
        ))}
      </GroupedList>
    </>
  );
}

/** The workspace's API keys (the web's "Chaves de provedor"): the default one, a key swapped or deleted. */
function KeysSection({ locale }: { locale: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const held = usePlanHold(orgId, org) !== null;
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const credentials = useCredentials(orgId);
  const settings = useSettings(orgId);
  const update = useUpdateSettings(orgId);
  const all = (credentials.data ?? []).filter((k) => !k.revokedAt);
  const live = shownKeys(credentials.data ?? []);
  const refetch = () => void qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
  const failed = (error: unknown) => {
    errorHaptic();
    const refusal = keyRefusal(t, error);
    if (refusal) alertKeyRefused(t, refusal);
    else toast({ title: errorText(t, error), icon: "x" });
  };
  const platform = usePlatformKey(orgId);
  const sheet = useSheet();

  // Replacing a key in the app's own sheet, on every system: the new key hidden as it is typed or pasted. A refused
  // key keeps the sheet open, with what it said.
  const rotate = (k: Credential) =>
    sheet.open(
      <KeyPrompt
        title={t("settings.rotateTitle", { label: k.label })}
        intro={t("settings.rotateHelp")}
        submitLabel={t("settings.saveKey")}
        onSubmit={(apiKey) =>
          api.agents.rotateCredential(orgId, k.id, { apiKey }).then((saved) => {
            successHaptic();
            toast({
              title:
                saved.check === "unchecked"
                  ? t("connectAi.key.savedUnchecked", { provider: keyName(k) })
                  : t("settings.rotated"),
              icon: "check",
            });
            refetch();
            sheet.close();
          }, failed)
        }
      />,
    );
  const remove = (k: Credential) =>
    Alert.alert(t("settings.removeTitle", { label: k.label }), keyRemovalText(t, k, all, platform.data === true), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.remove"),
        style: "destructive",
        onPress: () =>
          api.agents.removeCredential(orgId, k.id, true, true).then(() => {
            successHaptic();
            refetch();
            void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
            void qc.invalidateQueries({ queryKey: keys.agentPages(orgId) });
          }, failed),
      },
    ]);
  const removeCopies = (k: Credential) =>
    Alert.alert(t("settings.removeCopiesTitle", { label: k.label }), t("settings.removeCopiesText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.removeCopies"),
        onPress: () =>
          api.agents.removeCredentialCopies(orgId, k.id).then(({ removed }) => {
            successHaptic();
            toast({ title: t("settings.copiesRemoved", { count: removed }), icon: "check" });
            refetch();
            void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
            void qc.invalidateQueries({ queryKey: keys.agentPages(orgId) });
          }, failed),
      },
    ]);
  const actions = (k: Credential, isDefault: boolean) =>
    choose(
      k.label,
      [
        ...(isDefault
          ? []
          : [
              {
                label: t("settings.makeDefault"),
                // The "Padrão" moves to its row; a refusal says why.
                onPress: () => update.mutate({ defaultCredentialId: k.id }, { onError: failed }),
              },
            ]),
        ...(held ? [] : [{ label: t("settings.rotate"), onPress: () => rotate(k) }]),
        ...(k.copies ? [{ label: t("settings.removeCopies"), onPress: () => removeCopies(k) }] : []),
        { label: t("settings.remove"), destructive: true, onPress: () => remove(k) },
      ],
      t("common.cancel"),
    );

  return (
    <>
      <GroupedHeader>{t("settings.keysTitle")}</GroupedHeader>
      {credentials.isLoading ? <SkeletonList rows={2} /> : null}
      {credentials.isError && !credentials.data ? <LoadFailed onRetry={() => void credentials.refetch()} /> : null}
      <GroupedList>
        {live.map((k) => {
          const isDefault = settings.data?.defaultCredentialId === k.id;
          return (
            <GroupedRow
              key={k.id}
              leading={<ProviderLogo id={k.provider} size="sm" />}
              label={k.label}
              sub={[
                keyNamedAfterProvider(k) ? null : keySource(k),
                t("settings.keyEndsIn", { hint: k.keyHint }),
                t("settings.keyAdded", { when: relativeTime(t, locale, k.createdAt) }),
                keyCopiesLine(t, k),
              ]
                .filter(Boolean)
                .join(" · ")}
              subLines={2}
              value={isDefault ? t("settings.default") : undefined}
              more
              onPress={() => actions(k, isDefault)}
            />
          );
        })}
        {credentials.isSuccess && !held ? (
          <GroupedRow icon="plus" label={t("settings.addKey")} onPress={() => openConnectAi({ intent: "api_key" })} />
        ) : null}
      </GroupedList>
      {held ? (
        <PlanHoldNote org={org} keys inset />
      ) : credentials.isSuccess ? (
        <GroupedFooter>{live.length === 0 ? t("settings.noKeys") : t("settings.keysSubtitle")}</GroupedFooter>
      ) : null}
    </>
  );
}

/**
 * One key asked in a sheet, as `PromptForm` asks one text: the title, a line of help, the key (hidden, with Paste while
 * the field is empty) and one button that waits for the save. Anything shorter than a key never goes.
 */
function KeyPrompt({
  title,
  intro,
  submitLabel,
  onSubmit,
}: {
  title: string;
  intro: string;
  submitLabel: string;
  onSubmit: (key: string) => Promise<unknown>;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = key.trim().length >= KEY_MIN;
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onSubmit(key.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SheetTitle title={title} />
      <Text variant="body" tone="muted">
        {intro}
      </Text>
      <Locked when={busy}>
        <PasteField
          value={key}
          onChangeText={setKey}
          onPasted={setKey}
          label={title}
          secret
          onSubmit={() => void submit()}
        />
      </Locked>
      <Button
        variant="primary"
        wide
        label={submitLabel}
        loading={busy}
        disabled={!ready}
        onPress={() => void submit()}
      />
    </>
  );
}

/**
 * Renaming an AI account, pushed from its row's actions: what the name is for, the name (one line, however it is typed
 * or pasted), Save in the bar. The field waits for a tap: a screen that opens never raises the keyboard by itself.
 */
export function RenameAiAccountScreen({ machineId, accountId }: { machineId: string; accountId: string }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const ai = useAiAccounts(orgId);
  const account = ai.data?.accounts.find((a) => a.id === accountId && a.machineId === machineId);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The automatic name ("Claude 2") is no name of theirs: the field starts empty, showing the email.
  const given = account?.named === true ? account.label : "";
  const name = (draft ?? given).replace(/\s+/g, " ").trim();
  const ready = Boolean(account) && name !== "" && name !== given && !overLimit(name, NAME_LIMIT);
  const leave = useUnsavedGuard(draft !== null && name !== given && !busy);
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api.machines.renameAccount(orgId, machineId, accountId, name);
      leave();
      successHaptic();
      toast({ title: t("aiAccounts.page.renamed", { label: name }), icon: "check" });
      // Every list that shows it reads it again: the accounts, each agent's AI (`keys.agentBrain`'s prefix), usage.
      for (const key of [keys.aiAccounts(orgId), keys.planUsage(orgId), ["org", orgId, "agent"]])
        void qc.invalidateQueries({ queryKey: key });
      goBack();
    } catch {
      errorHaptic();
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsPage
      title={
        account ? t("aiAccounts.page.renameTitle", { label: accountTitle(t, account) }) : t("aiAccounts.page.rename")
      }
      action={{ label: t("common.save"), disabled: !ready, onPress: () => void save() }}
      busy={busy}
    >
      {ai.isPending ? (
        <SkeletonList rows={1} />
      ) : !account ? (
        <LoadFailed onRetry={() => void ai.refetch()} />
      ) : (
        <>
          <GroupedHeader>{t("aiAccounts.page.nameLabel")}</GroupedHeader>
          {/* A field row of the page, the list its surface, as every field of the settings pages. */}
          <GroupedList>
            <TextArea
              value={draft ?? given}
              onChangeText={setDraft}
              multiline={false}
              minHeight={50}
              limit={NAME_LIMIT}
              returnKeyType="done"
              onSubmitEditing={() => void save()}
              placeholder={account.email ?? t("aiAccounts.rename.placeholder")}
              accessibilityLabel={t("aiAccounts.page.nameLabel")}
              style={styles.bare}
            />
          </GroupedList>
          <GroupedFooter>{t("aiAccounts.done.name")}</GroupedFooter>
        </>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // Inside a grouped list: the list is its surface.
  bare: { borderWidth: 0, borderRadius: 0, backgroundColor: "transparent" },
  screen: { flex: 1 },
  // The settings screens' side margin: the groups on the same 16 pt edge as everywhere else.
  in: { paddingHorizontal: 16, paddingTop: 8 },
  below: { gap: 8, marginTop: 6 },
  // On the header's edge, above the group like a second header line.
  terms: { paddingHorizontal: 16, paddingBottom: 8, marginTop: -2 },
  place: { minWidth: 24, textAlign: "center", fontVariant: ["tabular-nums"], fontWeight: "600" },
});
