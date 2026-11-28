import type {
  AccountAudience,
  AccountAudienceMode,
  AccountOrderGroup,
  AccountPermissions,
  AiHub,
  AiHubAccount,
  MachineAccount,
} from "@agenteschat/client";
import {
  useAccountOrder,
  useAiHub,
  useApi,
  useMe,
  useRoles,
  useSetAccountPermissions,
  useSetKeyFallback,
} from "@agenteschat/client";
import { orderAccounts, orderPlaces } from "@agenteschat/client/lib/ai-accounts";
import { accountShortName, hubAccountsInOrder } from "@agenteschat/client/lib/ai-choice";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName, joinNames, namesText } from "@agenteschat/client/lib/format";
import { planMeterText } from "@agenteschat/client/lib/plan-usage";
import { planName, planOf } from "@agenteschat/client/lib/plans";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  AvatarStack,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogFooter,
  DialogSearchList,
  EmptyState,
  Icon,
  InfoHint,
  List,
  Locked,
  Meter,
  PLAN_ALMOST,
  PlanMeter,
  ProviderLogo,
  planLevel,
  planLine,
  Select,
  SettingRow,
  SettingsSection,
  Switch,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { PlanHold, usePlanHold } from "@/components/ai/plan-hold";
import { useConnectAi, useMayConnectAi } from "@/components/connect-ai-context";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useToast } from "@/lib/toast";
import { useOrderMoves } from "./AccountOrder";
import { AccountMenu, AccountNotes } from "./AiAccounts";
import "@/components/plan-usage.css";
import "./ai-hub.css";

/*
 * Configurações › IA e uso › "Contas de IA": one list of everything the agents think with, in the account picker's
 * groups: the viewer's accounts, the team's, then the workspace's API keys (`keys`). An account is one quiet line (its
 * maker's mark, its name, its plan and whose it is, the agents that think with it, its state at the end) that opens
 * it: its limits and its three permissions (Gerenciar, Usar em agentes, Atender todos), with its actions behind ⋯.
 * "Adicionar conta" (Connect) adds a plan or a key; "Ordem de uso" opens which account the agents go to next at a
 * limit, and the API-key switch.
 */

/** The login that speaks for an account: the one shared by its agents, else its first. */
const lead = <A extends MachineAccount>(logins: readonly A[]): A =>
  logins.find((l) => l.shared === true) ?? (logins[0] as A);

/** The newest usage any of an account's logins read: they share one plan's windows. */
const newestUsage = (logins: readonly AiHubAccount[]) =>
  logins
    .map((l) => l.usage)
    .filter((u): u is NonNullable<typeof u> => u !== null)
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0] ?? null;

