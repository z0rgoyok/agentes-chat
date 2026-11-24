import { useAiChoice, useAiHub } from "@agenteschat/client";
import {
  type AiChoice,
  type AiChoiceRow,
  type AiChoiceTarget,
  aiChoiceOf,
  aiChoiceRows,
} from "@agenteschat/client/lib/ai-choice";
import type { EffortLevel } from "@agenteschat/client/lib/brain-advanced";
import { errorText } from "@agenteschat/client/lib/errors";
import { isAuto } from "@agenteschat/client/lib/providers";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedList, GroupedRow, ProviderLogo, useToast } from "@/ui";
import { useMeId } from "../shared/hooks";
import { type PickOption, pickOne } from "../shared/PickerSheet";
import { choiceText, withModel } from "./hub";

/** An option the caller adds to the "Conta" list (the computer's own sign-in, Conectar uma IA). */
export interface ChoiceExtra {
  option: PickOption;
  /** It is what the target thinks with now: the field shows it. */
  selected?: boolean;
  /** Its models and efforts, when it has some (the computer's own sign-in: that CLI's). */
  row?: AiChoiceRow;
  onPick: () => void;
}

const GROUP_NAMES = { workspace: null, yours: "yours", others: "others", keys: "keys" } as const;

/**
 * The one "Quem pensa" choice on the phone (the web's `<AiChoice>`): Conta, Modelo and Esforço one under the other,
 * each opening its list in the app's sheet (Conta and Modelo searchable, the one in use lit, no column of checks).
 * Accounts that can't think for the target stay listed, faint, with why. The same for an agent, Lodi (`scope`, "A do
 * workspace" first), a mission (no Esforço), several agents and a new agent: those two are the caller's (`value`,
 * `onChange`); the others save at once.
 */
export function AiChoiceFields({
  target,
  value,
  onChange,
  extras = [],
  onAccount,
  disabled = false,
  lockAccount = false,
}: {
  target: AiChoiceTarget;
  /** A choice the caller keeps (several agents, a new agent): shown, and changed through `onChange`. */
  value?: AiChoice | null;
  onChange?: (choice: AiChoice) => void;
  extras?: readonly ChoiceExtra[];
  /** Saves a picked account itself (an agent's: a login lent to one agent asks first). */
  onAccount?: (row: AiChoiceRow) => void;
  disabled?: boolean;
  /** The account (a mission's brain after Start) stays; the model still changes. */
  lockAccount?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const toast = useToast();
  const meId = useMeId();
  const state = useAiChoice(orgId, target);
  const { hub } = useAiHub(orgId);
  const controlled = onChange !== undefined;
  const current = controlled ? (value ?? null) : state.current;
  const rows = controlled ? aiChoiceRows(hub, { target, viewerId: meId ?? "", current }) : state.rows;
  const extraOn = extras.find((e) => e.selected);
  const selected = extraOn ? null : (rows.find((r) => r.selected) ?? null);
  const locked = disabled || !state.canEdit || state.saving;

  const apply = (choice: AiChoice) => {
    if (controlled) return onChange(choice);
    state.save(choice).catch((e: unknown) => toast({ title: errorText(t, e), icon: "x" }));
  };

  const pickAccount = async () => {
    const options: PickOption[] = rows.map((r) => {
      const text = choiceText(t, r, i18n.language);
      const group = GROUP_NAMES[r.group];
      return {
        key: r.key,
        label: text.label,
        ...(text.sub ? { sub: text.sub } : {}),
        ...(text.value ? { value: text.value } : {}),
        keywords: text.keywords,
        ...(group ? { section: t(`mobile.aiHub.choice.${group}`) } : {}),
        ...(text.mark
          ? { leading: { kind: "node" as const, node: <ProviderLogo id={text.mark} size="sm" off={!r.usable} /> } }
          : {
              leading: {
                kind: "icon" as const,
                name: r.type === "workspace" ? ("members" as const) : ("key" as const),
              },
            }),
        disabled: !r.usable,
      };
    });
    const picked = await pickOne({
      title: t("mobile.aiHub.choice.account"),
      options: [...options, ...extras.map((e) => e.option)],
      value: extraOn?.option.key ?? selected?.key ?? null,
      search: true,
      lit: true,
    });
    if (picked === null) return;
    const extra = extras.find((e) => e.option.key === picked);
    if (extra) return extra.onPick();
    const row = rows.find((r) => r.key === picked);
    if (!row || row.key === selected?.key) return;
    if (onAccount && row.type === "plan" && !controlled) return onAccount(row);
    // A choice the caller keeps carries its own model and effort over, not the target's saved one.
    apply(controlled ? aiChoiceOf(row, current) : state.choose(row));
  };

  // The computer's own sign-in has its CLI's models too.
  const active = selected ?? extraOn?.row ?? null;
  const models = active ? state.models(active, t) : [];
  // A choice the caller keeps names its model; with none (the brain's default) the list says which that is.
  const model = models.find((m) => (controlled && current?.model ? m.value === current.model : m.checked)) ?? models[0];
  const pickModel = async () => {
    if (!current) return;
    const picked = await pickOne({
      title: t("mobile.aiHub.choice.model"),
      options: models.map((m) => ({
        key: m.value,
        label: m.label,
        ...(m.sub ? { sub: m.sub } : {}),
        ...(m.maker ? { keywords: m.maker } : {}),
        ...(isAuto(m.value) ? { leading: { kind: "icon" as const, name: "sparkle" as const } } : {}),
      })),
      value: model?.value ?? null,
      search: models.length > 6,
      lit: true,
    });
    if (picked === null || picked === model?.value) return;
    apply(withModel(current, picked));
  };

  const efforts = active && target.kind !== "mission" ? state.efforts(active) : [];
  const effort: EffortLevel | null =
    current?.effort && !isAuto(current.effort)
      ? ((current.effort === "xhigh" ? "high" : current.effort) as EffortLevel)
      : null;
  const effortName = (e: EffortLevel | null) => t(`agentPage.work.brain.efforts.${e ?? "none"}`);
  const pickEffort = async () => {
    if (!current) return;
    const picked = await pickOne({
      title: t("mobile.aiHub.choice.effort"),
      options: efforts.map((e) => ({ key: e, label: effortName(e) })),
      value: effort,
      lit: true,
    });
    if (picked === null || picked === effort) return;
    apply({ ...current, effort: picked as EffortLevel });
  };

  const account = selected ? choiceText(t, selected, i18n.language) : null;
  const autoModel = !model || isAuto(model.value);
  return (
    <GroupedList>
      <GroupedRow
        label={t("mobile.aiHub.choice.account")}
        value={extraOn?.option.label ?? account?.label ?? ""}
        {...(account?.mark ? { valueLeading: <ProviderLogo id={account.mark} size="xs" /> } : {})}
        menu={!lockAccount}
        disabled={locked || lockAccount || state.loading}
        onPress={() => void pickAccount()}
      />
      {models.length > 0 ? (
        <GroupedRow
          label={t("mobile.aiHub.choice.model")}
          value={model?.label ?? ""}
          menu
          disabled={locked}
          onPress={() => void pickModel()}
        />
      ) : null}
      {efforts.length > 0 && !autoModel ? (
        <GroupedRow
          label={t("mobile.aiHub.choice.effort")}
          value={effortName(effort ?? "medium")}
          menu
          disabled={locked}
          onPress={() => void pickEffort()}
        />
      ) : null}
    </GroupedList>
  );
}
