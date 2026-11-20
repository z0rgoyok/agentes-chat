import {
  type Agent,
  type AgentBrain,
  type AgentBrainInput,
  keys,
  useAgentBrain,
  useAiAccounts,
  useApi,
  useAuthConfig,
  useModelLabel,
  usePlatformKey,
  useRoles,
  useSetTeamWeekPrefs,
  useSettings,
  useTeamWeekPrefs,
  useUpdateAgent,
  useUpdateSettings,
  useWorkspaceUsesApi,
} from "@agenteschat/client";
import { selfHosted } from "@agenteschat/client/lib/about";
import { accountChoices, accountTitle, ownSignInTitle } from "@agenteschat/client/lib/ai-accounts";
import { agentsReach, audienceOf, audiencePatch, managesAgent } from "@agenteschat/client/lib/audience";
import { modelRows } from "@agenteschat/client/lib/brain-picker";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { readBudget } from "@agenteschat/client/lib/new-agent";
import { rightHandUnusable } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { brainPlan } from "@agenteschat/client/lib/plans";
import { AUTO } from "@agenteschat/client/lib/providers";
import { mineStatus, RIGHT_HAND_POWERS, rightHandNoComputer, rightHandOf } from "@agenteschat/client/lib/right-hand";
import { type LodiPrefsPatch, type LodiSwitch, teamWeekOn } from "@agenteschat/client/lib/right-hand-prefs";
import { helpUrl } from "@agenteschat/client/lib/server";
import { dayText, hourText } from "@agenteschat/client/lib/team-week";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import {
  EmptyState,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  ProviderLogo,
  SectionHeader,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { openAgentEdit } from "../agents/AgentEditScreen";
import { BudgetField } from "../agents/BudgetSection";
import { openAgentAi, openAgentModel } from "../ai/AgentAiScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { openPage, PlanHoldNote, usePlanHold } from "../ai/parts";
import { openComputer } from "../computer/AgentComputerRow";
import { useAgentComputer } from "../computer/useAgentComputer";
import { useFailed } from "../routines/hooks";
import { usePersonalView } from "../settings/hooks";
import { Gap, SettingsPage } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { type Directory, useDirectory, useEdition, useMeId } from "../shared/hooks";
import { type PickLeading, pickOne } from "../shared/PickerSheet";
import { RightHandApprovalsGroup } from "./Approvals";

/** Opens Configurações › the right hand (ADR 0137). */
export const openRightHandSettings = () => router.push("/settings/right-hand" as never);

/**
 * The right hand's settings (ADR 0137), as on the web: its computer when it has one, then three groups, then what only
 * it does. "Só para você": the AI the person's own conversation thinks with, and what it creates and adjusts for them
 * without asking. What it does by itself, each with its switch. "Para todo o workspace", only for who manages agents: its name and look, the AI of people with no plan of their own and
 * the switch that lends it, its monthly budget where something bills per use, and who may use it; one line says it
 * can't be archived or deleted, and its audit log is a tap away. Its instructions are the product's.
 */
export function RightHandSettingsScreen() {
  const { t } = useTranslation();
  const agent = rightHandOf(useDirectory().agents);
  if (!agent)
    return (
      <SettingsPage title={t("settings.section.right_hand")}>
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </SettingsPage>
    );
  return (
    // The budget's number pad and the guidance have no key that closes them: the system's bar over the keyboard does.
    <SettingsPage title={agent.name} subtitle={t("rightHand.label")} toolbar>
      <Computer agentId={agent.id} />
      <SectionHeader title={t("rightHand.settings.groupMine")} />
      <GroupedHeader>{t("rightHand.settings.mine")}</GroupedHeader>
      <RightHandMine agent={agent} />
      <RightHandApprovalsGroup />
      <OwnRows name={agent.name} />
      {managesAgent(agent) ? (
        <>
          {/* Who sees the group, after its name: only who manages it (the server's `canManage`). */}
          <SectionHeader title={`${t("rightHand.settings.groupWorkspace")} · ${t("rightHand.settings.groupAdmins")}`} />
          <Form agent={agent} />
        </>
      ) : null}
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("rightHand.powers.title") }), text: t("rightHand.powers.help") }}
      >
        {t("rightHand.powers.title")}
      </GroupedHeader>
      <GroupedList>
        {RIGHT_HAND_POWERS.map((p) => (
          <GroupedRow key={p.id} icon="check" label={t(`rightHand.powers.${p.id}`)} labelLines={4} />
        ))}
      </GroupedList>
    </SettingsPage>
  );
}

