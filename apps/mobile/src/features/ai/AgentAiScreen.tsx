import type { AgentBrain, BrainScope, MachineAccount } from "@agenteschat/client";
import { keys, useAgentBrain, useAiAccounts, useApi, useMachines, useModels } from "@agenteschat/client";
import { CLI_OF_BRAIN } from "@agenteschat/client/lib/activity";
import {
  accountChoices,
  accountInLine,
  offersSignInAgain,
  ownSignInListed,
  ownSignInName,
  signInOf,
} from "@agenteschat/client/lib/ai-accounts";
import { giveBackLogin, loginHolders } from "@agenteschat/client/lib/ai-choice";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { brainLine, thinksWith } from "@agenteschat/client/lib/brain";
import { advancedContents, effortLevelsFor, viewSpeedFits } from "@agenteschat/client/lib/brain-advanced";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { namesText } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiChoiceOf, planOfKind } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { modelLimitText } from "@agenteschat/client/lib/plan-usage";
import {
  brainMissingHint,
  brainPlan,
  geminiPersonal,
  isPlanId,
  planFreeHint,
  planOf,
} from "@agenteschat/client/lib/plans";
import { apiProviderOf, isAuto, providerLabel } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { limitOffers, planState } from "@agenteschat/ui/plan-state";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  Glass,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  insetPastFold,
  motion,
  ProviderLogo,
  SCREEN_X,
  SkeletonList,
  Text,
  useFoldRoom,
  useReducedMotion,
  useTheme,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Gap } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader } from "../shared/parts";
import { PlanMeter, PlanModels } from "../usage/parts";
import { openAgentAddAccount } from "./AgentAddAccountScreen";
import { advancedOf, openAgentAdvanced } from "./AgentAdvancedScreen";
import { openAgentSetup } from "./AgentSetupScreen";
import { AiChoiceFields, AskLine } from "./AiChoice";
import { CliFetchNote } from "./CliFetchNote";
import { EffortRamp, useEffortChoice } from "./EffortRamp";
import {
  accountInput,
  accountKindOf,
  accountSaved,
  agentAccounts,
  agentChain,
  modelInput,
  modelRows,
  modelSections,
  takenFrom,
  thinkingUsage,
} from "./logic";
import { openConnectAi } from "./NoAiCard";
import { Note, PlanHoldNote, usePlanHold } from "./parts";
import { useSaveBrain } from "./useSaveBrain";

/*
 * An agent's AI on the phone (the web's "Quem pensa" for a plan, ADR 0059), from "Pensa com" on its profile, under what
 * thinks in one sentence ("DeepSeek V4.1 Flash pelo OpenCode Go"): the account it thinks with on its computer (one of
 * its owner's, or that computer's own sign-in), one row per account, which is the plan choice (another plan's starts
 * on that plan's default model), then the model, that plan's usage with, at its limit, the owner's other accounts that
 * could think instead, and
 * "Configuração avançada" (ADR 0086: effort, context window, "Atende outras pessoas", "Só esta conta", on a screen of
 * its own). Each choice saves at once. Another AI, or one more login of an account other agents think with where it
 * may have one per agent ("Também usada por Theo"), goes through Connect an AI. Its owner and admins open it; only its
 * owner picks an account or lets other people talk to it on the plan (`canUsePlans`).
 */

/** The "Conta" list's own options: the computer's own sign-in, adding an account, the accounts' own screen. */
const OWN = "own";
const ADD = "add";
const MANAGE = "manage";

/** What an agent thought with, to put back ("Undo"). */
interface Had {
  brain: AgentBrain["brain"];
  account: string | null;
  model: string | null;
}

/**
 * A switch made here, said under the account as the web says it: what changed, with "Undo"; the others of its
 * owner's agents still on the account it left, with "Switch them too"; who that left on the old one.
 */
