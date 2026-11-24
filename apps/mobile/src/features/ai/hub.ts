import type {
  AccountAudience,
  AccountAudienceMode,
  AccountOrderGroup,
  AccountPermissions,
  AiHub,
  AiHubAccount,
  MachineAccount,
} from "@agenteschat/client";
import { ACCOUNT_KINDS, compareInOrder, orderAccounts, runMayMoveTo } from "@agenteschat/client/lib/ai-accounts";
import type { AiChoice, AiChoiceRow } from "@agenteschat/client/lib/ai-choice";
import { firstName } from "@agenteschat/client/lib/format";
import { planMeterText } from "@agenteschat/client/lib/plan-usage";
import { planName } from "@agenteschat/client/lib/plans";
import { AUTO, isAuto, providerLabel } from "@agenteschat/client/lib/providers";
import { planOwn, planState, planWindows } from "@agenteschat/ui/plan-state";
import type { TFunction } from "i18next";

/*
 * "Contas de IA" on the phone: an account's lines as the hub lists it (name, then plan and owner, then its state on a
 * line of its own), its permissions in words, and the order of use with signed-out accounts skipped at the end.
 */

export type Permission = keyof AccountPermissions;
export const PERMISSIONS: readonly Permission[] = ["manage", "use", "reply"];
/** Só você, Você e administradores, Cargos…, Pessoas…, Todos. */
export const AUDIENCE_MODES: readonly AccountAudienceMode[] = ["owner", "admins", "roles", "people", "everyone"];

type Titled = Pick<MachineAccount, "label" | "named" | "mine" | "email" | "keyHint" | "provider">;

/** An account's name alone (its plan goes on the line under it): the name given, else the viewer's own email. */
export function hubTitle(t: TFunction, a: Titled): string {
  if (a.named === true || !a.mine || a.keyHint != null || a.provider) return a.label;
  return a.email ?? t("aiAccounts.unnamed");
}