/**
 * "Computador": the row opens the computer every agent's profile opens, which for the right hand is the viewer's own
 * seat on the workspace's computer and nobody else's. Where it has none for anyone (the workspace has no computer of
 * its own, or one that can't keep people apart) the row stays and says why, with nothing to open.
 */
function Computer({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const auth = useAuthConfig();
  const view = useAgentComputer(agentId);
  if (view.forbidden || !view.ready || !view.facts) return null;
  const none = rightHandNoComputer(view.desktopQ.data?.reason, selfHosted(auth.data));
  // No computer of the workspace's own yet: whoever may add one gets there from the row.
  const add = none === "rightHand.computerNoHome" && can(org, "pair_computers");
  return (
    <>
      <Gap />
      <GroupedList>
        {add ? (
          <GroupedRow
            icon="laptop"
            label={t("rightHand.addComputer")}
            chevron
            onPress={() => router.push("/settings/devices")}
          />
        ) : none ? (
          <GroupedRow icon="laptop" label={t("agentComputer.button")} />
        ) : (
          <GroupedRow
            icon="laptop"
            label={t("agentComputer.button")}
            {...(view.machine ? { sub: view.machine.name } : {})}
            chevron
            onPress={() => openComputer(agentId)}
          />
        )}
      </GroupedList>
      <GroupedFooter>
        {none === "rightHand.computerNoHomeServer" ? (
          <Trans
            i18nKey={none}
            components={{
              guide: (
                <Text
                  variant="footnote"
                  accessibilityRole="link"
                  style={styles.link}
                  onPress={() => openPage(helpUrl("install-on-a-server", i18n.language, "computers"))}
                />
              ),
            }}
          />
        ) : (
          t(none ?? "rightHand.computerYours")
        )}
      </GroupedFooter>
    </>
  );
}

/** The model a plan's view runs, by its name (Automático included). */
const planModelLabel = (t: TFunction, view: AgentBrain) =>
  modelRows(t, view, brainPlan(view)).find((r) => r.checked)?.label ?? view.effectiveModel ?? undefined;

/** The choices of "Sua IA": the person's own plan, connecting another one, the workspace's AI. */
const MINE = "mine";
const MODEL = "model";
const OTHER = "other";
const WORKSPACE = "workspace";

/**
 * "Sua IA" (ADR 0137 §11) as one row that opens, as on the web (`mineStatus`): the logo of what answers the person in
 * their own DM with the right hand, its name and what it is to them (Claude, chave do workspace). Its sheet holds the
 * choice, the one in use checked: their own plan and, under it, its model (which opens the model's page), connecting
 * another, or the workspace's AI. When nothing
 * answers them the row is the call to connect a plan. Why it is theirs alone is the row's ⓘ. Everyone has it, on the
 * right hand's profile.
 */
export function RightHandMine({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const failed = useFailed();
  const dir = useDirectory();
  const meId = useMeId();
  const view = useAgentBrain(orgId, agent.id).data;
  const platform = usePlatformKey(orgId).data === true;
  const status = mineStatus(view, meId ?? "", platform, agent.brain?.maker);
  const first = (id: string) => dir.memberById.get(id)?.name.split(" ")[0] ?? "";
  const back = () =>
    void api.agents
      .setBrain(orgId, agent.id, { scope: "mine", brain: "model" })
      .then(() => {
        void qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, agent.id) });
        void qc.invalidateQueries({ queryKey: keys.aiStatus(orgId) });
      })
      .catch(failed);
  if (!status) return null;
  const connect = () => openConnectAi({ agentId: agent.id });
  const hint = {
    name: t("common.about", { label: t("rightHand.settings.mine") }),
    text: t("rightHand.settings.mineHelp", agentGrammar(agent.name)),
  };
  if (status.kind === "nobody")
    return (
      <GroupedList>
        <GroupedRow
          icon="bolt"
          label={t("rightHand.settings.connectMine")}
          sub={t("rightHand.settings.mineNobody")}
          hint={hint}
          chevron
          onPress={connect}
        />
      </GroupedList>
    );
  const own = status.kind === "own";
  const logo =
    status.kind === "key" ? (
      status.provider ? (
        <ProviderLogo id={status.provider} size="sm" />
      ) : null
    ) : (
      <ProviderLogo id={status.brain} size="sm" />
    );
  const label =
    status.kind === "own"
      ? (status.label ?? t(`aiAccounts.connect.${status.brain}`))
      : status.kind === "key"
        ? (status.label ?? t("rightHand.settings.mineKeyName"))
        : t(`aiAccounts.connect.${status.brain}`);
  const model = own && view ? planModelLabel(t, view) : undefined;
  const sub =
    status.kind === "own"
      ? status.ownerId
        ? t("rightHand.settings.mineOf", { owner: first(status.ownerId) })
        : t("rightHand.settings.mineYours")
      : t(status.kind === "key" ? "rightHand.settings.mineKey" : "rightHand.settings.minePlan");
  const leading: PickLeading = logo ? { kind: "node", node: logo } : { kind: "icon", name: "key" };
  const choose = async () => {
    const picked = await pickOne({
      title: t("rightHand.settings.mine"),
      value: own ? MINE : WORKSPACE,
      options: own
        ? [
            { key: MINE, label, sub, leading },
            {
              key: MODEL,
              label: t("agentPage.work.brain.planModel"),
              sub: model,
              leading: { kind: "icon", name: "brain" },
            },
            { key: OTHER, label: t("agentPage.work.brain.connectPlan"), leading: { kind: "icon", name: "plus" } },
            { key: WORKSPACE, label: t("rightHand.settings.useWorkspace"), leading: { kind: "icon", name: "members" } },
          ]
        : [
            { key: MINE, label: t("rightHand.settings.useMine"), leading: { kind: "icon", name: "bolt" } },
            { key: WORKSPACE, label: t("rightHand.settings.useWorkspace"), sub: `${label} · ${sub}`, leading },
          ],
    });
    if (picked === MODEL) openAgentModel(agent.id);
    else if (picked === OTHER || (picked === MINE && !own)) connect();
    else if (picked === WORKSPACE && own) back();
  };
  return (
    <GroupedList>
      <GroupedRow
        {...(logo ? { leading: logo } : { icon: "key" as const })}
        label={label}
        sub={model ? `${sub} · ${model}` : sub}
        hint={hint}
        // The choice opens over the screen, in place: the row's up-down mark, never a chevron (that pushes a screen).
        menu
        onPress={() => void choose()}
      />
    </GroupedList>
  );
}