interface Switched {
  line: string;
  /** The account it thinks with now, in a sentence ("Conta da Ana"). */
  said: string;
  before: Had;
  /** The others "Switch them too" offers: its owner's agents still on the account it left (one that thinks for all). */
  team: { id: string; name: string }[];
  /** The account it left, in a sentence. */
  from: string;
  /** The ones "Switch them too" moved, with what each had. */
  others: (Had & { id: string; name: string })[];
  /** The ones the server kept on the old account. */
  missed: string[];
  /** A login taken from other agents: "Undo" gives it back to them once this one lets go of it. */
  giveBack?: () => Promise<void>;
}

/** Opens an agent's AI. */
export const openAgentAi = (agentId: string) => router.push(`/agent-ai/${agentId}` as never);

/** Opens an agent's model, from its AI. `scope`: which of the right hand's two AIs (its own by default). */
export const openAgentModel = (agentId: string, scope?: BrainScope) =>
  router.push(`/agent-model/${agentId}${scope ? `?scope=${scope}` : ""}` as never);

export function AgentAiScreen({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const hold = usePlanHold(orgId, org);
  const api = useApi();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const meId = useMeId();
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const g = agentGrammar(name);
  const ownerFirst = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  // As on the web: its owner and who manages it (the server's `canManage`) load it, members don't.
  const allowed = (meId !== null && agent?.ownerUserId === meId) || managesAgent(agent);
  const brain = useAgentBrain(orgId, agentId, allowed);
  const { pending, save } = useSaveBrain(agentId);
  const qc = useQueryClient();
  const [switched, setSwitched] = useState<Switched | null>(null);
  // "Add account" opened: what it had and the account it left, so the one a sign-in brings is said on coming back.
  const adding = useRef<{ before: Had; left: MachineAccount | undefined } | null>(null);
  // Looking at the plan: its usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);

  // A pull asks the plans for their usage again and reads the agent's AI again.
  const pull = usePullRefresh(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
    return brain.refetch();
  });
  const view = brain.data;
  const kind = accountKindOf(view?.brain);
  // Its computer's row, where that computer's own sign-in shows once its CLI is signed in.
  const row = useAiAccounts(orgId, view?.canUsePlans === true && kind !== null).data?.computers.find(
    (c) => c.machineId === view?.computer?.machineId,
  );
  const thinks = brainLine(t, agent?.brain, t("brain.model"), { agents: dir.agents });
  // Through the API: its maker's mark.
  const models = useModels().data?.models;
  const thinksMark = thinks.mark ?? apiProviderOf(agent?.model, models ?? []);
  const model = view && kind ? modelRows(t, view, brainPlan(view)).find((r) => r.checked) : undefined;
  const accounts = view && kind ? agentAccounts(view, kind, agent?.ownerUserId, name) : [];
  const current = view ? accounts.find((a) => a.id === view.account) : undefined;
  // Another account, or one more login of `a` other agents use (`also`, its email Claude's hint): Connect an AI on that
  // plan's page (a coding plan's key, on its first page).
  const connect = (a: MachineAccount | undefined, also = false) =>
    openConnectAi({
      agentId,
      ...(kind && !planOf(a?.provider) ? { intent: planOfKind(kind) } : {}),
      ...(also && a?.email ? { email: a.email } : {}),
    });
  const computer = computerNameOf(t, org?.name ?? "", view?.computer?.name ?? "", isPersonal(org));
  // The account picked while its save is on its way, else the saved one: its row is checked on the tap.
  const account = pending.account !== undefined ? pending.account : view?.account;
  // The others of its owner's agents on `left` when it thinks for all of them, for "Switch them too" (as the web's).
  const teamOn = (left: MachineAccount | undefined, next: MachineAccount | null | undefined) =>
    left?.shared === true && (next == null || next.shared === true)
      ? (left.usedByIds ?? []).flatMap((id) => {
          const other = id === agentId ? undefined : dir.agentById.get(id);
          return other && other.ownerUserId === agent?.ownerUserId ? [{ id: other.id, name: other.name }] : [];
        })
      : [];
  const hadNow = (): Had | null => (view ? { brain: view.brain, account: view.account, model: view.model } : null);
  // Someone else's plan, a login another agent thinks with or one at its limit: it asks first, in a line under the
  // list (as the web's Quem pensa).
  const [asking, setAsking] = useState<MachineAccount | null>(null);
  const lentTo = (a: MachineAccount) => !a.mine && a.ownerId !== agent?.ownerUserId;
  // At its limit: the agent would wait there until the plan renews (the web's Quem pensa asks it too).
  const full = (a: MachineAccount) => a.usage != null && planState(a.usage).state === "limited";
  // Another account picked (or taken from the ask line): switched at once and said under it with "Undo", no toast.
  // A login made for one agent thinks for one: picking another agent's takes it from that one, and "Undo" gives it
  // back to them.
  const choose = async (a: MachineAccount | null, asked = false) => {
    const before = hadNow();
    if (!view || !before || (a?.id ?? null) === account) return setAsking(null);
    const others = a ? takenFrom(a, name) : [];
    if (a && !asked && (others.length > 0 || lentTo(a) || full(a))) return setAsking(a);
    setAsking(null);
    const input = accountInput(view, a);
    const left = current;
    const giveBack =
      a && others.length > 0 ? await giveBackLogin(api.agents, orgId, loginHolders(a, agentId)) : undefined;
    const saved = await save(others.length > 0 ? { ...input, moveAccount: true } : input, null);
    if (!saved) return;
    setSwitched({
      line: accountSaved(t, i18n.language, name, a, input, saved),
      said: a ? accountInLine(t, a) : "",
      before,
      ...(giveBack ? { giveBack } : {}),
      team: teamOn(left, a),
      from: left ? accountInLine(t, left) : "",
      others: [],
      missed: [],
    });
  };
  // "Add account": its own screen; coming back with the account a sign-in brought, the change is said here.
  const startAdd = () => {
    const before = hadNow();
    if (!before) return;
    adding.current = { before, left: current };
    openAgentAddAccount(agentId);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the account it thinks with changes
  useEffect(() => {
    const was = adding.current;
    if (!was || !view || view.account === was.before.account) return;
    adding.current = null;
    const now = view.accounts.find((x) => x.id === view.account);
    const said = now ? accountInLine(t, now) : "";
    setSwitched({
      line: t("agentPage.work.brain.v2.added", { ...g, account: said }),
      said,
      before: was.before,
      team: teamOn(was.left, now),
      from: was.left ? accountInLine(t, was.left) : "",
      others: [],
      missed: [],
    });
  }, [view?.account]);
  const refreshAgents = () => {
    for (const key of [keys.agents(orgId), keys.aiAccounts(orgId), keys.aiStatus(orgId)])
      void qc.invalidateQueries({ queryKey: key });
  };
  /** "Switch them too": the others left on the old account onto this one, each by the server's own rules. */
  const switchTeam = async () => {
    if (!switched || switched.team.length === 0 || !view) return;
    // Its row goes on the tap (nothing to press twice); the sentence says what came of it once the server answers.
    const shown = switched;
    setSwitched({ ...shown, team: [] });
    const others = [...shown.others];
    const missed: string[] = [];
    for (const a of shown.team) {
      // What it had, read before anything changes ("Undo" puts it back); one the server refuses keeps its own.
      const was = await api.agents.brain(orgId, a.id).catch(() => null);
      const ok =
        was !== null &&
        (await api.agents.setBrain(orgId, a.id, { brain: view.brain, account: view.account }).then(
          () => true,
          () => false,
        ));
      if (ok && was) others.push({ id: a.id, name: a.name, brain: was.brain, account: was.account, model: was.model });
      else missed.push(a.name);
    }
    refreshAgents();
    const names = [name, ...others.map((o) => o.name)];
    setSwitched({
      ...shown,
      others,
      missed,
      team: [],
      line:
        names.length > 1 ? t("connectAi.doneAll", { names: namesText(t, names, 2), label: shown.said }) : shown.line,
    });
  };
  /** "Undo": each agent the switch changed back to what it had, and a login it took back to the agents it left. */
  const undo = async () => {
    if (!switched) return;
    const { before, others, giveBack } = switched;
    // The card goes on the tap; the toast says it's back once the server has it (and the login is given back).
    setSwitched(null);
    await save(
      before.brain === "model"
        ? { brain: "model" }
        : { brain: before.brain, account: before.account, model: before.model },
      t("agentPage.work.brain.v2.undone"),
      undefined,
      undefined,
      giveBack,
    );
    for (const o of others)
      await api.agents
        .setBrain(orgId, o.id, { brain: o.brain, account: o.account, model: o.model })
        .catch(() => undefined);
    if (others.length > 0) refreshAgents();
  };
  const asked = asking ? takenFrom(asking, name) : [];
  const askLine = asking ? (
    <AskLine
      icon={lentTo(asking) ? "mail" : full(asking) ? "clock" : "info"}
      text={[
        lentTo(asking) ? t("connectAi.chat.told", { name: asking.ownerName?.split(" ")[0] ?? "" }) : null,
        asked[0] ? t("mobile.aiHub.choice.asksMove", { agent: asked[0] }) : null,
        full(asking) ? t("agentPage.work.brain.v2.fullWait", g) : null,
      ]
        .filter(Boolean)
        .join(" ")}
      {...(full(asking)
        ? { link: { label: t("agentPage.work.brain.v2.seeUsage"), onPress: () => router.push("/usage" as never) } }
        : {})}
      action={t("agentPage.work.brain.v2.switchTo", { label: accountInLine(t, asking) })}
      disabled={pending.account !== undefined}
      onPress={() => void choose(asking, true)}
    />
  ) : null;

  const usage = view && kind ? thinkingUsage(view, kind) : undefined;
  const limited = usage ? planState(usage).state === "limited" : false;
  const modelLimit = modelLimitText(t, i18n.language, usage, current?.provider, model?.value);
  const chain = view ? agentChain(view, agentId, agent?.ownerUserId) : { moves: false, waits: false };
  // At its limit with another account of its order that has room, its runs go on there: no way out by hand.
  const waits = limited && (chain.waits || !chain.moves);
  const offers = waits && kind && view ? limitOffers(accounts, kind, view.account).slice(0, 2) : [];
  const signedOut = current != null && signInOf(current) === "signed_out" && current.mine;
  const signInAgain = current != null && offersSignInAgain(current) && current.mine;
  // A coding plan's key that its endpoint refused: a new key, on that plan's page.
  const refused = signInAgain && current && isPlanId(current.provider) ? current.provider : null;
  // Someone else's plans listed for whoever may use them: whose they are, and that their owner hears it.
  const lends = view?.canUseOthersPlans === true && accounts.some((a) => !a.mine && a.ownerId !== agent?.ownerUserId);
  const accountNote = signedOut
    ? t(refused ? "aiAccounts.page.keyRefused" : "agentPage.work.brain.accountSignedOut")
    : current != null && signInOf(current) === "unknown"
      ? t("aiAccounts.page.statusUnknown")
      : waits
        ? t("agentPage.work.brain.v2.fullWait", g)
        : lends
          ? t("agentPage.work.brain.accountOthers")
          : view && !view.canUsePlans && ownerFirst
            ? t("agentPage.work.brain.accountWho", { ...g, owner: ownerFirst })
            : null;
  const ownRow = view !== undefined && kind !== null && ownSignInListed(view, row, kind);
  const choices = view ? accountChoices(accounts, [view.account]) : [];
  const adds = view?.canUsePlans === true && view.canManageAccounts;
  // "Add account" and "Manage accounts" at the list's foot, as on the web: a plan for who may use plans (signing
  // in on another computer when this one is someone else's), a key for who adds the workspace's keys.
  const mayAdd = view !== undefined && !hold && (view.canUsePlans || can(org, "manage_credentials"));
  // On someone else's computer only whoever connected it adds a sign-in: with nothing of the owner's there, why, in
  // place of the list.
  const lockedHere = view !== undefined && kind !== null && !ownRow && choices.length === 0 && !adds;
  const pairer = useMachines(orgId, lockedHere).data?.find((m) => m.id === view?.computer?.machineId)?.pairedBy;

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("mobile.intentAgents.thinks")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        {...(allowed
          ? { refreshControl: <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} /> }
          : {})}
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <View style={styles.hero}>
          {thinksMark ? <ProviderLogo id={thinksMark} size="hero" /> : null}
          <Text variant="title2" tone="ink" style={styles.center}>
            {thinks.text}
          </Text>
        </View>
        {hold ? <PlanHoldNote org={org} inset /> : null}
        {view?.computer?.machineId && view.brain !== "model" ? (
          <CliFetchNote machineId={view.computer.machineId} cli={CLI_OF_BRAIN[view.brain]} />
        ) : null}
        {!allowed ? (
          <Note icon="lock" inset>
            {t("agentPage.lock.admins")}
          </Note>
        ) : brain.isPending ? (
          <SkeletonList rows={3} />
        ) : !view ? (
          <LoadFailed onRetry={() => void brain.refetch()} />
        ) : (
          <>
            {/* Conta, Modelo and Esforço: the one choice every picker shares (`AiChoiceFields`). */}
            <GroupedHeader>{t("agentPage.work.brain.account")}</GroupedHeader>
            <AiChoiceFields
              target={{ kind: "agent", agentId }}
              disabled={pending.account !== undefined}
              ask={askLine}
              onAccount={(r) => {
                const id = r.account?.sameAs ?? r.account?.id;
                const logins = view.accounts.filter((a) => (a.sameAs ?? a.id) === id);
                const login = logins.find((a) => a.usedByIds?.includes(agentId)) ?? logins[0];
                if (login) void choose(login);
              }}
              extras={[
                ...(ownRow && kind
                  ? [
                      {
                        option: {
                          key: OWN,
                          label: ownSignInName(t, view.ownSignIn && view.canUsePlans, computer, kind),
                          leading: { kind: "node" as const, node: <ProviderLogo id={kind} size="sm" /> },
                          section: t("mobile.aiHub.choice.yours"),
                        },
                        selected: account === null,
                        row: {
                          key: OWN,
                          type: "plan" as const,
                          group: "yours" as const,
                          brain: kind,
                          usable: true,
                          selected: true,
                        },
                        onPick: () => void choose(null),
                      },
                    ]
                  : []),
                ...(mayAdd
                  ? [
                      {
                        option: {
                          key: ADD,
                          label: refused
                            ? t("aiAccounts.page.newKey")
                            : signInAgain
                              ? t("agentPage.work.brain.signInAgain")
                              : t("agentPage.work.brain.addAccount"),
                          leading: { kind: "icon" as const, name: "plus" as const },
                          section: " ",
                        },
                        onPick: () =>
                          refused
                            ? openConnectAi({ agentId, plan: refused })
                            : signInAgain
                              ? connect(current)
                              : startAdd(),
                      },
                      {
                        option: {
                          key: MANAGE,
                          label: t("aiHub.choice.manage"),
                          leading: { kind: "icon" as const, name: "key" as const },
                          section: " ",
                        },
                        onPick: () => router.push("/ai-accounts" as never),
                      },
                    ]
                  : []),
              ]}
            />
            {switched ? (
              <View style={styles.notes}>
                <GroupedList>
                  <ChangeRow
                    key="switched"
                    agents={[agentId]}
                    text={switched.line}
                    action={t("agentPage.work.brain.v2.undo")}
                    onPress={() => void undo()}
                  />
                  {switched.missed.length > 0 ? (
                    <ChangeRow
                      key="missed"
                      agents={[]}
                      text={t("agentPage.work.brain.v2.missed", {
                        count: switched.missed.length,
                        names: namesText(t, switched.missed, 2),
                      })}
                    />
                  ) : null}
                  {switched.team.length > 0 ? (
                    <ChangeRow
                      key="team"
                      agents={switched.team.map((a) => a.id)}
                      text={t("agentPage.work.brain.v2.alsoUses", {
                        count: switched.team.length,
                        names: namesText(
                          t,
                          switched.team.map((a) => a.name),
                          2,
                        ),
                        account: switched.from,
                      })}
                      action={t("agentPage.work.brain.v2.alsoSwitch")}
                      onPress={() => void switchTeam()}
                    />
                  ) : null}
                </GroupedList>
              </View>
            ) : null}
            {kind === "antigravity" && geminiPersonal(current) ? (
              <Note icon="info" inset>
                {t("connectAi.plan.gemini.warning")}
              </Note>
            ) : null}
            {lockedHere ? (
              <Note icon="lock" inset>
                {t("connectAi.accountsLocked", { name: pairer?.name.split(" ")[0] ?? "", computer })}
              </Note>
            ) : null}
            {accountNote || chain.moves || model?.needs ? (
              <GroupedFooter>
                {[
                  accountNote,
                  chain.moves && !waits ? t("agentPage.work.brain.movesOn") : null,
                  model?.needs ? t(`brain.modelHow.${model.needs}`) : null,
                ]
                  .filter(Boolean)
                  .join("\n")}
              </GroupedFooter>
            ) : null}
            {usage ? (
              <>
                <GroupedHeader>{t("agentPage.tabs.usage")}</GroupedHeader>
                <GroupedList>
                  <View style={styles.meter}>
                    <PlanMeter usage={usage} />
                    <PlanModels usage={usage} provider={current?.provider ?? null} />
                  </View>
                  {offers.map(({ account: a, used }) => (
                    <GroupedRow
                      key={a.id}
                      leading={<ProviderLogo id={a.provider ?? a.kind} size="sm" />}
                      label={
                        used === null
                          ? t("aiAccounts.usage.offer.useUnknown", { label: a.label })
                          : t("aiAccounts.usage.offer.use", { label: a.label, pct: used })
                      }
                      checked={a.id === account}
                      onPress={() => void choose(a)}
                    />
                  ))}
                  {waits && view.canUsePlans && view.canManageAccounts ? (
                    <GroupedRow
                      icon="plus"
                      label={t("aiAccounts.usage.offer.connect")}
                      onPress={() => connect(current)}
                    />
                  ) : null}
                </GroupedList>
                {modelLimit ? <GroupedFooter>{modelLimit}</GroupedFooter> : null}
              </>
            ) : null}
            <Gap />
            <GroupedList>
              <GroupedRow
                label={t("agentPage.work.brain.advanced.title")}
                sub={advancedContents(t, {
                  kind: view.brain,
                  autoModel: isAuto(view.brain === "model" ? agent?.model : view.effectiveModel),
                  speed: viewSpeedFits(view),
                })}
                chevron
                onPress={() => openAgentAdvanced(agentId)}
              />
              {kind && view.canEdit && (view.account !== null || ownRow) && dir.agents.some((a) => a.id !== agentId) ? (
                <GroupedRow
                  label={t("agentPage.work.brain.copy.row")}
                  sub={t("agentPage.work.brain.copy.rowLine")}
                  chevron
                  onPress={() => openAgentSetup(agentId)}
                />
              ) : null}
            </GroupedList>
            {view.canUsePlans ? (
              <>
                <GroupedHeader>{t("mobile.ai.another")}</GroupedHeader>
                <GroupedList>
                  <GroupedRow
                    icon="brain"
                    label={t("connectAi.titleFor", g)}
                    chevron
                    onPress={() => openConnectAi({ agentId })}
                  />
                </GroupedList>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * One change said under the account, a row of its own card: the agents it is about on top, the sentence, then its
 * button ("Undo", "Switch them too") at a finger's size, never a link inside the words.
 */
function ChangeRow({
  agents,
  text,
  action,
  onPress,
}: {
  agents: string[];
  text: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={styles.change}>
      {agents.length > 0 ? (
        <View style={styles.faces}>
          {agents.map((id, i) => (
            <View key={id} style={i > 0 ? styles.faceOver : null}>
              <AgentFace agentId={id} size={CHANGE_FACE} live={false} />
            </View>
          ))}
        </View>
      ) : null}
      <Text variant="subhead" tone="muted">
        {text}
      </Text>
      {action && onPress ? (
        <View style={styles.changeAct}>
          <Button size="sm" variant="secondary" label={action} onPress={onPress} />
        </View>
      ) : null}
    </View>
  );
}

/** The faces over a change's sentence. */
const CHANGE_FACE = 28;

/** How far the dock travels to leave the screen, past its own height. */
const DOCK_OUT = 28;

/**
 * The effort, floating over the model list in the thumb's reach, whatever is scrolled under it. It slides away with
 * "Automático", which picks the effort too. Folded like a book, the ramp keeps to the half past the fold, so its thumb
 * never slides through the curve (ADR 0212).
 */
function EffortDock({
  agentId,
  scope,
  shown,
  onHeight,
}: {
  agentId: string;
  scope?: BrainScope;
  shown: boolean;
  onHeight: (h: number) => void;
}) {
  const { colors, shadows } = useTheme();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const foldSide = useFoldRoom();
  const dir = useDirectory();
  const { orgId } = useOrg();
  const view = useAgentBrain(orgId, agentId, true, false, scope).data;
  const effort = useEffortChoice(agentId, view ? advancedOf(view).effort : undefined, scope);
  const out = useSharedValue(shown ? 0 : 1);
  const height = useSharedValue(0);
  // A drawer's slide (`motion.sheet`); with reduced motion it is simply there or gone.
  useEffect(() => {
    out.set(reduced ? (shown ? 0 : 1) : withSpring(shown ? 0 : 1, motion.sheet));
  }, [shown, reduced, out]);
  const slid = useAnimatedStyle(() => ({
    transform: [{ translateY: out.get() * (height.get() + insets.bottom + DOCK_OUT) }],
  }));
  return (
    <Animated.View
      pointerEvents={shown ? "auto" : "none"}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      onLayout={(e) => {
        height.set(e.nativeEvent.layout.height);
        onHeight(e.nativeEvent.layout.height);
      }}
      style={[
        styles.dock,
        { bottom: insets.bottom + 8, boxShadow: shadows.e2 },
        foldSide && insetPastFold(foldSide, SCREEN_X),
        slid,
      ]}
    >
      <Glass liquid intensity={70} style={[styles.dockGlass, { borderColor: colors.line2 }]}>
        <EffortRamp
          value={effort.value}
          onChange={effort.change}
          levels={
            view
              ? effortLevelsFor(
                  view.brain,
                  view.brain === "model" ? dir.agentById.get(agentId)?.model : view.effectiveModel,
                  view.options,
                )
              : []
          }
          kind={view?.brain}
          color={agentLook(dir.agentById.get(agentId)).color}
          disabled={view?.canEdit !== true}
        />
      </Glass>
    </Animated.View>
  );
}

/**
 * The agent's model, pushed from its AI ("Modelo"): Automático, or one of its brain's models (every model of its
 * coding plan, with what each is sold as), and with a fixed model how hard it thinks. A tap saves at once.
 */
export function AgentModelScreen({ agentId, scope }: { agentId: string; scope?: BrainScope }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const g = agentGrammar(dir.agentById.get(agentId)?.name ?? "");
  const brain = useAgentBrain(orgId, agentId, true, false, scope);
  const pull = usePullRefresh(brain.refetch);
  const { pending, save } = useSaveBrain(agentId, scope);
  // The model tapped while its save is on its way: its row is checked on the tap, and the effort follows it.
  const [tapped, setTapped] = useState<string | null>(null);
  const picked = pending.model !== undefined ? tapped : null;
  // Opened straight from a link too: the plans' lists come with it.
  useModels();
  const view = brain.data;
  const plan = view ? brainPlan(view) : undefined;
  const rows = view ? modelRows(t, view, plan) : [];
  const freeHint =
    planFreeHint(t, plan) ??
    brainMissingHint(
      t,
      view?.options.find((o) => o.kind === view.brain && !plan),
    );
  // A model without a maker of its own wears its plan's mark, else its brain's.
  const mark = (plan && view?.accounts.find((a) => a.id === view.account)?.provider) || (view?.brain ?? "");
  const hasModels = view !== undefined && view.brain !== "model";
  const fixed = hasModels && !isAuto(picked ?? view.effectiveModel);
  const [dock, setDock] = useState(0);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("agentPage.work.brain.planModel")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 + (fixed ? dock : 0) }]}
      >
        {brain.isPending ? (
          <SkeletonList rows={4} />
        ) : !view || view.brain === "model" ? (
          // An agent on an API key has no plan's models to pick here: what opened this can't be shown, as a failed load.
          <LoadFailed onRetry={() => void brain.refetch()} />
        ) : (
          modelSections(rows).map((s) => (
            <Fragment key={s.maker ?? ""}>
              {s.maker ? <GroupedHeader>{providerLabel(s.maker)}</GroupedHeader> : null}
              <GroupedList>
                {s.rows.map((r) => {
                  const checked = picked !== null ? r.value === picked : r.checked;
                  return (
                    <GroupedRow
                      key={r.value}
                      label={r.label}
                      {...(r.sub ? { sub: r.sub } : {})}
                      {...(r.note ? { hint: { name: t("common.about", { label: r.label }), text: r.note } } : {})}
                      {...(isAuto(r.value)
                        ? { icon: "sparkle" as const }
                        : { leading: <ProviderLogo id={r.maker ?? mark} size="sm" /> })}
                      checked={checked}
                      disabled={!view.canEdit}
                      onPress={() => {
                        if (checked) return;
                        const ai = aiChoiceOf(view);
                        const done = t("agentPage.work.saved.brain", {
                          ...g,
                          brain: ai === "key" ? r.label : thinksWith(t, ai, r.label),
                        });
                        setTapped(r.value);
                        void save(modelInput(r.value, view), done);
                      }}
                    />
                  );
                })}
              </GroupedList>
            </Fragment>
          ))
        )}
        {view && freeHint ? (
          <Note icon="info" inset>
            {freeHint}
          </Note>
        ) : null}
      </ScrollView>
      {hasModels ? <EffortDock agentId={agentId} scope={scope} shown={fixed} onHeight={setDock} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  hero: { alignItems: "center", gap: 10, paddingTop: 6, paddingBottom: 4 },
  center: { textAlign: "center" },
  // On a grouped row's edges, as the rows under it.
  meter: { paddingHorizontal: GROUPED_ROW.padX, paddingVertical: 12, gap: 10 },
  notes: { marginTop: 12 },
  // A change's row: its faces, its sentence and its button one under the other, on the rows' edges.
  change: { paddingHorizontal: GROUPED_ROW.padX, paddingTop: 14, paddingBottom: 16, gap: 8, alignItems: "flex-start" },
  faces: { flexDirection: "row" },
  faceOver: { marginLeft: -6 },
  changeAct: { marginTop: 4 },
  // Floating over the list on the screen's own sides, as everything else on it.
  dock: { position: "absolute", left: SCREEN_X, right: SCREEN_X, borderRadius: 28 },
  dockGlass: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});
