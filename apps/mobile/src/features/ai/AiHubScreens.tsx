import type { AccountAudienceMode, AccountOrderGroup, AiHub, AiHubAccount } from "@agenteschat/client";
import {
  useAccountOrder,
  useAiAccounts,
  useMembers,
  useMoveAccountInOrder,
  useRoles,
  useSetAccountPermissions,
  useSetKeyFallback,
} from "@agenteschat/client";
import { orderDrop, orderStep } from "@agenteschat/client/lib/ai-accounts";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { planOf } from "@agenteschat/client/lib/plans";
import { isEveryone, roleName } from "@agenteschat/client/lib/roles";
import { PLAN_TONE } from "@agenteschat/ui/plan-state";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  ProviderLogo,
  SkeletonList,
  Text,
  type TextTone,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { ReorderList } from "@/ui/ReorderList";
import { chooseAction, SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { errorHaptic, successHaptic } from "../shared/parts";
import { PlanMeter } from "../usage/parts";
import { openKeyForAll } from "./AgentSetupScreen";
import { useAccountActions } from "./AiAccountsScreen";
import {
  AUDIENCE_MODES,
  audienceLabel,
  audienceOf,
  hubAccounts,
  hubLine,
  hubState,
  hubTitle,
  mayChange,
  type OrderRow,
  orderDropOf,
  orderRows,
  PERMISSIONS,
  type Permission,
  type StateTone,
} from "./hub";
import { openConnectAi } from "./NoAiCard";

/*
 * "Contas de IA" on the phone (the web's IA e uso › Contas de IA): every plan account of the workspace in one calm list
 * (name, then plan and owner, then its state on a line of its own), each opening its detail (Limites, Permissões, ⋯),
 * and the order of use on its own screen, dragged by its handles or moved up and down.
 */

export const openAiAccount = (accountId: string) => router.push(`/ai-account/${accountId}` as never);
export const openAccountOrder = () => router.push("/ai-account-order" as never);
const openAudience = (accountId: string, permission: Permission, mode: "roles" | "people") =>
  router.push(`/ai-account-audience/${accountId}?permission=${permission}&mode=${mode}` as never);

const loginsOf = (hub: Pick<AiHub, "accounts">, a: Pick<AiHubAccount, "id" | "sameAs">) =>
  hub.accounts.filter((l) => (l.sameAs ?? l.id) === (a.sameAs ?? a.id));

const TONE: Record<StateTone, TextTone | null> = { danger: null, amber: null, muted: "muted" };

/** An account's state on its own line, in the color its level has (red at a limit, amber close to it or signed out). */
function StateLine({ text, tone }: { text: string; tone: StateTone }) {
  const c = useColors();
  const color = tone === "danger" ? c[PLAN_TONE.limited] : tone === "amber" ? c[PLAN_TONE.almost] : undefined;
  return (
    <Text variant="footnote" tone={TONE[tone] ?? "muted"} numberOfLines={1} style={color ? { color } : null}>
      {text}
    </Text>
  );
}

/** The hub's list on Contas de IA: its header with Ordem de uso, the accounts, then Conectar uma IA. */
export function HubList({ hub, connect, before }: { hub: AiHub; connect: boolean; before?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const meId = useMeId();
  const accounts = hubAccounts(hub, meId ?? "");
  const orders = hub.order.length > 0 || hub.canConfigure;
  return (
    <>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("mobile.aiHub.accounts") }), text: t("mobile.aiHub.accountsHint") }}
        aside={
          orders ? <Button variant="text" size="sm" label={t("mobile.aiHub.order")} onPress={openAccountOrder} /> : null
        }
      >
        {t("mobile.aiHub.accounts")}
      </GroupedHeader>
      <GroupedList>
        {before}
        {accounts.map((a) => {
          const state = hubState(t, i18n.language, a);
          return (
            <GroupedRow
              key={a.id}
              leading={<ProviderLogo id={a.provider ?? a.kind} size="sm" off={a.status !== "active"} />}
              label={hubTitle(t, a)}
              sub={hubLine(t, a)}
              {...(state ? { below: <StateLine {...state} /> } : {})}
              chevron
              onPress={() => openAiAccount(a.id)}
            />
          );
        })}
        {hub.canManageKeys
          ? null
          : hub.keys.map((k) => (
              <GroupedRow
                key={k.id}
                leading={<ProviderLogo id={k.provider} size="sm" />}
                label={k.label}
                sub={[t("mobile.aiHub.choice.key"), k.isDefault ? t("mobile.aiHub.choice.keyDefault") : null]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ))}
        {connect ? (
          <GroupedRow icon="plus" label={t("aiAccounts.page.connect")} onPress={() => openConnectAi()} />
        ) : null}
      </GroupedList>
    </>
  );
}