/** The API key among the plans in the choice of the workspace's AI. */
const KEY = "key";

/**
 * The AI of people with no plan of their own (ADR 0137 §11), as on the web: one row with what it is now (a plan and
 * whose account, or the API key) that opens the choice of the key or a plan the person may set (their own, everyone's
 * with `use_others_plans`). On the key, its model is the row under it. On a plan, the switch that lends it, as for any
 * agent on its owner's plan: the plan's owner chooses, an admin may override, the plan's owner hears it by email.
 */
function WorkspaceAi({ agent, dir }: { agent: Agent; dir: Directory }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const hold = usePlanHold(orgId, org) !== null;
  const api = useApi();
  const qc = useQueryClient();
  const failed = useFailed();
  const meId = useMeId();
  const modelLabel = useModelLabel();
  const aiAccounts = useAiAccounts(orgId).data;
  const edition = useEdition();
  const view = useAgentBrain(orgId, agent.id, true, false, "workspace").data;
  const kind = agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null;
  const signIn = view?.accounts.find((a) => a.id === view.account);
  const key = view?.workspaceAi?.key;
  const [busy, setBusy] = useState(false);
  const set = (input: AgentBrainInput) => {
    setBusy(true);
    void api.agents
      .setBrain(orgId, agent.id, { scope: "workspace", ...input })
      .then(() =>
        Promise.all(
          [keys.agentBrain(orgId, agent.id), keys.agents(orgId), keys.aiStatus(orgId)].map((queryKey) =>
            qc.invalidateQueries({ queryKey }),
          ),
        ),
      )
      .catch(failed)
      .finally(() => setBusy(false));
  };
  const theirs = (id: string | null | undefined) =>
    id && id !== meId ? dir.memberById.get(id)?.name.split(" ")[0] : undefined;
  const plans = (view?.accounts ?? []).filter((a) => a.status === "active");
  // Plans it can't think with now, under the choice with why, as on the web: it stands in on what can meanwhile.
  const cant = rightHandUnusable(aiAccounts, view?.account);
  const away = new Set(cant.flatMap((u) => u.ids));
  // A plan in use that is no longer active stays listed, so the choice never opens with nothing checked. Each plan
  // once, its logins grouped, as on the web.
  const listed = accountChoices(
    (signIn && !plans.some((p) => p.id === signIn.id) ? [signIn, ...plans] : plans).filter((p) => !away.has(p.id)),
    [view?.account],
  ).map((c) => c.login);
  const choose = async () => {
    const picked = await pickOne({
      title: t("rightHand.settings.workspace"),
      value: kind ? (view?.account ?? null) : KEY,
      options: [
        {
          key: KEY,
          label: t("rightHand.settings.mineKeyName"),
          sub: key?.label,
          leading: key
            ? { kind: "node", node: <ProviderLogo id={key.provider} size="sm" /> }
            : { kind: "icon", name: "key" },
        },
        ...listed.map((a) => {
          const owner = theirs(a.ownerId);
          return {
            key: a.id,
            label: t("rightHand.settings.planName", { name: a.label }),
            sub: owner ? t("rightHand.settings.planOwner", { owner }) : undefined,
            leading: { kind: "node" as const, node: <ProviderLogo id={a.kind} size="sm" /> },
          };
        }),
      ],
    });
    if (picked === null) return;
    if (picked === KEY) {
      if (kind) set({ brain: "model" });
      return;
    }
    const plan = listed.find((p) => p.id === picked);
    if (plan && plan.id !== view?.account) set({ brain: plan.kind, account: plan.id });
  };
  const owner = theirs(signIn?.ownerId);
  const g = agentGrammar(agent.name);
  return (
    <>
      <GroupedList>
        <GroupedRow
          {...(kind
            ? { leading: <ProviderLogo id={kind} size="sm" /> }
            : key
              ? { leading: <ProviderLogo id={key.provider} size="sm" /> }
              : { icon: "key" as const })}
          label={
            kind
              ? t("rightHand.settings.planName", { name: signIn?.label ?? t(`aiAccounts.connect.${kind}`) })
              : t("rightHand.settings.mineKeyName")
          }
          labelLines={2}
          {...(kind
            ? owner
              ? { sub: t("rightHand.settings.planOwner", { owner }) }
              : {}
            : key
              ? { sub: key.label }
              : {})}
          // On a billing hold nothing changes before the plan (ADR 0162). The choice opens in place: the up-down mark.
          menu={!hold}
          disabled={busy || hold}
          onPress={() => void choose()}
        />
        {kind ? (
          view ? (
            <GroupedRow
              icon="brain"
              label={planModelLabel(t, view) ?? t("agentPage.work.brain.planModel")}
              chevron
              onPress={() => openAgentModel(agent.id, "workspace")}
            />
          ) : null
        ) : (
          <GroupedRow
            icon="brain"
            label={agent.model === AUTO ? t("brain.auto.label") : (modelLabel(agent.model) ?? agent.model)}
            chevron
            onPress={() => openAgentAi(agent.id)}
          />
        )}
      </GroupedList>
      {hold ? (
        <PlanHoldNote org={org} />
      ) : plans.length === 0 ? (
        <GroupedFooter>{t("rightHand.settings.noPlans", g)}</GroupedFooter>
      ) : null}
      {!hold && cant.length > 0 ? (
        <>
          <GroupedHeader>{t("rightHand.unusable.title", g)}</GroupedHeader>
          <GroupedList>
            {cant.map((u) => {
              if (u.why === "computerOnly")
                return (
                  <GroupedRow
                    key={u.id}
                    leading={<ProviderLogo id={u.own.kind} size="sm" />}
                    label={ownSignInTitle(t, u.own)}
                    sub={t("rightHand.unusable.computerOnly", { ...g, computer: u.own.computer })}
                    subLines={0}
                  />
                );
              const owner = theirs(u.account.ownerId);
              return (
                <GroupedRow
                  key={u.id}
                  leading={<ProviderLogo id={u.account.provider ?? u.account.kind} size="sm" />}
                  label={accountTitle(t, u.account)}
                  sub={
                    owner
                      ? t("rightHand.unusable.away", { owner, computer: u.account.computer })
                      : t("rightHand.unusable.awayYours", { computer: u.account.computer })
                  }
                  subLines={0}
                />
              );
            })}
            {/* Connecting one is self-host's way out: Cloud's own computer is always on. */}
            {can(org, "pair_computers") && edition !== "cloud" && cant.some((u) => u.why === "away") ? (
              <GroupedRow
                icon="plus"
                label={t("rightHand.unusable.connect")}
                chevron
                onPress={() => router.push("/settings/devices")}
              />
            ) : null}
          </GroupedList>
        </>
      ) : null}
    </>
  );
}

