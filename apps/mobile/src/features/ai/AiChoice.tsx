import { useAiChoice, useAiHub, useApi } from "@agenteschat/client";
import {
  type AiChoice,
  type AiChoiceRow,
  type AiChoiceTarget,
  aiChoiceAsks,
  aiChoiceOf,
  aiChoiceRows,
  giveBackLogin,
  loginHolders,
} from "@agenteschat/client/lib/ai-choice";
import { type EffortLevel, effortLevel, shownEffort } from "@agenteschat/client/lib/brain-advanced";
import { errorText } from "@agenteschat/client/lib/errors";
import { isAuto } from "@agenteschat/client/lib/providers";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, GroupedList, GroupedRow, ProviderLogo, Text, useToast } from "@/ui";
import { useMeId } from "../shared/hooks";
import { type PickOption, pickOne } from "../shared/PickerSheet";
import { choiceText, withModel } from "./hub";
import { Note } from "./parts";

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
 * `onChange`); the others save at once, said with Desfazer. Someone else's plan and a login another agent thinks with
 * ask first, in one line under the list with one button (`AskLine`); `ask` is a caller's own line there.
 */
export function AiChoiceFields({
  target,
  value,
  onChange,
  extras = [],
  onAccount,
  ask,
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
  /** A line under the list (an `onAccount` caller's own "asks first"). */
  ask?: ReactNode;
  disabled?: boolean;
  /** The account (a mission's brain after Start) stays; the model still changes. */
  lockAccount?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
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

  const [asking, setAsking] = useState<AiChoiceRow | null>(null);
  const agentId = target.kind === "agent" || target.kind === "lodi" ? target.agentId : "";
  const asks = asking ? aiChoiceAsks(asking, agentId) : null;
  const failed = (e: unknown) => toast({ title: errorText(t, e), icon: "x" });
  /** `giveBack`: a login taken from other agents, which Desfazer gives back to them once this one lets go of it. */
  const apply = (choice: AiChoice, giveBack?: () => Promise<void>) => {
    if (controlled) return onChange(choice);
    const before = state.current;
    setAsking(null);
    state.save(choice).then(() => {
      if (!before) return;
      toast({
        title: t("common.saved"),
        icon: "check",
        action: {
          label: t("agentPage.work.brain.v2.undo"),
          onPress: () =>
            void state
              .save(before)
              .then(() => giveBack?.())
              .then(() => toast({ title: t("agentPage.work.brain.v2.undone"), icon: "check" }), failed),
        },
      });
    }, failed);
  };

  /** A pick asked first: someone else's plan, or a login taken from the agents that think with it. */
  const take = async (row: AiChoiceRow, moves: boolean) => {
    // Its button goes at once: a second tap while the agents losing it are read would take it twice.
    setAsking(null);
    if (!moves || !row.account) return apply(state.choose(row));
    const giveBack = await giveBackLogin(api.agents, orgId, loginHolders(row.account, agentId));
    apply({ ...state.choose(row), moveAccount: true }, giveBack);
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
    if (!row || row.key === selected?.key) return setAsking(null);
    if (onAccount && row.type === "plan" && !controlled) return onAccount(row);
    if (!controlled && aiChoiceAsks(row, agentId)) return setAsking(row);
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

  const efforts =
    active && target.kind !== "mission"
      ? state.efforts(active, isAuto(model?.value) ? null : (model?.value ?? null))
      : [];
  const effort: EffortLevel | null =
    current?.effort && !isAuto(current.effort) ? shownEffort(effortLevel(current.effort), efforts) : null;
  const effortName = (e: EffortLevel | null) => t(`agentPage.work.brain.efforts.${e ?? "none"}`);
  const pickEffort = async () => {
    if (!current) return;
    const picked = await pickOne({
      title: t("mobile.aiHub.choice.effort"),
      options: efforts.map((e) => ({ key: e, label: effortName(e) })),
      value: effort,
      lit: true,
    });
    // Against what is stored, not shown: a stored level the model doesn't take shows as the one under it, which then
    // saves when picked.
    if (picked === null || picked === current.effort) return;
    apply({ ...current, effort: picked as EffortLevel });
  };

  const account = selected ? choiceText(t, selected, i18n.language) : null;
  const autoModel = !model || isAuto(model.value);
  // Codex on a Windows computer without MXC: what its own sandbox holds there, behind Conta's ⓘ.
  const partial =
    active && state.sandboxPartial(active)
      ? { name: t("common.about", { label: t("mobile.aiHub.choice.account") }), text: t("brain.sandboxPartial") }
      : null;
  return (
    <>
      <GroupedList>
        <GroupedRow
          label={t("mobile.aiHub.choice.account")}
          value={extraOn?.option.label ?? account?.label ?? ""}
          {...(partial ? { hint: partial } : {})}
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
      {asking && asks ? (
        <AskLine
          icon={asks.owner ? "mail" : "info"}
          text={[
            asks.owner ? t("connectAi.chat.told", { name: asks.owner }) : null,
            asks.takesFrom ? t("mobile.aiHub.choice.asksMove", { agent: asks.takesFrom }) : null,
          ]
            .filter(Boolean)
            .join(" ")}
          action={t("agentPage.work.brain.v2.switchTo", { label: choiceText(t, asking, i18n.language).label })}
          disabled={locked}
          onPress={() => void take(asking, Boolean(asks.takesFrom))}
        />
      ) : (
        ask
      )}
    </>
  );
}

/** A pick that asks first: why, in a line under the list, and its one button (the web's `SettingNote` with an action). */
export function AskLine({
  icon,
  text,
  link,
  action,
  disabled = false,
  onPress,
}: {
  icon: "mail" | "info" | "clock";
  text: string;
  /** A link after the words ("Ver uso"). */
  link?: { label: string; onPress: () => void };
  action: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <>
      <Note icon={icon} live inset>
        {text}
        {link ? (
          <>
            {" "}
            <Text variant="small" accessibilityRole="link" style={styles.link} onPress={link.onPress}>
              {link.label}
            </Text>
          </>
        ) : null}
      </Note>
      <View style={styles.ask}>
        <Button variant="primary" label={action} wide disabled={disabled} onPress={onPress} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // Under its line, on the groups' sides.
  ask: { paddingHorizontal: 16, paddingTop: 12 },
  link: { textDecorationLine: "underline" },
});