/** Reads the hub once for the screens under it; null while it loads or on an older server. */
function useHub() {
  const { orgId } = useOrg();
  const ai = useAiAccounts(orgId);
  return { ai, hub: ai.data?.hub ?? null };
}

/**
 * An account's detail, from its row: who it is (maker, plan, owner), its limits, its three permissions each with its
 * ⓘ, and the ⋯ with Renomear, Entrar de novo, Usar em todos os agentes and Desconectar for whoever may.
 */
export function AiAccountScreen({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const toast = useToast();
  const { ai, hub } = useHub();
  const dir = useDirectory();
  const roles = useRoles(orgId);
  const set = useSetAccountPermissions(orgId);
  const a = hub?.accounts.find((x) => x.id === accountId || x.sameAs === accountId);
  const logins = hub && a ? loginsOf(hub, a) : [];
  const { remove, rename, signInAgain } = useAccountActions((x) => ({
    logins: logins.length > 0 ? logins : [x],
    signedOut: logins.filter((l) => l.status === "signed_out"),
    unknown: [],
  }));
  if (!hub || !a)
    return (
      <SettingsPage title={t("aiAccounts.page.title")}>
        {ai.isPending ? <SkeletonList rows={3} /> : <LoadFailed onRetry={() => void ai.refetch()} />}
      </SettingsPage>
    );
  const plan = planOf(a.provider);
  const owner = a.mine ? null : firstName(a.ownerName ?? "");
  const names = {
    role: (id: string) => {
      const r = roles.data?.roles.find((x) => x.id === id);
      return r ? roleName(t, r) : undefined;
    },
    person: (id: string) => dir.memberById.get(id)?.name,
  };
  const modeLabel = (mode: AccountAudienceMode, permission: Permission) =>
    mode === "roles" || mode === "people"
      ? t(`mobile.aiHub.audience.${mode}`)
      : audienceLabel(t, permission, { mode, userIds: [], roleIds: [] }, owner, names);
  const choose = async (permission: Permission) => {
    const now = a.permissions[permission];
    const picked = await pickOne({
      title: t(`mobile.aiHub.${permission}`),
      options: AUDIENCE_MODES.map((mode) => ({ key: mode, label: modeLabel(mode, permission) })),
      value: now.mode,
      lit: true,
    });
    if (picked === null) return;
    const mode = picked as AccountAudienceMode;
    if (mode === "roles" || mode === "people") return openAudience(a.id, permission, mode);
    if (mode === now.mode) return;
    set.mutate(
      { accountId: a.id, permissions: { [permission]: audienceOf(mode, now) } },
      {
        onSuccess: () => successHaptic(),
        onError: (e) => {
          errorHaptic();
          toast({ title: errorText(t, e), icon: "x" });
        },
      },
    );
  };
  const menu = [
    ...(a.rights.canManage
      ? [{ label: t("aiAccounts.page.rename"), icon: "pen" as const, sf: "pencil" as const, onPress: () => rename(a) }]
      : []),
    ...(a.mine && (a.status === "signed_out" || plan)
      ? [
          {
            label: plan ? t("aiAccounts.page.newKey") : t("aiAccounts.page.signInAgain"),
            icon: "replay" as const,
            sf: "arrow.clockwise" as const,
            onPress: () => signInAgain(a),
          },
        ]
      : []),
    ...(plan && a.rights.canUse && a.status === "active"
      ? [
          {
            label: t("aiAccounts.page.useAll"),
            icon: "members" as const,
            sf: "person.2" as const,
            onPress: () => openKeyForAll(a.machineId, a.id),
          },
        ]
      : []),
    ...(a.rights.canManage
      ? [
          {
            label: t("aiAccounts.page.disconnect"),
            icon: "trash" as const,
            sf: "trash" as const,
            destructive: true,
            onPress: () => remove(a),
          },
        ]
      : []),
  ];
  return (
    <SettingsPage
      title={hubTitle(t, a)}
      subtitle={hubLine(t, a, true)}
      {...(menu.length > 0
        ? {
            actions: [
              {
                icon: "more",
                sf: "ellipsis",
                label: t("mobile.chat.options"),
                onPress: () => chooseAction(hubTitle(t, a), menu, t("common.cancel")),
                menu,
              },
            ],
          }
        : {})}
      locked={set.isPending}
    >
      <GroupedHeader>{t("mobile.aiHub.limits")}</GroupedHeader>
      <GroupedList>
        <View style={styles.meter}>
          {a.usage ? (
            <PlanMeter usage={a.usage} />
          ) : (
            <Text variant="footnote" tone="muted">
              {a.status !== "active"
                ? t("usageViews.signedOut")
                : t("aiAccounts.usage.notShared", { maker: plan?.maker ?? t(`aiAccounts.connect.${a.kind}`) })}
            </Text>
          )}
        </View>
      </GroupedList>
      <GroupedHeader>{t("mobile.aiHub.permissions")}</GroupedHeader>
      <GroupedList>
        {PERMISSIONS.map((p) => (
          <GroupedRow
            key={p}
            label={t(`mobile.aiHub.${p}`)}
            sub={t(`mobile.aiHub.${p}Sub`)}
            hint={{ name: t("common.about", { label: t(`mobile.aiHub.${p}`) }), text: t(`mobile.aiHub.${p}Hint`) }}
            value={audienceLabel(t, p, a.permissions[p], owner, names)}
            menu
            disabled={!mayChange(a, p) || set.isPending}
            onPress={() => void choose(p)}
          />
        ))}
      </GroupedList>
    </SettingsPage>
  );
}

/**
 * The roles or the people of a permission (Cargos…, Pessoas…), each checked or not; Salvar keeps them, at least one.
 */
export function AccountAudienceScreen({
  accountId,
  permission,
  mode,
}: {
  accountId: string;
  permission: Permission;
  mode: "roles" | "people";
}) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const toast = useToast();
  const { ai, hub } = useHub();
  const roles = useRoles(orgId);
  const members = useMembers(orgId);
  const set = useSetAccountPermissions(orgId);
  const a = hub?.accounts.find((x) => x.id === accountId || x.sameAs === accountId);
  const now = a?.permissions[permission];
  const saved = now?.mode === mode ? (mode === "roles" ? now.roleIds : now.userIds) : [];
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const chosen = picked ?? new Set(saved);
  const options =
    mode === "roles"
      ? (roles.data?.roles ?? []).filter((r) => !isEveryone(r)).map((r) => ({ id: r.id, label: roleName(t, r) }))
      : (members.data ?? []).filter((m) => m.userId !== a?.ownerId).map((m) => ({ id: m.userId, label: m.name }));
  const loading = ai.isPending || (mode === "roles" ? roles.isPending : members.isPending);
  const save = () => {
    if (!a || !now || chosen.size === 0) return;
    const ids = [...chosen];
    set.mutate(
      {
        accountId: a.id,
        permissions: {
          [permission]: { mode, userIds: mode === "people" ? ids : [], roleIds: mode === "roles" ? ids : [] },
        },
      },
      {
        onSuccess: () => {
          successHaptic();
          router.back();
        },
        onError: (e) => {
          errorHaptic();
          toast({ title: errorText(t, e), icon: "x" });
        },
      },
    );
  };
  return (
    <SettingsPage
      title={t(mode === "roles" ? "mobile.aiHub.pickRoles" : "mobile.aiHub.pickPeople")}
      subtitle={t(`mobile.aiHub.${permission}`)}
      action={{ label: t("common.save"), disabled: chosen.size === 0 || !a, onPress: save }}
      busy={set.isPending}
    >
      {loading ? (
        <SkeletonList rows={4} />
      ) : !a ? (
        <LoadFailed onRetry={() => void ai.refetch()} />
      ) : (
        <>
          <GroupedList>
            {options.map((o) => (
              <GroupedRow
                key={o.id}
                label={o.label}
                checked={chosen.has(o.id)}
                onPress={() =>
                  setPicked(() => {
                    const next = new Set(chosen);
                    if (next.has(o.id)) next.delete(o.id);
                    else next.add(o.id);
                    return next;
                  })
                }
              />
            ))}
          </GroupedList>
          {chosen.size === 0 ? <GroupedFooter>{t("mobile.aiHub.pickNone")}</GroupedFooter> : null}
        </>
      )}
    </SettingsPage>
  );
}