function Form({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const toast = useToast();
  const failed = useFailed();
  const usesApi = useWorkspaceUsesApi(orgId);
  const { solo } = usePersonalView();
  const dir = useDirectory();
  const planKind = agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null;
  const roles = useRoles(orgId).data?.roles ?? [];
  const update = useUpdateAgent(orgId, agent.id);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const g = agentGrammar(agent.name);
  const audience = audienceOf(agent);
  const picked = audience.mode === "people" ? audience.roleIds : [];
  const save = (patch: Parameters<typeof update.mutate>[0], saved?: string) =>
    update.mutate(patch, {
      onError: failed,
      ...(saved ? { onSuccess: () => toast({ title: saved, icon: "check" }) } : {}),
    });
  const saveBudget = () => {
    // Read as every agent's budget field reads it (Edit agent's): empty for none, a comma or a point for cents.
    const { amount, invalid } = readBudget(budget);
    if (invalid) {
      toast({ title: t("agent.budgetInvalid"), icon: "x" });
      return;
    }
    // A field saved as it is left: the toast says it took.
    if (amount !== (agent.monthlyBudgetUsd ?? null)) save({ monthlyBudgetUsd: amount }, t("common.saved"));
  };
  // The people picked on the web stay; nobody and no role left picked: everyone again.
  const toggleRole = (id: string) => {
    const roleIds = picked.includes(id) ? picked.filter((r) => r !== id) : [...picked, id];
    const people = roleIds.length > 0 || audience.userIds.length > 0;
    save({
      audience: audiencePatch(people ? { ...audience, mode: "people", roleIds } : { ...audience, mode: "everyone" }),
    });
  };
  const everyone = audience.mode === "everyone";
  // Whether the narrowed audience holds for other agents too, as the web says under it.
  const reach = agentsReach(audience, false, agent.ownerUserId);
  return (
    <>
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("rightHand.settings.name") }),
          text: t("rightHand.settings.nameHelp", { ...g, label: t("rightHand.label") }),
        }}
      >
        {t("rightHand.settings.name")}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          leading={<AgentFace agentId={agent.id} size={36} live={false} />}
          label={agent.name}
          sub={`@${agent.handle}`}
          chevron
          onPress={() => openAgentEdit(agent.id)}
        />
      </GroupedList>

      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("rightHand.settings.workspace") }),
          text: t(planKind ? "rightHand.settings.planHelp" : "rightHand.settings.workspaceHelp", g),
        }}
      >
        {t("rightHand.settings.workspace")}
      </GroupedHeader>
      <WorkspaceAi agent={agent} dir={dir} />

      {usesApi ? (
        <>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("rightHand.settings.budget") }),
              text: t("rightHand.settings.budgetHelp", g),
            }}
          >
            {t("rightHand.settings.budget")}
          </GroupedHeader>
          {/* The same field as every agent's monthly budget, saved as it is left. */}
          <BudgetField
            value={budget}
            onChangeText={setBudget}
            onEndEditing={saveBudget}
            label={t("rightHand.settings.budget")}
            placeholder={t("rightHand.value.budgetDefault")}
          />
        </>
      ) : null}

      {solo ? null : (
        <>
          <GroupedHeader>{t("rightHand.settings.audience")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              icon="members"
              label={t("audience.mode.everyone")}
              checked={everyone}
              onPress={() => !everyone && save({ audience: audiencePatch({ ...audience, mode: "everyone" }) })}
            />
            {roles.map((r) => (
              <GroupedRow key={r.id} label={r.name} checked={picked.includes(r.id)} onPress={() => toggleRole(r.id)} />
            ))}
          </GroupedList>
          <GroupedFooter>
            {t("common.joinSentences", { a: t("rightHand.settings.audienceHelp", g), b: t("audience.rolesHint") })}
            {reach ? ` ${t(`audience.agents.${reach}`, g)}` : ""}
          </GroupedFooter>
        </>
      )}

      <Gap />
      <GroupedList>
        <GroupedRow
          icon="list"
          label={t("rightHand.settings.audit", g)}
          chevron
          onPress={() => router.push({ pathname: "/settings/audit", params: { agent: agent.id } } as never)}
        />
      </GroupedList>
      <GroupedFooter>{t("rightHand.settings.lock", g)}</GroupedFooter>
    </>
  );
}

