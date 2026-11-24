import type { AiChoiceState } from "@agenteschat/client";
import { useAiChoice } from "@agenteschat/client";
import {
  type AiChoice,
  type AiChoiceRow,
  type AiChoiceTarget,
  accountShortName,
  aiChoiceOf,
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
 * this only draws them. Conta is a searchable select of one-line rows (the name, its plan and whose it is muted, its
 * room at the end); an account that can't think here stays in the list, dimmed, with why.
 */

export type AiChoicePart = "account" | "model" | "effort";
const ALL_PARTS: readonly AiChoicePart[] = ["account", "model", "effort"];

/** The row a choice stands for: an account by any of its logins, a key, a mission's brain, Lodi's "A do workspace". */
export function rowOfChoice(rows: readonly AiChoiceRow[], c: AiChoice | null | undefined): AiChoiceRow | undefined {
  if (!c) return undefined;
  return rows.find((r) => {
    if (r.type === "plan")
      return c.brain !== "model" && !!c.account && (r.account?.id === c.account || r.account?.sameAs === c.account);
    if (r.type === "key") return c.brain === "model" && (c.key ? r.apiKey?.id === c.key : r.apiKey?.isDefault === true);
    if (r.type === "workspace") return c.brain === "model";
    return r.brain === c.brain;
  });
}

/** A row's name: the account's, the key's, a brain's maker, "A do workspace". */
export function rowName(t: TFunction, row: AiChoiceRow): string {
  if (row.account) return accountShortName(t, row.account);
  if (row.apiKey) return row.apiKey.label;
  if (row.type === "workspace") return t("aiHub.choice.workspace");
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
  if (row.apiKey) return row.apiKey.endpoint ? row.apiKey.endpoint.baseURL : t("aiHub.apiKey");
  // A plan through its computer's own sign-in.
  if (row.type === "brain" && row.brain !== "model") return t("brain.picker.ownSignIn");
  return "";
}

/** A row's end: why it can't be used, else its room (the window closest to its limit), or nothing. */
function RowEnd({ row }: { row: AiChoiceRow }) {
  const { t, i18n } = useTranslation();
  if (!row.usable) return <span className="aa-room">{reasonText(t, row)}</span>;
  const usage = row.account?.usage;
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

/** One option of Conta: the mark, the name, then its plan and owner muted, the room at the end; one line. */
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

type RowOption = SelectOption & { row: AiChoiceRow };

/**
 * The selects of a choice, drawn from its state. `value`/`onChange`: the caller keeps the choice (a new agent, several
 * agents) and nothing saves here; else each change saves at once. `onAccount`: an account picked, for a caller with its
 * own way to switch (an agent's "Quem pensa": who else moves with it, signing in, undoing).
 */
export function AiChoiceFields({
  state,
  parts = ALL_PARTS,
  value,
  onChange,
  onAccount,
  onSaved,
  modelHint,
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

  const accountOptions: RowOption[] = state.rows.map((r) => ({
    value: r.key,
    label: rowName(t, r),
    // Lodi's "A do workspace" stands first on its own, with no heading.
    ...(r.group !== "workspace" ? { group: r.group } : {}),
    leading: rowMark(r),
    disabled: !r.usable,
    row: r,
  }));
  const pickAccount = (key: string) => {
    const next = state.rows.find((r) => r.key === key);
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

  const levels = row ? state.efforts(row) : [];
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
  const groupLabel = (g: string) =>
    g === "yours" || g === "others" || g === "keys" ? t(`aiHub.choice.groups.${g}`) : g;
  return (
    <div className={cx("aa-picker", className)} aria-busy={state.loading || undefined}>
      {showAccount && (
        <Field label={t("agentPage.work.brain.account")} id={`${id}-account`}>
          <SearchSelect<string, RowOption>
            className="aa-account"
            value={row?.key}
            onValueChange={pickAccount}
            options={accountOptions}
            disabled={locked}
            placeholder={state.loading ? t("common.loading") : t("aiHub.choice.none")}
            labels={{
              search: t("aiHub.choice.search"),
              searchPlaceholder: t("aiHub.choice.search"),
              noResults: t("aiHub.choice.noMatch"),
              list: t("agentPage.work.brain.account"),
            }}
            groupLabel={groupLabel}
            matches={(o, q) => matchesRow(t, o.row, q)}
            renderOption={(o) => (
              <>
                <span className="ac-menu__leading" aria-hidden="true">
                  {o.leading}
                </span>
                <RowLine row={o.row} owner />
              </>
            )}
            renderValue={(o) =>
              o ? (
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