/**
 * Ordem de uso: the accounts of each AI on each computer, numbered, in the order agents go through them at a limit;
 * each held by its handle and dragged, or moved up and down from its menu (and VoiceOver's actions). A signed-out
 * account is at the end, skipped. Under them, admins' switch to go on with the API key after the last plan.
 */
export function AccountOrderScreen() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const toast = useToast();
  const order = useAccountOrder(orgId);
  const move = useMoveAccountInOrder(orgId);
  const fallback = useSetKeyFallback(orgId);
  // A drop shows at once, before the server answers: the group's rows as the person left them.
  const [draft, setDraft] = useState<{ group: string; rows: OrderRow[] } | null>(null);
  const failed = (e: unknown) => {
    errorHaptic();
    toast({ title: errorText(t, e), icon: "x" });
  };
  const put = (g: AccountOrderGroup, id: string, index: number | null, rows?: OrderRow[]) => {
    if (index === null) return;
    if (rows) setDraft({ group: groupKey(g), rows });
    move.mutate(
      { accountId: id, index },
      {
        onSuccess: () => successHaptic(),
        onError: failed,
        onSettled: () => setDraft(null),
      },
    );
  };
  const groups = order.data?.groups ?? [];
  return (
    <SettingsPage title={t("mobile.aiHub.order")} onRefresh={() => order.refetch()}>
      <GroupedFooter>{t("mobile.aiHub.orderSub")}</GroupedFooter>
      {order.isPending ? <SkeletonList rows={3} /> : null}
      {order.isError && !order.data ? <LoadFailed onRetry={() => void order.refetch()} /> : null}
      {order.isSuccess && groups.length === 0 ? <GroupedFooter>{t("mobile.aiHub.noOrder")}</GroupedFooter> : null}
      {groups.map((g) => {
        const rows = draft?.group === groupKey(g) ? draft.rows : orderRows(g);
        const placed = rows.filter((r) => r.place !== null).length;
        const plan = t(`aiAccounts.connect.${g.kind}`);
        return (
          <View key={groupKey(g)}>
            <GroupedHeader
              hint={{
                name: t("common.about", { label: t("usageViews.order.termsLabel", { plan }) }),
                text: t("common.joinSentences", {
                  a: t("usageViews.order.hint"),
                  b: t("usageViews.order.termsHint", { plan }),
                }),
              }}
            >
              {t("mobile.aiHub.orderGroup", { plan, computer: g.computer })}
            </GroupedHeader>
            <GroupedList>
              <ReorderList
                items={rows}
                keyOf={(r) => r.account.id}
                movable={placed}
                canMove={(r) => r.account.canMove}
                disabled={move.isPending}
                handleLabel={(r) => t("usageViews.order.move", { name: hubTitle(t, r.account), n: r.place ?? "" })}
                onMove={(from, to) => {
                  const drop = orderDropOf(rows, from, to);
                  if (!drop) return;
                  const next = [...rows];
                  const [moved] = next.splice(from, 1);
                  if (moved) next.splice(to, 0, moved);
                  put(
                    g,
                    drop.id,
                    orderDrop(g.accounts, drop.id, drop.onto, drop.where),
                    next.map((r, i) => (r.place === null ? r : { ...r, place: i + 1 })),
                  );
                }}
                renderItem={(r) => (
                  <OrderAccountRow
                    row={r}
                    locale={i18n.language}
                    disabled={move.isPending}
                    steps={
                      r.account.canMove && r.place !== null
                        ? ([-1, 1] as const).flatMap((step) => {
                            const to = orderStep(g.accounts, r.account.id, step);
                            return to === null
                              ? []
                              : [
                                  {
                                    label: t(step < 0 ? "contextMenu.moveUp" : "contextMenu.moveDown"),
                                    onPress: () => put(g, r.account.id, to),
                                  },
                                ];
                          })
                        : []
                    }
                  />
                )}
              />
            </GroupedList>
          </View>
        );
      })}
      {order.data && order.data.keyFallback !== undefined ? (
        <>
          <GroupedHeader> </GroupedHeader>
          <GroupedList>
            <GroupedRow
              label={t("mobile.aiHub.keyFallback")}
              labelLines={2}
              hint={{
                name: t("common.about", { label: t("mobile.aiHub.keyFallback") }),
                text: t("mobile.aiHub.keyFallbackHint"),
              }}
              toggle={order.data.keyFallback}
              disabled={!order.data.canConfigure || fallback.isPending}
              onPress={() => fallback.mutate(!order.data?.keyFallback, { onError: failed })}
            />
          </GroupedList>
          {order.data.canConfigure ? null : <GroupedFooter>{t("mobile.aiHub.keyFallbackLocked")}</GroupedFooter>}
        </>
      ) : null}
    </SettingsPage>
  );
}