/**
 * What the right hand does without being asked, one list of rows with a switch each, as on the web (ADR 0177): the
 * daily card for everyone and the weekly card for admins (while one is on, its hour and day under its row), then the
 * switches of whatever else this server has built: the person's own, and the workspace's for who configures it, which
 * say that they are for everyone.
 */
function OwnRows({ name }: { name: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const failed = useFailed();
  const admin = can(org, "administrator");
  const prefs = useTeamWeekPrefs(orgId).data;
  const set = useSetTeamWeekPrefs(orgId);
  const settings = useSettings(orgId).data;
  const setSettings = useUpdateSettings(orgId);
  // The workspace's switches flipped on the tap, by name, while their save is on its way.
  const [flips, setFlips] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  if (!prefs) return null;
  const g = agentGrammar(name);
  // The prefs' save shows a change at once and puts it back if the server refuses it: a row whose own save is on its
  // way waits for it, every other row stays live.
  const savingPrefs = set.isPending ? set.variables : undefined;
  const save = (patch: LodiPrefsPatch) => {
    if (savingPrefs && Object.keys(patch).some((k) => k in savingPrefs)) return;
    void set.mutateAsync(patch).catch(failed);
  };
  const flipSetting = (id: "teamWatch" | "welcomePeople", next: boolean) => {
    if (flips.has(id)) return;
    setFlips((now) => new Map(now).set(id, next));
    void setSettings
      .mutateAsync({ [id]: next })
      .catch(failed)
      .finally(() =>
        setFlips((now) => {
          const left = new Map(now);
          left.delete(id);
          return left;
        }),
      );
  };
  const locale = i18n.language;
  const about = (label: string, text: string) => ({ name: t("common.about", { label }), text });
  // A day or an hour in the app's picker, as the "Your AI" row picks: the one in use checked, a search over the hours.
  const pick = (
    title: string,
    value: number,
    options: { value: number; label: string }[],
    onPick: (v: number) => void,
  ) =>
    void pickOne({
      title,
      value: String(value),
      options: options.map((o) => ({ key: String(o.value), label: o.label })),
    }).then((key) => {
      if (key !== null && Number(key) !== value) onPick(Number(key));
    });
  const hours = () => Array.from({ length: 24 }, (_, h) => ({ value: h, label: hourText(locale, h) }));
  const days = () => [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: d, label: dayText(locale, d) }));
  const dayOn = teamWeekOn(prefs, "day", admin);
  const weekOn = teamWeekOn(prefs, "week", admin);
  const dayLabel = t("teamWeek.settings.dayLabel");
  const weekLabel = t("teamWeek.settings.label");
  const shows = (s: LodiSwitch) => prefs.switches.includes(s);
  const mine = (
    [
      { id: "digest", off: "digestOff", icon: "shield" },
      { id: "reminders", off: "remindOff", icon: "bell" },
    ] as const
  ).filter((r) => shows(r.id));
  const everyones =
    can(org, "configure") && settings
      ? (
          [
            { id: "teamWatch", words: "teamWatch", icon: "eye" },
            { id: "welcomePeople", words: "welcome", icon: "person" },
          ] as const
        ).filter((r) => shows(r.id))
      : [];
  return (
    <>
      <SectionHeader title={t("rightHand.settings.own.title", g)} />
      <GroupedList>
        <GroupedRow
          icon="clock"
          label={dayLabel}
          hint={about(dayLabel, t("teamWeek.settings.dayHelp", g))}
          toggle={dayOn}
          onPress={() => save({ dayOff: dayOn })}
        />
        {dayOn ? (
          <GroupedRow
            label={t("teamWeek.schedule.hour")}
            value={hourText(locale, prefs.dayHour)}
            menu
            onPress={() => pick(t("teamWeek.schedule.hour"), prefs.dayHour, hours(), (dayHour) => save({ dayHour }))}
          />
        ) : null}
        {admin ? (
          <GroupedRow
            icon="clock"
            label={weekLabel}
            hint={about(weekLabel, t("teamWeek.settings.help", g))}
            toggle={weekOn}
            onPress={() => save({ weekOff: weekOn })}
          />
        ) : null}
        {admin && weekOn ? (
          <GroupedRow
            label={t("teamWeek.schedule.day")}
            value={dayText(locale, prefs.day)}
            menu
            onPress={() => pick(t("teamWeek.schedule.day"), prefs.day, days(), (day) => save({ day }))}
          />
        ) : null}
        {admin && weekOn ? (
          <GroupedRow
            label={t("teamWeek.schedule.hour")}
            value={hourText(locale, prefs.weekHour)}
            menu
            onPress={() => pick(t("teamWeek.schedule.hour"), prefs.weekHour, hours(), (weekHour) => save({ weekHour }))}
          />
        ) : null}
        {mine.map((r) => {
          const label = t(`rightHand.settings.own.${r.id}`);
          return (
            <GroupedRow
              key={r.id}
              icon={r.icon}
              label={label}
              hint={about(label, t(`rightHand.settings.own.${r.id}Help`, g))}
              toggle={!prefs[r.off]}
              onPress={() => save({ [r.off]: !prefs[r.off] })}
            />
          );
        })}
        {everyones.map((r) => {
          const label = t(`rightHand.settings.own.${r.words}`);
          const on = flips.get(r.id) ?? settings?.[r.id] !== false;
          return (
            <GroupedRow
              key={r.id}
              icon={r.icon}
              label={label}
              sub={t("rightHand.settings.groupWorkspace")}
              hint={about(label, t(`rightHand.settings.own.${r.words}Help`, g))}
              toggle={on}
              onPress={() => flipSetting(r.id, !on)}
            />
          );
        })}
      </GroupedList>
    </>
  );
}

const styles = StyleSheet.create({
  link: { textDecorationLine: "underline" },
});