/** Its plan and whose it is ("Max · de João"); with `maker`, its maker first ("Claude · Max · de João"). */
export function hubLine(
  t: TFunction,
  a: Pick<MachineAccount, "plan" | "ownerName" | "kind" | "provider">,
  maker = false,
): string {
  return [
    maker ? (a.provider ? providerLabel(a.provider) : t(`aiAccounts.connect.${a.kind}`)) : null,
    a.plan ? planName(a.plan) : null,
    a.ownerName ? t("usageViews.whose", { name: firstName(a.ownerName) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type StateTone = "danger" | "amber" | "muted";

/**
 * What an account's own line says, when anything: signed out, at its limit (until when), close to it ("semana 88%"),
 * or only its owner's agents use it. Null while it is fine and open to everyone: the row has two lines then.
 */
export function hubState(
  t: TFunction,
  locale: string,
  a: Pick<AiHubAccount, "status" | "usage" | "mine" | "ownerName"> & { permissions?: AccountPermissions },
  now = new Date(),
): { text: string; tone: StateTone } | null {
  if (a.status !== "active") return { text: t("usageViews.signedOut"), tone: "amber" };
  if (a.usage) {
    const text = planMeterText(t, locale, now);
    const { state, until } = planState(a.usage, now.getTime());
    if (state === "limited") return { text: text.limited(until), tone: "danger" };
    const top = planWindows(a.usage, now.getTime()).filter(planOwn)[0];
    if (state === "almost" && top) return { text: `${text.short(top)} ${top.used}%`, tone: "amber" };
  }
  if (a.permissions?.use.mode === "owner")
    return a.mine
      ? { text: t("usageViews.serves.onlyYou"), tone: "muted" }
      : { text: t("usageViews.serves.only", { name: firstName(a.ownerName ?? "") }), tone: "muted" };
  return null;
}

/**
 * A permission's choice in words. `owner` is the account's owner by first name, or null when it is the viewer ("Só
 * você"); Atender todos's own is "Só o dono do agente". Cargos and Pessoas name the one picked, else how many.
 */
export function audienceLabel(
  t: TFunction,
  permission: Permission,
  audience: AccountAudience,
  owner: string | null,
  names: { role: (id: string) => string | undefined; person: (id: string) => string | undefined },
): string {
  switch (audience.mode) {
    case "owner":
      if (permission === "reply") return t("mobile.aiHub.audience.agentOwner");
      return owner ? t("mobile.aiHub.audience.ownerOf", { name: owner }) : t("mobile.aiHub.audience.owner");
    case "admins":
      return owner ? t("mobile.aiHub.audience.adminsOf", { name: owner }) : t("mobile.aiHub.audience.admins");
    case "roles": {
      const [only] = audience.roleIds;
      const one = audience.roleIds.length === 1 && only ? names.role(only) : undefined;
      return one ?? t("mobile.aiHub.audience.rolesCount", { count: audience.roleIds.length });
    }
    case "people": {
      const [only] = audience.userIds;
      const one = audience.userIds.length === 1 && only ? names.person(only) : undefined;
      return one ? firstName(one) : t("mobile.aiHub.audience.peopleCount", { count: audience.userIds.length });
    }
    case "everyone":
      return t("mobile.aiHub.audience.everyone");
  }
}

/** Whether the viewer may change a permission of an account (the server checks it again). */
export function mayChange(a: Pick<AiHubAccount, "rights">, permission: Permission): boolean {
  if (permission === "manage") return a.rights.canSetManage;
  if (permission === "use") return a.rights.canManage;
  return a.rights.canReplyAll;
}

/** A choice of a mode, with the people or roles it keeps from before when it stays on that mode. */
export const audienceOf = (mode: AccountAudienceMode, before: AccountAudience): AccountAudience => ({
  mode,
  userIds: mode === "people" ? before.userIds : [],
  roleIds: mode === "roles" ? before.roleIds : [],
});

type OrderLogin = AccountOrderGroup["accounts"][number];

/** One account in an order of use, as its row shows it: its place (null: skipped), and a login to move it by. */
export interface OrderRow {
  account: OrderLogin;
  place: number | null;
}

/**
 * An order's rows: the accounts a run may go to, numbered from 1, then the skipped ones at the end with no number (a
 * signed-out account, one a run never moves to). Each account once, its logins together.
 */
export function orderRows(group: Pick<AccountOrderGroup, "accounts">): OrderRow[] {
  const blocks = orderAccounts(group.accounts);
  const first = (b: OrderLogin[]) => (b.find(runMayMoveTo) ?? b[0]) as OrderLogin;
  const live = (b: OrderLogin[]) => b.some((a) => runMayMoveTo(a) && a.status === "active");
  const placed = blocks.filter(live).map((b, i) => ({ account: first(b), place: i + 1 }));
  const skipped = blocks.filter((b) => !live(b)).map((b) => ({ account: first(b), place: null }));
  return [...placed, ...skipped];
}

/**
 * Where to drop an account moved from `from` to `to` among the numbered rows: before the row it lands on going up,
 * after it going down (`orderDrop`'s terms). Null when it stays.
 */
export function orderDropOf(
  rows: readonly OrderRow[],
  from: number,
  to: number,
): { id: string; onto: string; where: "before" | "after" } | null {
  const moved = rows[from];
  const onto = rows[to];
  if (!moved || !onto || from === to) return null;
  return { id: moved.account.id, onto: onto.account.id, where: to < from ? "before" : "after" };
}

/** A row of the "Conta" choice as the picker sheet shows it. */
export interface ChoiceText {
  label: string;
  sub?: string;
  value?: string;
  /** The maker, for the search ("claude" finds every Claude account). */
  keywords: string;
  mark: string | null;
}

/** An option of the "Conta" choice: its name, its plan and owner (or why it can't be used), its use of the plan. */
export function choiceText(t: TFunction, row: AiChoiceRow, locale: string, now = new Date()): ChoiceText {
  if (row.type === "workspace")
    return {
      label: t("mobile.aiHub.choice.workspace"),
      sub: t("mobile.aiHub.choice.workspaceSub"),
      keywords: "",
      mark: null,
    };
  if (row.type === "key" && row.apiKey) {
    const k = row.apiKey;
    return {
      label: k.label,
      sub: [t("mobile.aiHub.choice.key"), k.isDefault ? t("mobile.aiHub.choice.keyDefault") : null]
        .filter(Boolean)
        .join(" · "),
      keywords: providerLabel(k.provider),
      mark: k.provider,
    };
  }
  if (row.type === "brain")
    return {
      label: row.brain === "model" ? t("mobile.aiHub.choice.api") : t(`aiAccounts.connect.${row.brain}`),
      keywords: "",
      mark: row.brain === "model" ? null : row.brain,
    };
  const a = row.account as AiHubAccount;
  const state = row.usable ? hubState(t, locale, a, now) : null;
  const top = a.usage ? planWindows(a.usage, now.getTime()).filter(planOwn)[0] : undefined;
  return {
    label: hubTitle(t, a),
    sub: row.usable
      ? hubLine(t, a)
      : t(`aiAccounts.useReason.${row.reason ?? "not_allowed"}`, { owner: firstName(a.ownerName ?? "") }),
    ...(state && state.tone !== "muted" ? { value: state.text } : top ? { value: `${top.used}%` } : {}),
    keywords: [a.provider ? providerLabel(a.provider) : t(`aiAccounts.connect.${a.kind}`), a.ownerName ?? ""].join(" "),
    mark: a.provider ?? a.kind,
  };
}

/** A choice with another model: Automático picks the effort too; a fixed model keeps the effort, medium after Automático. */
export function withModel(choice: AiChoice, model: string): AiChoice {
  if (isAuto(model)) return { ...choice, model: AUTO, effort: "auto" };
  return { ...choice, model, effort: !choice.effort || isAuto(choice.effort) ? "medium" : choice.effort };
}

const kindRank = (kind: string) => {
  const i = (ACCOUNT_KINDS as readonly string[]).indexOf(kind);
  return i < 0 ? ACCOUNT_KINDS.length : i;
};

/** One row per account (its logins together), by maker, then in the order of use with the viewer's own first. */
export function hubAccounts(hub: Pick<AiHub, "accounts">, viewerId: string): AiHubAccount[] {
  const inOrder = compareInOrder(viewerId);
  return orderAccounts(hub.accounts)
    .map((logins) => logins[0] as AiHubAccount)
    .sort((x, y) => kindRank(x.kind) - kindRank(y.kind) || inOrder(x, y));
}