const groupKey = (g: Pick<AccountOrderGroup, "machineId" | "kind">) => `${g.machineId}:${g.kind}`;

/** One account of an order: its number, name, plan and owner, its state; its menu moves it up or down. */
function OrderAccountRow({
  row,
  locale,
  steps,
  disabled,
}: {
  row: OrderRow;
  locale: string;
  steps: { label: string; onPress: () => void }[];
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const a = row.account;
  const state = hubState(t, locale, a);
  const skipped = row.place === null;
  const stateText = skipped
    ? [state?.text ?? t("usageViews.signedOut"), t("mobile.aiHub.skipped")].join(" · ")
    : state?.text;
  return (
    <GroupedRow
      leading={
        <Text variant="callout" tone="muted" style={styles.place}>
          {row.place ?? ""}
        </Text>
      }
      leadingSaid={row.place?.toString()}
      label={hubTitle(t, a)}
      faint={skipped}
      sub={hubLine(t, a)}
      {...(stateText ? { below: <StateLine text={stateText} tone={state?.tone ?? "amber"} /> } : {})}
      disabled={disabled || steps.length === 0}
      {...(steps.length > 0 ? { onPress: () => void pickSteps(hubTitle(t, a), steps) } : {})}
    />
  );
}

const pickSteps = async (title: string, steps: { label: string; onPress: () => void }[]) => {
  const picked = await pickOne({ title, options: steps.map((s, i) => ({ key: String(i), label: s.label })) });
  if (picked !== null) steps[Number(picked)]?.onPress();
};

const styles = StyleSheet.create({
  meter: { paddingHorizontal: 16, paddingVertical: 12 },
  place: { minWidth: 24, textAlign: "center", fontVariant: ["tabular-nums"], fontWeight: "600" },
});