/** "Max · de João": its plan, whose it is (the viewer's own needs no name: it is in "Suas contas"). */
function facts(t: TFunction, a: AiHubAccount): string {
  return [
    a.plan ? planName(a.plan) : null,
    a.ownerName && !a.mine ? t("aiHub.of", { name: firstName(a.ownerName) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The maker: a coding plan's own name, else its program's ("Claude", "ChatGPT"). */
const makerOf = (t: TFunction, a: Pick<MachineAccount, "kind" | "provider">) =>
  planOf(a.provider)?.label ?? t(`aiAccounts.connect.${a.kind}`);

/** The state at a line's end: signed out, only its owner's, else its window closest to the limit. */
function AccountState({ a, meter }: { a: AiHubAccount; meter: boolean }) {
  const { t, i18n } = useTranslation();
  if (a.status !== "active")
    return (
      <span className="aa-state" data-level="almost">
        {t("aiAccounts.useReason.signed_out")}
      </span>
    );
  if (!a.rights.canUse && a.rights.useReason)
    return (
      <span className="aa-state">
        {t(`aiAccounts.useReason.${a.rights.useReason}`, { owner: firstName(a.ownerName ?? "") })}
      </span>
    );
  const text = planMeterText(t, i18n.language);
  const line = a.usage ? planLine(a.usage, text) : null;
  if (!line) return null;
  const limited = line.state === "limited";
  if (!line.top || !meter)
    return line.top || limited ? (
      <span className="aa-state" data-level={line.top ? planLevel(line.top.used, limited) : "limited"}>
        {limited ? line.alert : line.top ? `${text.short(line.top)} ${line.top.used}%` : ""}
      </span>
    ) : null;
  return (
    <span
      className="ac-planmeter ac-planmeter--compact plan-row__meter"
      data-level={planLevel(line.top.used, limited)}
      title={line.title}
    >
      <span className="ac-planmeter__line">{limited ? line.alert : `${text.short(line.top)} ${line.top.used}%`}</span>
      <Meter value={line.top.used} max={100} label={text.window(line.top)} marks={[PLAN_ALMOST]} />
    </span>
  );
}

/** "Lia e Dev pensam com ela": the agents an account thinks for, their faces first. */
function AccountAgents({ logins }: { logins: readonly AiHubAccount[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const ids = [...new Set(logins.flatMap((l) => l.usedByIds ?? []))];
  const names = [...new Set(logins.flatMap((l) => l.usedBy))];
  if (names.length === 0) return <span className="aa-agents">{t("aiHub.thinksNone")}</span>;
  return (
    <span className="aa-agents">
      {ids.length > 0 && (
        <AvatarStack aria-hidden="true">
          {ids.slice(0, 4).map((id) => (
            <AgentAvatar key={id} agentId={id} name={dir.agentById.get(id)?.name ?? ""} size="xs" />
          ))}
        </AvatarStack>
      )}
      <span>{t("aiHub.thinks", { count: names.length, names: namesText(t, names, 2) })}</span>
    </span>
  );
}

/**
 * "Contas de IA": the accounts card, in groups (the viewer's, the team's, the API keys: `keys`, drawn by Settings),
 * opening each account and the order of use.
 */
export function AiAccountsTab({ keys }: { keys?: ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const me = useMe();
  const { hub, loading, error, refetch } = useAiHub(org.id);
  const look = useRightHandLook();
  const connectAi = useConnectAi();
  const mayConnect = useMayConnectAi();
  const hold = usePlanHold();
  const [open, setOpen] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  if (loading)
    return (
      <Card>
        <LoadingList count={3} avatar={false} trailing />
      </Card>
    );
  if (!hub)
    return (
      <Card>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </Card>
    );
  const blocks = hubAccountsInOrder(hub.accounts, me.data?.user.id ?? "");
  const shown = blocks.find((b) => b.some((l) => l.id === open));
  const connect = connectAi && mayConnect && !hold && (
    <Button size="sm" icon="plus" onClick={() => connectAi.open({})}>
      {t("aiHub.choice.add")}
    </Button>
  );
  // No plan yet: the empty state invites one (over the keys, if any), its button the way in.
  const nothing = blocks.length === 0;
  const row = (logins: AiHubAccount[]) => {
    const a = lead(logins);
    const title = accountShortName(t, a);
    const sub = facts(t, a);
    return (
      <div key={a.id} className="plan-row">
        <button
          type="button"
          className="plan-row__head ac-foldrow__head"
          aria-haspopup="dialog"
          onClick={() => setOpen(a.id)}
        >
          <ProviderLogo id={a.provider ?? a.kind} size="sm" off={a.status !== "active"} />
          <span className="plan-acct__name">
            <span className="plan-row__title" title={title}>
              {title}
            </span>
            {sub && (
              <span className="plan-row__facts" title={sub}>
                <span className="plan-row__owner">{sub}</span>
              </span>
            )}
          </span>
          <AccountState a={{ ...a, usage: newestUsage(logins) }} meter />
          <AccountAgents logins={logins} />
          <Icon name="chevronRight" size={16} className="plan-row__chevron" />
        </button>
      </div>
    );
  };
  const groups = [
    { key: "yours", blocks: blocks.filter((b) => lead(b).mine) },
    { key: "others", blocks: blocks.filter((b) => !lead(b).mine) },
  ] as const;
  return (
    <Card aria-labelledby="sec-ai-accounts">
      <CardHeader
        id="sec-ai-accounts"
        icon="computer"
        title={t("aiHub.accounts")}
        hint={{ name: t("common.about", { label: t("aiHub.accounts") }), text: t("aiHub.accountsHint") }}
        action={
          !nothing && (
            <span className="aa-acts">
              {hub.order.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="sortAsc"
                  title={t("aiHub.order.tip")}
                  aria-haspopup="dialog"
                  onClick={() => setOrdering(true)}
                >
                  {t("aiHub.order.title")}
                </Button>
              )}
              {connect}
            </span>
          )
        }
      />
      {hold && <PlanHold hold={hold} />}
      {nothing && !hold && (
        <EmptyState
          size="panel"
          agent={look}
          title={t("aiAccounts.page.emptyTitle")}
          actions={
            connectAi &&
            mayConnect && (
              <Button variant="primary" icon="plus" onClick={() => connectAi.open({})}>
                {t("aiHub.choice.add")}
              </Button>
            )
          }
        >
          {t(mayConnect ? "usageViews.accounts.empty" : "aiAccounts.page.emptyViewer")}
        </EmptyState>
      )}
      {groups.map(
        (group) =>
          group.blocks.length > 0 && (
            <section key={group.key} className="aa-group" aria-label={t(`aiHub.choice.groups.${group.key}`)}>
              <p className="aa-group__label">{t(`aiHub.choice.groups.${group.key}`)}</p>
              <List className="plan-rows aa-list">{group.blocks.map(row)}</List>
            </section>
          ),
      )}
      {keys}
      {shown && <AccountDialog logins={shown} onClose={() => setOpen(null)} />}
      {ordering && <OrderDialog hub={hub} onClose={() => setOrdering(false)} />}
    </Card>
  );
}

type Permission = keyof AccountPermissions;
const MODES: readonly AccountAudienceMode[] = ["owner", "admins", "roles", "people", "everyone"];

/** An account opened: its limits, its permissions, its actions behind ⋯. */
function AccountDialog({ logins, onClose }: { logins: readonly AiHubAccount[]; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const save = useSetAccountPermissions(org.id);
  const [picking, setPicking] = useState<{ which: Permission; mode: "roles" | "people" } | null>(null);
  const a = lead(logins);
  const owner = a.mine ? null : firstName(a.ownerName ?? "");
  const roleName = (id: string) => roles.data?.roles.find((r) => r.id === id)?.name ?? "";
  const modeLabel = (which: Permission, mode: AccountAudienceMode) => {
    if (which === "reply" && mode === "owner") return t("aiHub.modes.replyOwner");
    if (mode === "owner") return owner ? t("aiHub.modes.ownerOf", { name: owner }) : t("aiHub.modes.owner");
    if (mode === "admins") return owner ? t("aiHub.modes.adminsOf", { name: owner }) : t("aiHub.modes.admins");
    return t(`aiHub.modes.${mode}`);
  };
  const valueLabel = (which: Permission, p: AccountAudience) =>
    p.mode === "roles" && p.roleIds.length
      ? joinNames(p.roleIds.map(roleName).filter(Boolean), t)
      : p.mode === "people" && p.userIds.length
        ? joinNames(
            p.userIds.map((id) => firstName(dir.memberById.get(id)?.name ?? "")),
            t,
          )
        : modeLabel(which, p.mode);
  const set = (which: Permission, next: AccountAudience) =>
    save.mutate(
      { accountId: a.id, permissions: { [which]: next } },
      {
        onSuccess: () => toast.show(t("aiHub.detail.saved")),
        onError: (e) => toast.show(errorText(t, e), "error"),
      },
    );
  const choose = (which: Permission, mode: AccountAudienceMode) => {
    if (mode === "roles" || mode === "people") return setPicking({ which, mode });
    if (mode === a.permissions[which].mode) return;
    set(which, { mode, userIds: [], roleIds: [] });
  };
  const claude = a.kind === "claude_code" && !a.provider;
  const rows: { which: Permission; may: boolean }[] = [
    { which: "manage", may: a.rights.canSetManage },
    { which: "use", may: a.rights.canManage },
    { which: "reply", may: a.rights.canReplyAll },
  ];
  const text = planMeterText(t, i18n.language);
  const title = accountShortName(t, a);
  const more = t("aiHub.detail.more", { name: title });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      subtitle={[makerOf(t, a), facts(t, a)].filter(Boolean).join(" · ")}
      leading={<ProviderLogo id={a.provider ?? a.kind} size="sm" off={a.status !== "active"} />}
      actions={<AccountMenu logins={logins} canManage={a.rights.canManage} label={more} />}
      closeLabel={t("common.close")}
      width={440}
      className="aa-detail"
    >
      <Locked when={save.isPending}>
        <div className="ac-dialog__body">
          <AccountNotes logins={logins} />
          <SettingsSection title={t("aiHub.detail.limits")}>
            {a.usage ? (
              <PlanMeter usage={a.usage} text={text} />
            ) : (
              <p className="plan-empty">
                {a.status === "active" ? t("aiHub.detail.noLimits") : t("aiAccounts.useReason.signed_out")}
              </p>
            )}
          </SettingsSection>
          <SettingsSection title={t("aiHub.detail.permissions")}>
            {rows.map(({ which, may }) => {
              const p = a.permissions[which];
              const name = t(`aiHub.detail.${which}`);
              const hint = [
                t(`aiHub.detail.${which}Hint`),
                claude && which !== "manage" ? t("aiHub.detail.claudeTerms") : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <SettingRow
                  key={which}
                  title={name}
                  hint={{ name: t("common.about", { label: name }), text: hint }}
                  status={t(`aiHub.detail.${which}Line`)}
                >
                  <Select<AccountAudienceMode>
                    size="sm"
                    align="end"
                    aria-label={name}
                    value={p.mode}
                    disabled={!may || save.isPending}
                    onValueChange={(mode) => choose(which, mode)}
                    options={MODES.map((m) => ({ value: m, label: modeLabel(which, m) }))}
                    renderValue={() => <span className="ac-select__text">{valueLabel(which, p)}</span>}
                  />
                </SettingRow>
              );
            })}
          </SettingsSection>
        </div>
      </Locked>
      {picking && (
        <PickDialog
          mode={picking.mode}
          ownerId={a.ownerId}
          start={a.permissions[picking.which].mode === picking.mode ? a.permissions[picking.which] : null}
          title={t(`aiHub.detail.${picking.which}`)}
          onClose={() => setPicking(null)}
          onSave={(ids) => {
            set(picking.which, {
              mode: picking.mode,
              userIds: picking.mode === "people" ? ids : [],
              roleIds: picking.mode === "roles" ? ids : [],
            });
            setPicking(null);
          }}
        />
      )}
    </Dialog>
  );
}

/** "Cargos…" or "Pessoas…": who besides the account's owner, with a check each. */
function PickDialog({
  mode,
  ownerId,
  start,
  title,
  onClose,
  onSave,
}: {
  mode: "roles" | "people";
  ownerId: string | null;
  start: AccountAudience | null;
  title: string;
  onClose: () => void;
  onSave: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    new Set(mode === "roles" ? (start?.roleIds ?? []) : (start?.userIds ?? [])),
  );
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const all =
    mode === "roles"
      ? sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))).map((r) => ({ id: r.id, name: r.name }))
      : dir.members.filter((m) => m.userId !== ownerId).map((m) => ({ id: m.userId, name: m.name }));
  const shown = all.filter((x) => !query || x.name.toLowerCase().includes(query));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={t(mode === "roles" ? "aiHub.detail.pickRoles" : "aiHub.detail.pickPeople")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        search={all.length > 8}
        searchLabel={t(mode === "roles" ? "aiHub.detail.searchRoles" : "aiHub.detail.searchPeople")}
        searchPlaceholder={t(mode === "roles" ? "aiHub.detail.searchRoles" : "aiHub.detail.searchPeople")}
        listLabel={title}
        isEmpty={shown.length === 0}
        emptyText={t("aiHub.detail.nobody")}
      >
        {shown.map((x) => {
          const id = `aa-pick-${x.id}`;
          return (
            <label key={x.id} htmlFor={id} className="scope-row">
              <Checkbox id={id} checked={picked.has(x.id)} onCheckedChange={(on) => toggle(x.id, on)} />
              <span className="scope-row__text">
                <span>{x.name}</span>
              </span>
            </label>
          );
        })}
      </DialogSearchList>
      <DialogFooter bar>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={picked.size === 0} onClick={() => onSave([...picked])}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * "Ordem de uso": one box per maker and computer, its accounts numbered first to last (whoever may move one drags it
 * by its place, or presses the place for Mover para cima / para baixo), a signed-out one skipped at the end; then the
 * switch that goes on with the API key once every plan is at its limit.
 */
function OrderDialog({ hub, onClose }: { hub: AiHub; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const fallback = useSetKeyFallback(org.id);
  // The order's own view: a move updates it at once.
  const groups = useAccountOrder(org.id).data?.groups ?? hub.order;
  const several = new Set(groups.map((g) => g.machineId)).size > 1 || groups.length > 1;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("aiHub.order.title")}
      description={t("aiHub.order.sub")}
      closeLabel={t("common.close")}
      width={600}
      className="aa-order"
    >
      <div className="ac-dialog__body">
        {groups.map((g) => (
          <OrderGroup key={`${g.machineId}:${g.kind}`} group={g} computer={several} />
        ))}
        <section className="ac-setsec">
          <SettingRow
            title={t("aiHub.order.fallback")}
            hint={{
              name: t("common.about", { label: t("aiHub.order.fallback") }),
              text: t("aiHub.order.fallbackHint"),
            }}
            htmlFor="aa-fallback"
          >
            <Switch
              id="aa-fallback"
              checked={hub.keyFallback}
              disabled={!hub.canConfigure || fallback.isPending}
              onCheckedChange={(on) => fallback.mutate(on, { onError: (e) => toast.show(errorText(t, e), "error") })}
            />
          </SettingRow>
        </section>
      </div>
    </Dialog>
  );
}

/** One maker's accounts on one computer, in their order: the placed first, the skipped after. */
function OrderGroup({ group, computer }: { group: AccountOrderGroup; computer: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { place, drop } = useOrderMoves(org.id, group);
  const blocks = orderAccounts(group.accounts);
  const places = orderPlaces(group.accounts);
  // A row goes by its first login, which the grip names; moving it moves the whole account.
  const rows = [...blocks.filter((_, i) => places[i] !== null), ...blocks.filter((_, i) => places[i] === null)].map(
    (b) => b[0] as (typeof b)[number],
  );
  // Alone in its order, an account has nothing to move past: its number, no grip.
  const alone = places.filter((n) => n !== null).length < 2;
  const maker = t(`aiAccounts.connect.${group.kind}`);
  const name = computer
    ? t("aiHub.order.group", {
        maker,
        computer: computerNameOf(t, org.name, group.computer, isPersonal(org)),
      })
    : maker;
  const text = planMeterText(t, i18n.language);
  return (
    <div className="plan-order">
      <div className="plan-order__head">
        <div className="plan-order__title ac-iconline">
          <ProviderLogo id={group.kind} size="xs" />
          <span className="ac-hintline">
            <span>{name}</span>
            <InfoHint name={t("common.about", { label: name })}>{t("usageViews.order.hint")}</InfoHint>
          </span>
        </div>
      </div>
      {rows.map((a) => {
        const title = accountShortName(t, a);
        const skipped = places[blocks.findIndex((b) => b.includes(a))] === null;
        const line = a.usage ? planLine(a.usage, text) : null;
        const limited = line?.state === "limited";
        const state =
          a.status !== "active"
            ? { level: "almost", text: t("aiHub.order.signedOut") }
            : skipped
              ? { level: "", text: t("aiHub.order.skipped") }
              : limited
                ? { level: "limited", text: line?.alert ?? "" }
                : line?.top
                  ? { level: planLevel(line.top.used, false), text: `${text.short(line.top)} ${line.top.used}%` }
                  : null;
        const sub = [
          a.plan ? planName(a.plan) : null,
          a.ownerName ? t("aiHub.of", { name: firstName(a.ownerName) }) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div key={a.id} className="plan-row plan-row--placed" data-skipped={skipped || undefined} {...drop(a.id)}>
            {alone ? (
              <span className="plan-row__place" aria-hidden={skipped || undefined}>
                {skipped ? "" : 1}
              </span>
            ) : (
              place(a.id, title)
            )}
            <div className="plan-row__head">
              <span className="plan-acct__name">
                <span className="plan-row__title" title={title}>
                  {title}
                </span>
                {sub && (
                  <span className="plan-row__facts" title={sub}>
                    <span className="plan-row__owner">{sub}</span>
                  </span>
                )}
              </span>
              {state && (
                <span className="aa-state" data-level={state.level}>
                  {state.text}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
