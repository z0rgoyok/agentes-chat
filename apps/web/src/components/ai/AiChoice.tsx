import type { AiChoiceState, PlanUsage } from "@agenteschat/client";
import { useAiChoice } from "@agenteschat/client";
import {
  AI_CHOICE_GROUPS,
  type AiChoice,
  type AiChoiceGroup,
  type AiChoiceRow,
  type AiChoiceTarget,
  accountShortName,
  aiChoiceOf,
  keyChosen,
  reasonText,
} from "@agenteschat/client/lib/ai-choice";
import { type EffortLevel, effortOf } from "@agenteschat/client/lib/brain-advanced";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { planMeterText } from "@agenteschat/client/lib/plan-usage";
import { planModelById, planName } from "@agenteschat/client/lib/plans";
import { AUTO, isAuto, providerLabel } from "@agenteschat/client/lib/providers";
import {
  cx,
  Field,
  Icon,
  matchesWords,
  ProviderLogo,
  planLevel,
  planLine,
  SearchSelect,
  Select,
  type SelectOption,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import "./ai-choice.css";

/*
 * The one "Quem pensa" choice (web): Conta, then Modelo and Esforço, for every place that picks an AI (an agent, Lodi,
 * a new agent, a mission, several agents). The rows, their order and why one can't be used come from `useAiChoice`;
 * this only draws them. Conta is a searchable select: closed, one line (the name, its plan muted, its room); open, each
 * account on two lines (the name over its plan and whose it is), its room at the end and a check on the chosen one. An
 * account that can't think here stays in the list, dimmed, with why; one of the viewer's that signed out offers to sign
 * in again where the caller can. "Adicionar conta" and "Gerenciar contas" stay at the list's foot, whatever is typed.
 */

export type AiChoicePart = "account" | "model" | "effort";
const ALL_PARTS: readonly AiChoicePart[] = ["account", "model", "effort"];

/** The row a choice stands for: an account by any of its logins, a key, a mission's brain, Lodi's "A do workspace". */
export function rowOfChoice(rows: readonly AiChoiceRow[], c: AiChoice | null | undefined): AiChoiceRow | undefined {
  if (!c) return undefined;
  return rows.find((r) => {
    if (r.type === "plan")
      return c.brain !== "model" && !!c.account && (r.account?.id === c.account || r.account?.sameAs === c.account);
    if (r.type === "key") return c.brain === "model" && !!r.apiKey && keyChosen(c, r.apiKey);
    if (r.type === "workspace") return c.brain === "model";
    return r.brain === c.brain;
  });
}

/** A row's name: the account's, the key's, a brain's maker, "A do workspace". */
export function rowName(t: TFunction, row: AiChoiceRow): string {
  if (row.type === "workspace") return t("aiHub.choice.workspace");
  if (row.account) return accountShortName(t, row.account);
  if (row.apiKey) return row.apiKey.label;
  return row.brain === "model" ? t("aiHub.apiKey") : t(`aiAccounts.connect.${row.brain}`);
}

/** The maker's mark of a row. */
export function rowMark(row: AiChoiceRow | undefined, size: "xs" | "sm" = "xs"): ReactNode {
  if (!row) return null;
  if (row.account) return <ProviderLogo id={row.account.provider ?? row.account.kind} size={size} off={!row.usable} />;
  if (row.apiKey) return <ProviderLogo id={row.apiKey.provider} size={size} />;
  if (row.type === "workspace") return <Icon name="key" size={size === "xs" ? 16 : 20} />;
  return <ProviderLogo id={row.brain} size={size} />;
}

/** What follows the name, muted: the plan and, for someone else's account, whose it is. */
function rowMeta(t: TFunction, row: AiChoiceRow, withOwner: boolean): string {
  if (row.account) {
    const a = row.account;
    return [
      a.plan ? planName(a.plan) : null,
      withOwner && !a.mine && a.ownerName ? t("aiHub.of", { name: firstName(a.ownerName) }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  // "A do workspace": which key it is.
  if (row.type === "workspace") return row.apiKey?.label ?? t("aiHub.apiKey");
  if (row.apiKey) return row.apiKey.endpoint ? row.apiKey.endpoint.baseURL : t("aiHub.apiKey");
  // A plan through its computer's own sign-in.
  if (row.type === "brain" && row.brain !== "model") return t("brain.picker.ownSignIn");
  return "";
}

/** A row's end: why it can't be used, else its room (the window closest to its limit), or nothing. */
function RowEnd({ row }: { row: AiChoiceRow }) {
  const { t } = useTranslation();
  if (!row.usable) return <span className="aa-room">{reasonText(t, row)}</span>;
  return <Room usage={row.account?.usage} />;
}

/** A plan's room: the window closest to its limit, as a short bar and its percent; at the limit, until when. */
function Room({ usage }: { usage: PlanUsage | null | undefined }) {
  const { t, i18n } = useTranslation();
  const line = usage ? planLine(usage, planMeterText(t, i18n.language)) : null;
  if (!line) return null;
  if (line.state === "limited")
    return (
      <span className="aa-room" data-level="limited">
        {line.alert}
      </span>
    );
  if (!line.top) return null;
  const level = planLevel(line.top.used, false);
  return (
    <span className="aa-room" data-level={level} title={line.title}>
      <span className="aa-room__bar" aria-hidden="true">
        <i style={{ width: `${Math.max(line.top.used, 4)}%` }} />
      </span>
      {`${line.top.used}%`}
    </span>
  );
}

/** The closed field: the mark, the name, then its plan muted, the room at the end; one line. */
function RowLine({ row, owner }: { row: AiChoiceRow; owner: boolean }) {
  const { t } = useTranslation();
  const name = rowName(t, row);
  const meta = rowMeta(t, row, owner);
  return (
    <span className="aa-opt">
      <span className="aa-opt__name" title={name}>
        {name}
      </span>
      <span className="aa-meta">
        {meta && (
          <span className="aa-meta__plan" title={meta}>
            {meta}
          </span>
        )}
        <RowEnd row={row} />
      </span>
    </span>
  );
}

/** One option of the open list: the name over its plan and whose it is, its room (or "Entrar de novo") and the check. */
function AccountOption({ row, chosen, again }: { row: AiChoiceRow; chosen: boolean; again: boolean }) {
  const { t } = useTranslation();
  const name = rowName(t, row);
  const meta = rowMeta(t, row, true);
  return (
    <>
      <span className="ac-menu__leading" aria-hidden="true">
        {rowMark(row)}
      </span>
      <span className="ac-menu__label aa-row">
        <span title={name}>{name}</span>
        {meta && (
          <span className="ac-menu__desc" title={meta}>
            {meta}
          </span>
        )}
      </span>
      <span className="aa-row__end">
        {again ? (
          // The whole row signs in again (an option holds no button of its own): drawn as the button it acts as.
          <span className="ac-btn ac-btn--sm aa-row__again">{t("aiAccounts.page.signInAgain")}</span>
        ) : (
          <RowEnd row={row} />
        )}
        <span className="ac-tz__check" aria-hidden="true">
          {chosen && <Icon name="check" size={16} />}
        </span>
      </span>
    </>
  );
}

/**
 * A way to think the accounts don't list, from the caller (an agent's "Quem pensa": its computer's own sign-in, a plan
 * that moves it to another computer): drawn as an account, in its group, picked through `onPick`.
 */
export interface AiChoiceExtra {
  key: string;
  group: AiChoiceGroup;
  name: string;
  meta?: string;
  mark: ReactNode;
  usage?: PlanUsage | null;
  /** It can't be picked: why, at the row's end. */
  off?: string;
  onPick: () => void;
}

/** An extra row of the open list, drawn as an account's. */
function ExtraOption({ extra }: { extra: AiChoiceExtra }) {
  return (
    <>
      <span className="ac-menu__leading" aria-hidden="true">
        {extra.mark}
      </span>
      <span className="ac-menu__label aa-row">
        <span title={extra.name}>{extra.name}</span>
        {extra.meta && (
          <span className="ac-menu__desc" title={extra.meta}>
            {extra.meta}
          </span>
        )}
      </span>
      <span className="aa-row__end">
        {extra.off ? <span className="aa-room">{extra.off}</span> : <Room usage={extra.usage} />}
        <span className="ac-tz__check" aria-hidden="true" />
      </span>
    </>
  );
}

type RowOption = SelectOption & { row?: AiChoiceRow; extra?: AiChoiceExtra };
const EXTRA = "x:";

/**
 * The selects of a choice, drawn from its state. `value`/`onChange`: the caller keeps the choice (a new agent, several
 * agents) and nothing saves here; else each change saves at once. `onAccount`: an account picked, for a caller with its
 * own way to switch (an agent's "Quem pensa": who else moves with it, signing in, undoing). `onAdd`, `onManage`: the
 * list's foot ("Adicionar conta", "Gerenciar contas"). `onAgain`: one of the viewer's signed-out accounts picked, to
 * sign in again (without it such a row stays dimmed).
 */
export function AiChoiceFields({
  state,
  parts = ALL_PARTS,
  value,
  onChange,
  onAccount,
  onSaved,
  modelHint,
  onAdd,
  onManage,
  onAgain,
  extra = [],
  open = false,
  disabled = false,
  className,
}: {
  state: AiChoiceState;
  parts?: readonly AiChoicePart[];
  value?: AiChoice | null;
  onChange?: (choice: AiChoice, row: AiChoiceRow) => void;
  onAccount?: (row: AiChoiceRow) => void;
  /** A change saved (not with `onChange`). */
  onSaved?: (choice: AiChoice) => void;
  /** What the Modelo field's ⓘ says (a mission's: when it can change). */
  modelHint?: string;
  /** "Adicionar conta" at the foot of the Conta list. */
  onAdd?: () => void;
  /** "Gerenciar contas" at the foot of the Conta list. */
  onManage?: () => void;
  /** One of the viewer's accounts that signed out, picked: sign in again. */
  onAgain?: (row: AiChoiceRow) => void;
  /** Ways to think the accounts don't list, each in its group (`AiChoiceExtra`). */
  extra?: readonly AiChoiceExtra[];
  /** The Conta list opens shown (a link that leads to the choice). */
  open?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const id = useId();
  const [pending, setPending] = useState<AiChoice | null>(null);
  const currentKey = JSON.stringify(state.current);
  // What the server says now replaces what was just picked, once it has it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when what is saved changes
  useEffect(() => setPending(null), [currentKey]);
  const shown = value ?? pending ?? state.current;
  const row = rowOfChoice(state.rows, shown) ?? (shown ? undefined : state.selected) ?? undefined;
  const locked = disabled || !state.canEdit || state.saving;

  const commit = (next: AiChoice, at: AiChoiceRow) => {
    if (onChange) return onChange(next, at);
    setPending(next);
    state.save(next).then(
      () => onSaved?.(next),
      (e: unknown) => {
        setPending(null);
        toast.show(errorText(t, e), "error");
      },
    );
  };

  // The viewer's own account that signed out: picking it signs in again, where the caller offers that.
  const again = (r: AiChoiceRow) => !!onAgain && r.reason === "signed_out" && r.account?.mine === true;
  const rowOptions: RowOption[] = state.rows.map((r) => ({
    value: r.key,
    label: rowName(t, r),
    // Lodi's "A do workspace" stands first on its own, with no heading.
    ...(r.group !== "workspace" ? { group: r.group } : {}),
    leading: rowMark(r),
    disabled: !r.usable && !again(r),
    row: r,
  }));
  // The caller's extra rows after the accounts of their group.
  const accountOptions: RowOption[] = AI_CHOICE_GROUPS.flatMap((g) => [
    ...rowOptions.filter((o) => o.row?.group === g),
    ...extra
      .filter((x) => x.group === g)
      .map((x) => ({
        value: `${EXTRA}${x.key}`,
        label: x.name,
        group: g,
        leading: x.mark,
        disabled: !!x.off,
        extra: x,
      })),
  ]);
  const pickAccount = (key: string) => {
    const more = extra.find((x) => `${EXTRA}${x.key}` === key);
    if (more) return more.onPick();
    const next = state.rows.find((r) => r.key === key);
    if (next && onAgain && again(next)) return onAgain(next);
    if (!next || next.key === row?.key) return;
    if (onAccount) return onAccount(next);
    commit(aiChoiceOf(next, shown ?? null), next);
  };

  const models = row ? state.models(row, t) : [];
  const checked = models.find((m) => m.checked)?.value;
  // What was just picked while it is a choice of this list; else the one the list checks (a model kept by its id reads
  // as the list's own value).
  const known = (v: string | null | undefined) => !!v && models.some((m) => m.value === v);
  // The model in use stays a choice when the list doesn't have it (a typed one, one the list dropped), by its name.
  const kept =
    shown?.model && !known(shown.model) && !isAuto(shown.model) && (!known(checked) || planModelById(shown.model))
      ? shown.model
      : null;
  const model = known(shown?.model) ? (shown?.model as string) : (kept ?? checked ?? AUTO);
  // One line each, by maker where a plan has several; what each is for stays out of the list.
  const modelOptions: SelectOption[] = [
    ...(kept ? [{ value: kept, label: planModelById(kept)?.label ?? kept }] : []),
    ...models.map((m) => ({
      value: m.value,
      // A plan's model kept by its id reads by its name.
      label: m.label === m.value ? (planModelById(m.value)?.label ?? m.label) : m.label,
      ...(m.maker ? { group: providerLabel(m.maker) } : {}),
    })),
  ];
  const pickModel = (v: string) => {
    if (!row || !shown || v === model) return;
    // Automático picks the effort too; a fixed model after it starts on Médio.
    const effort = isAuto(v) ? AUTO : isAuto(shown.effort) ? "medium" : shown.effort;
    commit({ ...shown, model: v, ...(effort !== undefined ? { effort } : {}) }, row);
  };

  const levels = row ? state.efforts(row, isAuto(model) ? null : (shown?.model ?? null)) : [];
  const autoModel = isAuto(model);
  const effort = row ? effortOf(row.brain, shown?.effort) : null;
  const effortOptions: SelectOption<string>[] = autoModel
    ? [{ value: AUTO, label: t("brain.auto.label") }]
    : [
        // On a key no level is the model's own default: a choice of its own, never an empty field.
        ...(row?.brain === "model" ? [{ value: "", label: t("agentPage.work.brain.efforts.none") }] : []),
        ...levels.map((e) => ({ value: e, label: t(`agentPage.work.brain.efforts.${e}`) })),
      ];
  const pickEffort = (v: string) => {
    if (!row || !shown || autoModel || v === (effort ?? "")) return;
    commit({ ...shown, effort: v ? (v as EffortLevel) : AUTO }, row);
  };

  const showAccount = parts.includes("account");
  const showModel = parts.includes("model") && models.length > 0;
  const showEffort = parts.includes("effort") && levels.length > 0;
  // Nothing to show (a model of its own on a plan without a list, no levels): no empty block in the dialog's rhythm.
  if (!showAccount && !showModel && !showEffort) return null;
  // Codex on a Windows computer without MXC: what its own sandbox holds there, behind Conta's ⓘ.
  const accountHint =
    row && state.sandboxPartial(row)
      ? { name: t("common.about", { label: t("agentPage.work.brain.account") }), text: t("brain.sandboxPartial") }
      : undefined;
  const groupLabel = (g: string) =>
    g === "yours" || g === "others" || g === "keys" ? t(`aiHub.choice.groups.${g}`) : g;
  return (
    <div className={cx("aa-picker", className)} aria-busy={state.loading || undefined}>
      {showAccount && (
        <Field
          label={t("agentPage.work.brain.account")}
          id={`${id}-account`}
          {...(accountHint ? { hint: accountHint } : {})}
        >
          <SearchSelect<string, RowOption>
            className="aa-account"
            value={row?.key}
            onValueChange={pickAccount}
            options={accountOptions}
            disabled={locked}
            defaultOpen={open}
            placeholder={state.loading ? t("common.loading") : t("aiHub.choice.none")}
            labels={{
              search: t("aiHub.choice.search"),
              searchPlaceholder: t("aiHub.choice.search"),
              noResults: t("aiHub.choice.noMatch"),
              empty: t("aiHub.choice.empty"),
              list: t("agentPage.work.brain.account"),
            }}
            groupLabel={groupLabel}
            matches={(o, q) =>
              o.row ? matchesRow(t, o.row, q) : matchesWords(`${o.extra?.name ?? ""} ${o.extra?.meta ?? ""}`, q)
            }
            renderOption={(o) =>
              o.row ? (
                <AccountOption row={o.row} chosen={o.row.key === row?.key} again={again(o.row)} />
              ) : o.extra ? (
                <ExtraOption extra={o.extra} />
              ) : null
            }
            {...(onAdd || onManage
              ? {
                  footer: (close: () => void) => (
                    <>
                      {onAdd && (
                        <button
                          type="button"
                          className="ac-menu__item"
                          onClick={() => {
                            close();
                            onAdd();
                          }}
                        >
                          <Icon name="plus" />
                          <span className="ac-menu__label">
                            <span>{t("aiHub.choice.add")}</span>
                            <span className="ac-menu__desc">{t("aiHub.choice.addLine")}</span>
                          </span>
                        </button>
                      )}
                      {onManage && (
                        <button
                          type="button"
                          className="ac-menu__item"
                          onClick={() => {
                            close();
                            onManage();
                          }}
                        >
                          <Icon name="settings" />
                          <span className="ac-menu__label">{t("aiHub.choice.manage")}</span>
                        </button>
                      )}
                    </>
                  ),
                }
              : {})}
            renderValue={(o) =>
              o?.row ? (
                <span className="aa-value">
                  <span className="ac-select__lead" aria-hidden="true">
                    {o.leading}
                  </span>
                  <RowLine row={o.row} owner={false} />
                </span>
              ) : (
                <span className="ac-select__text">{state.loading ? t("common.loading") : t("aiHub.choice.none")}</span>
              )
            }
          />
        </Field>
      )}
      {(showModel || showEffort) && (
        <div className={cx("aa-pair", !(showModel && showEffort) && "aa-pair--one")}>
          {showModel && (
            <Field
              label={t("agentPage.work.brain.planModel")}
              id={`${id}-model`}
              {...(modelHint
                ? { hint: { name: t("common.about", { label: t("agentPage.work.brain.planModel") }), text: modelHint } }
                : {})}
            >
              <SearchSelect
                value={model}
                onValueChange={pickModel}
                options={modelOptions}
                disabled={locked}
                labels={{
                  search: t("models.search"),
                  searchPlaceholder: t("models.search"),
                  noResults: t("aiHub.choice.noModel"),
                  list: t("agentPage.work.brain.planModel"),
                }}
              />
            </Field>
          )}
          {showEffort && (
            <Field label={t("agentPage.work.brain.effort")} id={`${id}-effort`}>
              <Select
                value={autoModel ? AUTO : (effort ?? (row?.brain === "model" ? "" : undefined))}
                onValueChange={pickEffort}
                options={effortOptions}
                placeholder={t("agentPage.work.brain.efforts.none")}
                disabled={locked || autoModel}
              />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

/** Typed words against a row: its name, maker, plan, whose it is, its key's end. */
const matchesRow = (t: TFunction, row: AiChoiceRow, query: string) =>
  matchesWords(
    [
      rowName(t, row),
      rowMeta(t, row, true),
      row.account?.ownerName,
      row.account ? t(`aiAccounts.connect.${row.account.kind}`) : null,
      row.account?.provider,
      row.apiKey?.provider,
      row.apiKey?.keyHint,
    ]
      .filter(Boolean)
      .join(" "),
    query,
  );

/** The one picker for a target, saving each change (or handing it to `onChange`). */
export function AiChoicePicker({
  orgId,
  target,
  ...rest
}: {
  orgId: string;
  target: AiChoiceTarget;
} & Omit<Parameters<typeof AiChoiceFields>[0], "state">) {
  const state = useAiChoice(orgId, target);
  return <AiChoiceFields state={state} {...rest} />;
}
