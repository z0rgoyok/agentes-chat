import type { BrainScope, Credential, Edition, Machine, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import {
  keys,
  useAgentBrain,
  useAgents,
  useAiAccounts,
  useApi,
  useCheckMachineClis,
  useCliInstall,
  useComputerSetup,
  useCredentials,
  useMachines,
  useModels,
} from "@agenteschat/client";
import {
  accountInLine,
  accountTitle,
  type ExistingAi,
  groupPlans,
  listsExisting,
  planWordOf,
  signInPlan,
  unnamedAccount,
  withSub,
} from "@agenteschat/client/lib/ai-accounts";
import { computerEdition, computerName, managedNamed, setupView } from "@agenteschat/client/lib/computer";
import { CUSTOM_PROVIDER } from "@agenteschat/client/lib/endpoints";
import { errorText, holdText, keyRefusal } from "@agenteschat/client/lib/errors";
import { firstName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  brainTool,
  CLI_GIT_MISSING,
  cliInstallFailure,
  cliOneClick,
  GIT_FOR_WINDOWS_URL,
  installableCli,
} from "@agenteschat/client/lib/machines";
import {
  type AiChoice,
  behindComputer,
  catchUp,
  dimmedLine,
  type ExistingSignIn,
  firstAgent,
  freePlanAccount,
  gateDims,
  gateLine,
  kindOf,
  ownSignInFor,
  PLAN_CHOICES,
  type PlanChoice,
  type PlanGate,
  planGate,
  planGateWithoutAgent,
  planHoldPhoneLine,
  planLabel,
  planMark,
  planOfAccount,
  planPickText,
} from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { geminiPersonal, isPlanId, planOf, providerFitsChoice, signInProviderOf } from "@agenteschat/client/lib/plans";
import {
  keyLooksValid,
  keyName,
  keyStepHint,
  keyThinks,
  PROVIDERS,
  providerLabel,
  providerOf,
  providersForKey,
} from "@agenteschat/client/lib/providers";
import { agentOnKey, rightHandOnKey, savedKeyLine, thinksWithLine } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { paysHere } from "@/lib/store";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  InfoHint,
  Locked,
  ProviderLogo,
  SkeletonList,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { goBack, router } from "@/ui/navigation";
import { SetupWait } from "../computer/SetupWait";
import { closeAgentPick, openAgentPick } from "../dashboards/agent-pick";
import { ToolOffWayOut } from "../devices/ToolOneClick";
import { AgentFace } from "../shared/Face";
import { useMeId } from "../shared/hooks";
import { PickList } from "../shared/PickList";
import { AddAccount } from "./AddAccount";
import type { ConnectKey } from "./ConnectAi";
import { type ConnectAiFlow, connectAiNow, type PushedPage, patchConnectAi } from "./connect-flow";
import { EndpointForm } from "./EndpointForm";
import {
  existingNotes,
  existingRows,
  type FlowView,
  haveLayout,
  offersKeyNow,
  PLAN_POLL_MS,
  pollsPlan,
  takenFrom,
} from "./logic";
import { useAiOrg } from "./org";
import {
  AiRow,
  alertKeyRefused,
  Note,
  OpenPage,
  openRenameAiAccount,
  PasteField,
  PlanHoldNote,
  PlanReplies,
  Step,
  StepsCard,
  usePlanHold,
} from "./parts";

/*
 * "Conectar uma IA" on the phone: the web's content and rules (ADR 0059, ADR 0061) in the app's own line. The first
 * page is grouped lists like iOS Settings: what the person already has (for an agent with no AI), your AI plan and pay
 * as you go (the API key), one row each. Each pushes its page over it, the system's back going back a page: the plans
 * with a search, then a plan's mark, for which agent, and its numbered steps on the agent's computer (or why they
 * wait); the key's maker, chosen the same way, where its keys are made, and the key. A plan signs in on the agent's
 * computer: with none, "Conectar um computador", and the key stays one tap away.
 */

/**
 * What each plan can do now for one agent (`planGate`), from its brain view, its computer's row and the setup.
 * `poll`: asked again this often while a plan waits (the first run opens no socket, so nothing else keeps them
 * current there).
 */
export function usePlanGates(orgId: string, agentId: string | undefined, poll: number | false = false) {
  const api = useApi();
  const { org } = useAiOrg();
  const asks = agentId !== undefined;
  const brain = useAgentBrain(orgId, agentId ?? "", asks, poll);
  const ai = useAiAccounts(orgId, asks, poll);
  // Codex's own sign-in is known only by a usage read with it: looked up again here (it comes back as
  // `machine.updated`, or with the next poll), so a computer's own ChatGPT sign-in shows before any turn ran.
  useEffect(() => {
    if (asks) void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId, asks]);
  const setupQ = useComputerSetup(orgId, true, poll);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const view = brain.data;
  const row = ai.data?.computers.find((c) => c.machineId === view?.computer?.machineId);
  // Once ready, the workspace's computer is every agent's: a view from before that still has none is asked again
  // now with the accounts (a coding plan reads that computer's row there), not at their next poll. Until both
  // answers are in (`catchUp`, bounded), every plan reads as ready with its sign-in loading, as the rest of the page
  // says ready. Asked once per agent: still none after it, and nothing is coming (`caughtUp`).
  const behind = behindComputer({ edition, setup, brain: view });
  const [caughtUp, setCaughtUp] = useState<string>();
  const caught = agentId !== undefined && caughtUp === agentId;
  const [asking, setAsking] = useState(false);
  const { refetch: brainAgain } = brain;
  const { refetch: accountsAgain } = ai;
  useEffect(() => {
    if (!behind || caught) return;
    setAsking(true);
    void catchUp([brainAgain(), accountsAgain()]).then(() => {
      setAsking(false);
      setCaughtUp(agentId);
    });
  }, [behind, caught, agentId, brainAgain, accountsAgain]);
  const catching = (behind && !caught) || asking;
  const gateOf = (choice: PlanChoice): PlanGate =>
    catching
      ? { state: "ready" }
      : planGate({
          choice,
          edition,
          setup,
          // A coding plan also needs to know whether that computer takes a plan's key, and Claude or ChatGPT on a
          // computer the person connected whether its own sign-in is there (`ownSignInFor`).
          brain: view && (ai.data || !(isPlanId(choice) || view.ownSignIn)) ? view : undefined,
          computer: row,
          caughtUp: caught,
          standing: org?.standing,
        });
  // A poll that fails once keeps the last view: a sign-in in progress goes on. A read that failed with nothing to show
  // ends the page's wait with Tentar de novo.
  const failed = (brain.isError && !view) || (ai.isError && !ai.data) || (setupQ.isError && !setupQ.data);
  const { refetch: setupAgain } = setupQ;
  const retry = useCallback(() => {
    for (const again of [brainAgain, accountsAgain, setupAgain]) void again();
  }, [brainAgain, accountsAgain, setupAgain]);
  return { gateOf, view, row, failed, retry, edition, catching };
}

export type PlanGates = ReturnType<typeof usePlanGates>;

/** `usePlanGates` for a person who owns no agent yet: each plan's gate on the computer it would sign in on. */
export function useGatesWithoutAgent(orgId: string, on: boolean) {
  const { org } = useAiOrg();
  const ai = useAiAccounts(orgId, on);
  const machines = useMachines(orgId, on);
  const setupQ = useComputerSetup(orgId, on);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const at = (choice: PlanChoice) =>
    planGateWithoutAgent({
      choice,
      edition,
      setup,
      computers: ai.data?.computers,
      machines: machines.data,
      standing: org?.standing,
    });
  return { at, edition, accounts: ai.data?.accounts };
}

type GatesWithoutAgent = ReturnType<typeof useGatesWithoutAgent>;

/** The page an intent opens on (a message that asked for a plan or a key). */
export const viewOf = (choice: AiChoice | null): FlowView =>
  !choice ? { page: "home" } : choice === "key" ? { page: "key" } : { page: "plan", choice };

export interface ConnectAiFlowProps {
  /** The page this screen is. */
  view: FlowView;
  /** The next page, pushed over this one (the system's back comes back). */
  go: (next: PushedPage) => void;
  /** The flow the pages share (`connect-flow.ts`): the agent picked, a row's sign-in, the key being typed. */
  flowId: string;
  flow: ConnectAiFlow;
  /** The person's agents a plan may think for, in the order offered. */
  agents: { id: string; name: string }[];
  /** Whether an agent already thinks with something (a plan starts on the first one without). */
  hasAi: (agentId: string) => boolean;
  /** The agent to start on (a card that names one). */
  startAgentId?: string;
  /**
   * Claude's sign-in is one more login of the account with this email, one other agents use ("Também usada por"): its
   * hint, checked when it comes back, never the agent's own signed-out login again.
   */
  email?: string;
  /**
   * One of the person's logins to sign in again on its plan's page (Settings' Sign in again, a coding plan's new key):
   * that exact login, its email Claude's hint, for the agent that thinks with it or, with no agent, by itself.
   */
  again?: { id: string; choice: PlanChoice; email: string | null };
  /** Why this person connects no plan here (someone else's agent, or none of their own among those named). */
  locked?: ReactNode;
  /**
   * The person owns no agent yet and the flow isn't for anyone's: a plan signs in on a computer they may add accounts
   * to, for the agents they create (`onAccount` once it's in).
   */
  bare?: boolean;
  onAccount?: () => void;
  /** Someone else's agent the flow is for, to an admin: its owner's accounts shown locked, and the workspace's keys. */
  theirs?: { id: string; name: string };
  /** Only an admin adds an API key. */
  mayAddKey: boolean;
  /** The key being typed and its save (`useConnectKey`). */
  keyForm: ConnectKey;
  keySaved?: boolean;
  onSaveKey?: () => void;
  /** An endpoint ("Outro provedor") was saved on the key page, with its models' tests. */
  onEndpointSaved?: (key: Credential) => Promise<void>;
  /** Before saving, whom the key will think for, in place of the usual line. */
  keyForLine?: string;
  /** The person came because the computer just got ready: said first, once it is. */
  justReady?: boolean;
  /** Self-host with no computer for the agent: where one is connected. */
  onComputer: () => void;
  /** The agent thinks with what was connected here now: a plan, or a row of what the person already had. */
  onPlanDone: (agentId: string) => void;
}

/**
 * One page of the flow, on its own pushed screen (Connect an AI's routes), which draws the bar. The agent a plan is
 * for and what each plan can do for it are worked out on every page from what the flow shares: the first page and the
 * plans dim a plan that can't sign in there, and a plan's page that waited for the computer says it's ready when a
 * plan's page shows again. For an agent with no AI, the first page starts with what the person already has
 * (`existingRows`): an account used or moved in one tap, signed in once more on its plan's page, a key.
 */
export function ConnectAiPage(props: ConnectAiFlowProps) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useAiOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { view, go, flowId, flow, agents, hasAi, startAgentId, locked, theirs, mayAddKey } = props;
  // Only a pick is kept; else the first agent is worked out on each render (the agents may load after this opens).
  const pickedAgent = flow.pickedAgent ?? undefined;
  const setPickedAgent = useCallback(
    (id: string | undefined) => patchConnectAi(flowId, { pickedAgent: id ?? null }),
    [flowId],
  );
  const agentId = locked ? undefined : (pickedAgent ?? firstAgent(agents, hasAi, startAgentId)?.id);
  const forAgent = agents.find((a) => a.id === agentId) ?? theirs;
  const [polls, setPolls] = useState(false);
  const gates = usePlanGates(orgId, forAgent?.id, polls ? PLAN_POLL_MS : false);
  const bareGates = useGatesWithoutAgent(orgId, props.bare === true);
  const machines = useMachines(orgId);
  const gateAt = (choice: PlanChoice) => (agentId !== undefined ? gates.gateOf(choice) : bareGates.at(choice).gate);
  const machineAt = (choice: PlanChoice) => {
    const id = (gates.view?.computer ?? bareGates.at(choice).computer)?.machineId;
    return machines.data?.find((m) => m.id === id);
  };
  // The workspace's keys, offered for an agent to think with, to who may add them, as on the web.
  const credentials = useCredentials(orgId, mayAddKey && forAgent !== undefined);
  const agentRows = useAgents(orgId);
  const models = useModels();
  // A plan's page signs in what a row of the first page asked for, as it was when the page was pushed.
  const [login] = useState(() => (view.page === "plan" && flow.login?.choice === view.choice ? flow.login : null));
  const [busy, setBusy] = useState(false);
  const lists =
    forAgent &&
    gates.view?.agentId === forAgent.id &&
    listsExisting(
      agentRows.data?.find((a) => a.id === forAgent.id),
      !hasAi(forAgent.id),
    )
      ? { view: gates.view, name: forAgent.name }
      : null;
  const have = lists ? existingRows(t, lists.view, credentials.data ?? [], lists.name, i18n.language) : [];
  const haveNotes = lists ? existingNotes(t, lists.view, credentials.data ?? []) : [];
  // "Todas as contas" keeps the list it was picked from, the pick checked: once saved the agent lists none, and the
  // next agent with no AI must not take its place under "Pronto".
  const [picked, setPicked] = useState<{ key: string; have: typeof have }>();
  const shownGate = gates.gateOf(view.page === "plan" ? view.choice : "claude");
  const shown = shownGate.state;
  const asksAgain = agentId !== undefined && pollsPlan(shownGate, gates.edition);
  useEffect(() => setPolls(asksAgain), [asksAgain]);
  const onPlan = view.page === "plan";
  // A plan's page that waited for the computer: once it's ready, every plan's page of the flow says so.
  useEffect(() => {
    if (onPlan && shown === "preparing" && !connectAiNow(flowId)?.waited) patchConnectAi(flowId, { waited: true });
  }, [onPlan, shown, flowId]);
  const dims = (choice: PlanChoice) =>
    agentId !== undefined ? gateDims(gates.gateOf(choice)) : props.bare === true && gateDims(bareGates.at(choice).gate);
  const toPlan = (choice: PlanChoice) => {
    // Another plan moves on to the next agent with no AI once this one thinks with a plan from here.
    if (pickedAgent !== undefined && hasAi(pickedAgent)) setPickedAgent(undefined);
    go({ page: "plan", choice });
  };
  // A row of what the person already has, used in one tap: the agent thinks with it, said in a toast.
  const save = async (
    to: { id: string; name: string },
    label: string,
    run: () => Promise<unknown>,
    scope?: BrainScope,
    saved?: () => void,
  ) => {
    setBusy(true);
    try {
      await run();
      saved?.();
      for (const key of [
        keys.agentBrain(orgId, to.id),
        keys.agents(orgId),
        keys.aiAccounts(orgId),
        keys.aiStatus(orgId),
      ])
        void qc.invalidateQueries({ queryKey: key });
      toast({ title: thinksWithLine(t, scope, to.name, label), icon: "check" });
      props.onPlanDone(to.id);
    } catch (error) {
      const refusal = keyRefusal(t, error);
      if (refusal) alertKeyRefused(t, refusal);
      else toast({ title: errorText(t, error), icon: "x" });
    } finally {
      setBusy(false);
    }
  };
  const pickHave = (row: ExistingAi) => {
    if (!forAgent || !gates.view) return;
    const brain = gates.view.brain;
    const key = have.find((h) => h.row === row)?.key;
    const saved = () => key !== undefined && setPicked({ key, have });
    if (row.kind === "key") {
      const k = row.key;
      // The workspace's model on that key: the agent's model where the key runs it, else one the key does (an endpoint's
      // own for an endpoint key, Automático for a catalog one, which follows it).
      // Tried first: a key kept earlier may have run out of credit, and "now thinks with it" has to be true. An
      // endpoint's key has no call of its own to try: its models' last tests say whether it thinks (`keyThinks`).
      const agentRow = agentRows.data?.find((a) => a.id === forAgent.id);
      const rightHand = gates.view?.scope === "mine" && agentRow;
      return void save(
        forAgent,
        k.label,
        async () => {
          const { check } = await api.agents.checkCredential(orgId, k.id);
          if (!keyThinks(k)) toast({ title: t("connectAi.key.untested", { name: keyName(k) }), icon: "info" });
          else if (check === "unchecked" && k.provider !== CUSTOM_PROVIDER)
            toast({ title: t("connectAi.key.savedUnchecked", { provider: keyName(k) }), icon: "check" });
          // The team's right hand: a key is the workspace's AI, so everyone without their own thinks with it.
          if (rightHand) return rightHandOnKey(api, orgId, rightHand, k, models.data?.models ?? []);
          await agentOnKey(
            api,
            orgId,
            { id: forAgent.id, model: agentRow?.model, brain },
            k,
            models.data?.models ?? [],
          );
        },
        rightHand ? "workspace" : undefined,
        saved,
      );
    }
    const a = row.choice.login;
    const choice = planOfAccount(a);
    const take = (moveAccount: boolean) =>
      void save(
        forAgent,
        accountTitle(t, a),
        () =>
          api.agents.setBrain(orgId, forAgent.id, {
            brain: a.kind,
            account: a.id,
            ...(moveAccount ? { moveAccount } : {}),
          }),
        gates.view?.scope,
        saved,
      );
    if (row.act === "use") return take(false);
    if (row.act === "move") {
      // One account thinks for one agent: picking another agent's takes it from that one.
      return Alert.alert(
        accountTitle(t, a),
        t("agentPage.work.brain.accountMove", { agents: takenFrom(a, forAgent.name).join(", ") }),
        [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("mobile.ai.moveHere"), onPress: () => take(true) },
        ],
      );
    }
    if (row.act === "also" || row.act === "again") {
      // That account's page, for this agent: the row's sign-in goes with it.
      patchConnectAi(flowId, {
        login: { choice, from: a.id, email: a.email, ...(row.act === "again" ? { again: a.id } : {}) },
        pickedAgent: forAgent.id,
      });
      go({ page: "plan", choice });
    }
  };
  if (view.page === "home")
    return (
      <Home
        onView={(next) => {
          // One of the two ways: no row's sign-in goes along.
          patchConnectAi(flowId, { login: null });
          go(next);
        }}
        dims={dims}
        dimmedWhy={(choice) =>
          dimmedLine(t, gateAt(choice), {
            edition: gates.edition ?? bareGates.edition,
            kind: kindOf(choice),
            computer: computerName(
              t,
              org?.name ?? "",
              managedNamed(gates.view?.computer ?? bareGates.at(choice).computer),
              isPersonal(org),
            ),
            machine: machineAt(choice),
          })
        }
        dimmedOut={(choice) => {
          const gate = gateAt(choice);
          const m = machineAt(choice);
          return gate.state === "unsupported" && gate.reason === "tool_off" && m && m.kind !== "managed" ? (
            <ToolOffWayOut machine={m} tool={brainTool(kindOf(choice))} style={styles.footerOut} />
          ) : null;
        }}
        have={have}
        haveNotes={haveNotes}
        agentName={forAgent?.name ?? ""}
        busy={busy}
        onHave={pickHave}
      />
    );
  if (view.page === "have")
    return (
      <AllHave
        have={picked?.have ?? have}
        picked={picked?.key}
        haveNotes={haveNotes}
        dims={dims}
        busy={busy || picked !== undefined}
        onHave={pickHave}
      />
    );
  if (view.page === "plans") return <Plans onPlan={toPlan} dims={dims} />;
  // The makers are a choice for the key's page under them: picking one goes back to it.
  if (view.page === "makers") return <Makers form={props.keyForm} onDone={() => goBack()} />;
  if (view.page === "plan")
    return (
      <PlanPage
        {...props}
        choice={view.choice}
        gates={gates}
        bareGates={bareGates}
        agentId={agentId}
        onAgent={setPickedAgent}
        waited={flow.waited}
        {...(login ? { login } : {})}
      />
    );
  return <KeyPage {...props} onMakers={() => go({ page: "makers" })} />;
}

/**
 * The first page: what the workspace already has for the agent (`have`), used in one tap, under a line that says what a
 * pick does, then the two ways, one list ("Meu plano de IA", "Uma chave"). What they have reads as the web's list
 * (`haveLayout`): few rows by owner, many the three with most room and "Ver as N contas"; someone else's they can't
 * pick, one line under that person's group. Neutral tiles: the makers' marks come on the pages that pick one. A plan
 * that can't sign in on the agent's computer says why under the rows, its rows of what they have dimmed too.
 */
function Home({
  onView,
  dims,
  dimmedWhy,
  dimmedOut,
  have,
  haveNotes,
  agentName,
  busy,
  onHave,
}: {
  /** One of the two ways' pages, pushed over this one. */
  onView: (v: PushedPage) => void;
  dims: (choice: PlanChoice) => boolean;
  /** Why a plan is dimmed, said once under the rows it dims. */
  dimmedWhy: (choice: PlanChoice) => string;
  /** Its way out where there is one (a program off there), under that line. */
  dimmedOut: (choice: PlanChoice) => ReactNode;
  have: ReturnType<typeof existingRows>;
  /** Someone else's accounts the person can't pick, a line per person (`existingNotes`). */
  haveNotes: readonly { key: string; text: string }[];
  agentName: string;
  busy: boolean;
  onHave: (row: ExistingAi) => void;
}) {
  const { t } = useTranslation();
  const dimmed = have.flatMap((r) =>
    r.row.kind === "account" && dims(planOfAccount(r.row.choice.login)) ? [planOfAccount(r.row.choice.login)] : [],
  )[0];
  const noPlan = PLAN_CHOICES.every(dims);
  const layout = haveLayout(have, haveNotes);
  const row = (r: (typeof have)[number]) => (
    <AiRow
      key={r.key}
      row={r}
      disabled={busy || (r.row.kind === "account" && dims(planOfAccount(r.row.choice.login)))}
      onPress={() => onHave(r.row)}
    />
  );
  const keysRow = have.some((r) => r.row.kind === "key") ? (
    <GroupedRow
      icon="key"
      label={t("connectAi.have.manageKeys")}
      chevron
      onPress={() => router.push("/ai-accounts" as never)}
    />
  ) : null;
  return (
    <View>
      {have.length > 0 || haveNotes.length > 0 ? (
        <>
          {agentName && have.length > 0 ? (
            <GroupedFooter>{t("connectAi.have.pickLine", agentGrammar(agentName))}</GroupedFooter>
          ) : null}
          {layout.best ? (
            <>
              <GroupedHeader>{t("connectAi.chat.best")}</GroupedHeader>
              <GroupedList>
                {layout.best.map(row)}
                <GroupedRow
                  icon="list"
                  label={t("connectAi.chat.seeAll", { count: have.length })}
                  chevron
                  onPress={() => onView({ page: "have" })}
                />
                {keysRow}
              </GroupedList>
            </>
          ) : null}
          {layout.groups.map((g) => (
            <Fragment key={g.key}>
              {g.rows.length > 0 ? (
                <>
                  <GroupedHeader>{g.label ?? ""}</GroupedHeader>
                  <GroupedList>
                    {g.rows.map(row)}
                    {g.key === "keys" ? keysRow : null}
                  </GroupedList>
                </>
              ) : null}
              {g.note ? <GroupedFooter>{g.note}</GroupedFooter> : null}
            </Fragment>
          ))}
          {dimmed && !noPlan ? <GroupedFooter>{dimmedWhy(dimmed)}</GroupedFooter> : null}
          {dimmed && !noPlan ? dimmedOut(dimmed) : null}
          <GroupedHeader>{t("connectAi.have.other")}</GroupedHeader>
        </>
      ) : null}
      <GroupedList>
        <GroupedRow
          icon="sparkle"
          label={t("mobile.ai.planRow")}
          sub={t("mobile.ai.planRowSub")}
          faint={noPlan}
          chevron
          onPress={() => onView({ page: "plans" })}
        />
        <GroupedRow
          icon="key"
          label={t("mobile.ai.keyRow")}
          sub={t("mobile.ai.keyRowSub")}
          chevron
          onPress={() => onView({ page: "key" })}
        />
      </GroupedList>
      {noPlan ? <GroupedFooter>{dimmedWhy("claude")}</GroupedFooter> : null}
      {noPlan ? dimmedOut("claude") : null}
    </View>
  );
}

/** Every account already connected for the agent ("Ver as N contas"), by whose it is, with a search: one tap uses it. */
function AllHave({
  have,
  picked,
  haveNotes,
  dims,
  busy,
  onHave,
}: {
  have: ReturnType<typeof existingRows>;
  picked: string | undefined;
  haveNotes: readonly { key: string; text: string }[];
  dims: (choice: PlanChoice) => boolean;
  busy: boolean;
  onHave: (row: ExistingAi) => void;
}) {
  const { t } = useTranslation();
  const [tapped, setTapped] = useState<string>();
  const layout = haveLayout(have, haveNotes, true);
  const rows = layout.groups.flatMap((g) => g.rows);
  return (
    <PickList
      options={rows.map((r) => ({
        value: r.key,
        label: r.label,
        group: r.group.label,
        groupKey: r.group.key,
        mark: r.mark,
        off: r.off,
        ...(r.sub ? { description: r.sub } : {}),
        ...(r.below ? { below: r.below } : {}),
        keywords: `${r.label} ${r.group.label}`,
        disabled: busy || (r.row.kind === "account" && dims(planOfAccount(r.row.choice.login))),
      }))}
      value={picked ?? (busy ? tapped : undefined)}
      onPick={(o) => {
        const r = have.find((x) => x.key === o.value);
        setTapped(o.value);
        if (r) onHave(r.row);
      }}
      placeholder={t("connectAi.chat.search")}
      searchLabel={t("connectAi.chat.search")}
      noResults={t("connectAi.chat.none")}
      notes={layout.groups.flatMap((g) => (g.note ? [{ key: g.key, text: g.note }] : []))}
    />
  );
}

/** The plans, the most used first, with a search: what each is sold as under its name. Picking one pushes its page. */
function Plans({ onPlan, dims }: { onPlan: (choice: PlanChoice) => void; dims: (choice: PlanChoice) => boolean }) {
  const { t } = useTranslation();
  return (
    <PickList
      options={PLAN_CHOICES.map((c) => ({
        value: c,
        label: planLabel(t, c),
        description: t(`connectAi.plan.${c}.tiers`),
        mark: planMark(c),
        off: dims(c),
        keywords: planPickText(t, c),
      }))}
      value={undefined}
      onPick={(o) => onPlan(o.value)}
      placeholder={t("connectAi.pick.searchPlaceholder")}
      searchLabel={t("connectAi.pick.search")}
      noResults={t("connectAi.pick.noResults")}
    />
  );
}

/** Whose API key: the makers, the most used first, with a search, then "Outro provedor" (a workspace's own endpoint). */
function Makers({ form, onDone }: { form: ConnectKey; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <PickList
      options={[
        ...PROVIDERS.map((p) => ({ value: p.id as string, label: p.label, mark: p.id as string, keywords: "" })),
        {
          value: CUSTOM_PROVIDER as string,
          label: t("endpoint.option"),
          description: t("endpoint.optionSub"),
          mark: CUSTOM_PROVIDER as string,
          keywords: "",
        },
      ]}
      value={form.custom ? CUSTOM_PROVIDER : form.provider}
      onPick={(o) => {
        const maker = PROVIDERS.find((p) => p.id === o.value);
        form.setCustom(!maker);
        if (maker) form.setProvider(maker.id);
        onDone();
      }}
      placeholder={t("connectAi.pick.searchPlaceholder")}
      searchLabel={t("connectAi.pick.search")}
      noResults={t("connectAi.pick.noResults")}
    />
  );
}

/**
 * A page's head under the bar that names it: the option's mark, big, and what it covers ("Pro, Max, Ultra…"). The
 * name itself is the bar's title, never drawn twice.
 */
function Hero({ mark, sub }: { mark: ReactNode; sub: string }) {
  return (
    <View style={styles.hero}>
      {mark}
      <Text variant="subhead" tone="muted" style={styles.center}>
        {sub}
      </Text>
    </View>
  );
}

/**
 * The web's `CliMissing` on the phone: Claude Code or Codex isn't on a computer someone connected, or won't start
 * there. Whoever connected it installs it from here (it runs on the computer), anyone else asks them, anyone looks
 * again. The page's own "Use an API key now" stays under it.
 */
function CliMissingCard({
  machine,
  kind,
  computer,
  reason,
}: {
  machine: Machine;
  kind: MachineAccountKind;
  computer: string;
  reason: "not_installed" | "cant_start";
}) {
  const { t } = useTranslation();
  const { orgId } = useAiOrg();
  const toast = useToast();
  const meId = useMeId();
  const cli = installableCli(kind) ?? "claude";
  const oneClick = cliOneClick(machine, meId, cli);
  const run = useCliInstall(orgId, machine.id, cli, oneClick?.kind === "allow");
  const check = useCheckMachineClis(orgId);
  const [checked, setChecked] = useState(false);
  const program = t(`brain.card.${kind}`);
  const words = { program, computer };
  const install = run.install;
  const running = install?.state === "running";
  const pending = run.start.isPending || run.cancel.isPending || run.ask.isPending || check.isPending;
  const broken = reason === "cant_start" ? (machine.cliErrors?.[cli] ?? "") : null;
  const gitMissing =
    (install?.state === "failed" && install.cause === "git_missing") ||
    (broken === CLI_GIT_MISSING && install?.state !== "failed");
  const fail = (err: unknown) => toast({ title: errorText(t, err), icon: "x" });
  const text = running
    ? t("connectAi.cli.installing", words)
    : gitMissing
      ? t("connectAi.cli.gitMissing", words)
      : (cliInstallFailure(t, install, words) ??
        (broken !== null
          ? broken
            ? t("connectAi.cli.cantStart", { ...words, message: broken })
            : t("brain.reasons.cant_start", words)
          : checked
            ? t("connectAi.cli.checked", words)
            : oneClick?.kind === "outdated"
              ? t("common.joinSentences", {
                  a: t("connectAi.cli.missing", words),
                  b: t("connectAi.cli.outdated", { computer }),
                })
              : t("connectAi.cli.missing", words)));
  const failedBefore = install?.state === "failed" || install?.state === "canceled";
  const actions = running ? (
    <Button
      size="sm"
      variant="secondary"
      label={t("common.cancel")}
      disabled={pending}
      onPress={() => run.cancel.mutate()}
    />
  ) : (
    <View style={styles.gap}>
      {gitMissing ? <OpenPage href={GIT_FOR_WINDOWS_URL} label={t("connectAi.cli.getGit")} primary /> : null}
      {oneClick?.kind === "allow" && broken === null ? (
        <Button
          size="sm"
          variant={gitMissing ? "secondary" : "primary"}
          label={failedBefore ? t("common.retry") : t("connectAi.cli.install", { program })}
          disabled={pending}
          loading={run.start.isPending}
          onPress={() => run.start.mutate(undefined, { onError: fail })}
        />
      ) : null}
      {oneClick?.kind === "ask" && broken === null ? (
        <Button
          size="sm"
          variant="secondary"
          label={t("machines.oneClick.ask", { name: firstName(oneClick.ownerName) })}
          disabled={pending}
          loading={run.ask.isPending}
          onPress={() =>
            run.ask.mutate(undefined, {
              onSuccess: () => toast({ title: t("connectAi.cli.asked", { name: firstName(oneClick.ownerName) }) }),
              onError: fail,
            })
          }
        />
      ) : null}
      {machine.cliInstall ? (
        <Button
          size="sm"
          variant="secondary"
          label={t("connectAi.cli.check")}
          disabled={pending || !machine.online}
          loading={check.isPending}
          onPress={() => check.mutate(machine.id, { onSuccess: () => setChecked(true), onError: fail })}
        />
      ) : null}
    </View>
  );
  // The Claude chat app is likely on a Mac or a PC, and isn't Claude Code: said once, behind the ⓘ.
  const plain =
    !running &&
    !gitMissing &&
    install?.state !== "failed" &&
    broken === null &&
    !checked &&
    oneClick?.kind !== "outdated";
  const why = plain && cli === "claude" && (machine.os === "windows" || machine.os === "darwin");
  return (
    <InfoCard icon={running ? "clock" : "laptop"} action={actions} live>
      {why ? (
        <InfoHint name={t("common.about", { label: program })} text={t("connectAi.cli.claudeApp")} variant="subhead">
          {text}
        </InfoHint>
      ) : (
        text
      )}
    </InfoCard>
  );
}

/** A line in a white card (why the steps wait), with its action. `live`: announced when it comes. */
function InfoCard({
  icon,
  children,
  action,
  live = false,
}: {
  icon: IconName;
  children: ReactNode;
  action?: ReactNode;
  live?: boolean;
}) {
  const { colors: c, shadows } = useTheme();
  return (
    <View
      style={[styles.info, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
      accessibilityLiveRegion={live ? "polite" : undefined}
    >
      <Icon name={icon} size={18} color={c.ink2} />
      <Text variant="subhead" tone="muted">
        {children}
      </Text>
      {action ? <View style={styles.start}>{action}</View> : null}
    </View>
  );
}

/**
 * "Atende outras pessoas" for the agent a plan's page is for (ADR 0059 §5): on this plan's brain it is the agent's
 * own, changed at once; before the move it waits, and the move carries it (`move`), else the agent starts on its
 * owner alone. `plan`: the plan of the sign-in it thinks with there, an account's or the computer's own.
 */
function useReplies(gates: PlanGates, agentId: string | undefined, kind: MachineAccountKind) {
  const { t } = useTranslation();
  const { orgId } = useAiOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  // The agent it was switched on for, before its move.
  const [waiting, setWaiting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { view } = gates;
  const live = view !== undefined && view.agentId === agentId && view.brain === kind;
  const on = live ? !view.onlyOwner : waiting !== null && waiting === agentId;
  const change = async (next: boolean) => {
    if (!agentId) return;
    if (!live) return setWaiting(next ? agentId : null);
    setBusy(true);
    try {
      qc.setQueryData(keys.agentBrain(orgId, agentId), await api.agents.setBrain(orgId, agentId, { onlyOwner: !next }));
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      setBusy(false);
    }
  };
  const plan = live ? signInPlan(view, gates.row, kind) : null;
  return { on, change, busy, move: on ? { onlyOwner: false } : {}, plan };
}

/** One plan's page: its mark, for which agent, then its steps on the agent's computer. */
function PlanPage(
  props: ConnectAiFlowProps & {
    choice: PlanChoice;
    gates: PlanGates;
    bareGates: GatesWithoutAgent;
    agentId: string | undefined;
    onAgent: (id: string) => void;
    /** A plan's page of the flow waited for the computer (`ConnectAiFlow.waited`). */
    waited: boolean;
    /** A row of what the person already has asked for this sign-in. */
    login?: ExistingSignIn;
  },
) {
  const { t } = useTranslation();
  const { choice, agents, locked, go, gates, agentId, onAgent } = props;
  const agent = agents.find((a) => a.id === agentId);
  // Settings' Sign in again, on its own plan's page: that exact login (a row's own sign-in asked here comes first).
  const again = props.again?.choice === choice ? props.again : undefined;
  const login: ExistingSignIn | undefined =
    props.login ?? (again ? { choice, from: again.id, again: again.id, email: again.email } : undefined);
  const [done, setDone] = useState<{ agentId: string; agent: string; label: string } | null>(null);
  const kind = kindOf(choice);
  const replies = useReplies(gates, agentId, kind);
  // The team's right hand's own AI for the person serves them alone: no switch.
  const repliesRow =
    gates.view?.scope === "mine" ? null : (
      <PlanReplies
        agent={done?.agent ?? agent?.name ?? ""}
        on={replies.on}
        onChange={(on) => void replies.change(on)}
        brain={kind}
        plan={replies.plan}
        coding={planOf(choice)}
        disabled={replies.busy}
      />
    );
  // Which agent the account is for: the app's agent picker, pushed, offering only the agents a plan may think for here.
  // The pick comes back to the flow at once; its state goes with this page.
  const pick = () => {
    openAgentPick({
      agentId: agentId ?? null,
      apply: onAgent,
      title: t("connectAi.agent"),
      note: "",
      ids: agents.map((a) => a.id),
    });
    router.push("/agent-pick");
  };
  useEffect(() => closeAgentPick, []);
  if (done) {
    return (
      <View style={styles.done}>
        {/* Alive, and glad: the agent can think now (a rare moment). */}
        <AgentFace agentId={done.agentId} size={64} expression="happy" />
        <Text variant="title2" tone="ink" style={styles.center}>
          {t("aiAccounts.done.savedAgent", { agent: done.agent, label: done.label })}
        </Text>
        <View style={styles.doneReplies}>{repliesRow}</View>
      </View>
    );
  }
  return (
    <View>
      <Hero mark={<ProviderLogo id={planMark(choice)} size="hero" />} sub={t(`connectAi.plan.${choice}.tiers`)} />
      {locked ? (
        <Note icon="lock" inset>
          {locked}
        </Note>
      ) : props.bare ? (
        <PlanWithoutAgent
          choice={choice}
          gates={props.bareGates}
          mayAddKey={props.mayAddKey}
          onKey={() => go({ page: "key" })}
          onComputer={props.onComputer}
          onDone={() => props.onAccount?.()}
          {...(again ? { again } : {})}
        />
      ) : agent ? (
        <>
          <GroupedHeader>{t("connectAi.agent")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              leading={<AgentFace agentId={agent.id} size={30} live={false} />}
              label={agent.name}
              // Another of the person's agents is a choice on the agent picker's screen, pushed: the row's chevron.
              {...(agents.length > 1 ? { chevron: true, onPress: pick } : {})}
            />
          </GroupedList>
          <GroupedHeader>{t("mobile.ai.how")}</GroupedHeader>
          <PlanSteps
            key={agent.id}
            choice={choice}
            gates={gates}
            agentId={agent.id}
            agentName={agent.name}
            justReady={props.justReady}
            waited={props.waited}
            onComputer={props.onComputer}
            onKey={() => go({ page: "key" })}
            move={replies.move}
            repliesRow={repliesRow}
            {...(choice === "claude" && props.email ? { email: props.email } : {})}
            {...(login ? { login } : {})}
            onDone={(account) => {
              // The flow stays on that agent; another plan moves on to the next one with no AI.
              onAgent(agent.id);
              setDone({
                agentId: agent.id,
                agent: agent.name,
                label: account ? accountInLine(t, account) : planLabel(t, choice),
              });
              props.onPlanDone(agent.id);
            }}
          />
        </>
      ) : (
        <SkeletonList rows={2} />
      )}
    </View>
  );
}

/**
 * A plan's steps for a person who owns no agent yet: it signs in on a computer they may add accounts to, waiting and
 * saying why as `PlanSteps` does, and the account then thinks for the agents they create there.
 */
function PlanWithoutAgent({
  choice,
  gates,
  mayAddKey,
  onKey,
  onComputer,
  onDone,
  again,
}: {
  choice: PlanChoice;
  gates: GatesWithoutAgent;
  /** Only an admin adds an API key: the way on from someone else's computer for them. */
  mayAddKey: boolean;
  onKey: () => void;
  onComputer: () => void;
  onDone: () => void;
  /** Settings' Sign in again (`ConnectAiFlowProps.again`): that login, on the computer it lives on. */
  again?: { id: string; email: string | null };
}) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  const machines = useMachines(orgId, gates.edition !== null);
  const [signingIn, setSigningIn] = useState(false);
  const [added, setAdded] = useState<MachineAccount | null>(null);
  const { gate, computer } = gates.at(choice);
  const againAccount = again ? gates.accounts?.find((a) => a.id === again.id) : undefined;
  // An account of this plan they already have (their agents deleted) thinks for the next one: no second sign-in.
  // Signing one in again is never that.
  const has = added ?? (again ? undefined : freePlanAccount(gates.accounts, choice));
  const cloud = gates.edition === "cloud";
  const managed = machines.data?.find((m) => m.kind === "managed");
  const name = cloud ? computerName(t, org?.name ?? "", managed, isPersonal(org)) : (computer?.name ?? "");
  const steps = gate.state === "ready" || gate.state === "preparing" || (gate.state === "offline" && signingIn);
  // Only whoever connected the computers there signs a plan in on them: a computer of their own is the way on.
  const elsewhere = gate.state === "locked" && !cloud;
  if (has) {
    return (
      <View style={styles.gap}>
        <InfoCard icon="check" live>
          {t("connectAi.forNewAgents", { label: has.label })}
        </InfoCard>
        {choice === "gemini" && geminiPersonal(has) ? (
          <Note icon="info" inset>
            {t("connectAi.plan.gemini.warning")}
          </Note>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.gap}>
      <GateWait
        gate={gate}
        kind={kindOf(choice)}
        coding={isPlanId(choice)}
        machineId={computer?.machineId}
        computer={name}
        edition={gates.edition}
        signingIn={signingIn}
        onComputer={onComputer}
      />
      {elsewhere && can(org, "pair_computers") ? (
        <Button variant="primary" wide label={t("connectAi.connectMine")} onPress={onComputer} />
      ) : null}
      {(offersKeyNow(gate, holdText(t, org?.standing) !== null) || (elsewhere && mayAddKey)) && !signingIn ? (
        <Button variant="ghost" wide label={t("connectAi.wait.useKey")} onPress={onKey} />
      ) : null}
      {steps ? (
        <AddAccount
          machineId={againAccount?.machineId ?? computer?.machineId ?? ""}
          kind={kindOf(choice)}
          computer={cloud ? t("connectAi.theComputer") : (againAccount?.computer ?? name)}
          {...(isPlanId(choice)
            ? { provider: choice }
            : signInProviderOf(againAccount?.provider)
              ? { provider: signInProviderOf(againAccount?.provider) }
              : {})}
          {...(again ? { again: again.id, email: again.email } : {})}
          local={computer?.mine}
          ready={gate.state === "ready"}
          onAdded={(a) => {
            setAdded(a);
            onDone();
          }}
          onSigningIn={setSigningIn}
        />
      ) : null}
      {steps ? (
        <Note icon="info" inset>
          {t("connectAi.forNewAgentsHint")}
        </Note>
      ) : null}
    </View>
  );
}

function PlanSteps({
  choice,
  gates,
  agentId,
  agentName,
  justReady,
  waited: waitedBefore,
  move,
  repliesRow,
  email,
  login,
  onKey,
  onComputer,
  onDone,
}: {
  choice: PlanChoice;
  gates: PlanGates;
  agentId: string;
  agentName: string;
  justReady?: boolean;
  /** A plan's page of the flow waited for the computer, this one or another. */
  waited: boolean;
  /** "Atende outras pessoas" switched on before the move: the move says so. */
  move: { onlyOwner?: boolean };
  /** Who the agent answers, under its steps (`PlanReplies`). */
  repliesRow: ReactNode;
  /** One more login of the account with this email (`ConnectAiFlowProps.email`). */
  email?: string;
  /** A row of what the person already has: one more login of that account, or a free login of it signed back in. */
  login?: ExistingSignIn;
  onKey: () => void;
  onComputer: () => void;
  onDone: (account: MachineAccount | null) => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { colors: c } = useTheme();
  const { view, edition } = gates;
  const gate = gates.gateOf(choice);
  const machines = useMachines(orgId, edition !== null);
  const kind = kindOf(choice);
  const coding = isPlanId(choice);
  const [failedAccount, setFailedAccount] = useState<MachineAccount | null>(null);
  const [saving, setSaving] = useState(false);
  const [other, setOther] = useState(false);
  // A sign-in begun here keeps its steps while its computer is offline: they say Reconectando, and it goes on.
  const [signingIn, setSigningIn] = useState(false);
  // It turned ready while the person watched (here or on another plan's page), or they came because it did.
  const waited = waitedBefore || justReady === true;

  const managed = machines.data?.find((m) => m.kind === "managed");
  const computer =
    edition === "cloud" ? computerName(t, org?.name ?? "", managed, isPersonal(org)) : (view?.computer?.name ?? "");
  const refresh = () => {
    for (const key of [
      keys.agentBrain(orgId, agentId),
      keys.agents(orgId),
      keys.machines(orgId),
      keys.aiAccounts(orgId),
      keys.aiStatus(orgId),
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
  // The sign-in ended: the agent thinks with that account right away (no confirming tap).
  const assign = async (a: MachineAccount) => {
    setSaving(true);
    setFailedAccount(null);
    try {
      qc.setQueryData(
        keys.agentBrain(orgId, agentId),
        await api.agents.setBrain(orgId, agentId, { brain: a.kind, account: a.id, ...move }),
      );
      refresh();
      onDone(a);
    } catch {
      setFailedAccount(a);
    } finally {
      setSaving(false);
    }
  };
  const saveOwn = async () => {
    try {
      qc.setQueryData(
        keys.agentBrain(orgId, agentId),
        await api.agents.setBrain(orgId, agentId, { brain: kind, account: null, ...move }),
      );
      refresh();
      onDone(null);
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    }
  };

  if (gates.failed)
    return (
      <InfoCard
        icon="x"
        action={<Button size="sm" variant="secondary" label={t("common.retry")} onPress={gates.retry} />}
      >
        {t("common.loadFailed")}
      </InfoCard>
    );
  if (saving) return <ActivityIndicator color={c.muted} style={styles.loading} />;
  if (failedAccount) {
    return (
      <InfoCard
        icon="x"
        action={
          <Button size="sm" variant="secondary" label={t("common.retry")} onPress={() => void assign(failedAccount)} />
        }
      >
        {t("connectAi.assignFailed", { label: failedAccount.label, agent: agentName })}
      </InfoCard>
    );
  }

  const ready = gate.state === "ready";
  const useKey = <Button variant="ghost" wide label={t("connectAi.wait.useKey")} onPress={onKey} />;
  const hold = holdText(t, org?.standing);
  const wait = (
    <GateWait
      gate={gate}
      kind={kind}
      coding={coding}
      machineId={view?.computer?.machineId}
      computer={computer}
      edition={edition}
      signingIn={signingIn}
      onComputer={onComputer}
    />
  );

  // The steps stay in view while they wait (their computer actions off); a reason alone otherwise.
  const steps = ready || gate.state === "preparing" || (gate.state === "offline" && signingIn);
  // The sign-in asked for: a row's, or one more login of the account with `email`; never the agent's own then.
  const hint: Pick<ExistingSignIn, "again" | "email"> | undefined = login ?? (email ? { email } : undefined);
  const ownable = ready && !hint && ownSignInFor(choice, view, gates.row);
  // The shared sign-in's plan, where the computer says it ("Claude Max").
  const ownPlan = planWordOf(gates.row?.own?.[kind]?.plan ?? null);
  const current = view?.accounts.find(
    (a) => a.id === view.account && a.kind === kind && providerFitsChoice(a.provider, choice, coding),
  );
  // Signed in again: the agent's own login, unless this sign-in is another account's (`hint`).
  const signedOut = !hint && current?.status === "signed_out" ? current : undefined;
  // The login signed in again, the agent's own or the one asked for: a Gemini Enterprise one signs in as such.
  const againLogin = signedOut ?? (hint?.again ? view?.accounts.find((a) => a.id === hint.again) : undefined);
  // The accounts of this plan the person already has there for all of their agents (ADR 0059 §2): one tap each,
  // before another account.
  const existing =
    ready && !hint
      ? groupPlans(
          (view?.accounts ?? []).filter(
            (a) =>
              a.shared === true &&
              a.mine &&
              a.status === "active" &&
              a.kind === kind &&
              providerFitsChoice(a.provider, choice, coding) &&
              a.id !== view?.account,
          ),
        ).flatMap((g) => g.logins.slice(0, 1))
      : [];
  const choosing = ownable || existing.length > 0;
  return (
    <View style={styles.gap}>
      {wait}
      {offersKeyNow(gate, hold !== null) && !signingIn ? useKey : null}
      {ready && waited ? (
        // A card of its own, where the wait's was: never read as the head of the account choice under it.
        <InfoCard icon="check" live>
          {t("connectAi.wait.ready")}
        </InfoCard>
      ) : null}
      {choice === "gemini" && choosing && !other && existing.some(geminiPersonal) ? (
        <Note icon="info" inset>
          {t("connectAi.plan.gemini.warning")}
        </Note>
      ) : null}
      {choosing ? (
        <GroupedList>
          {ownable ? (
            <GroupedRow
              label={kind === "opencode" ? t("connectAi.own.free") : t("connectAi.own.shared")}
              {...(ownPlan ? { sub: `${planLabel(t, choice)} ${ownPlan}` } : {})}
              onPress={() => void saveOwn()}
            />
          ) : null}
          {existing.map((a) => {
            // Each by its email (or the name its owner gave it), its plan and who else uses it under it; the pencil
            // opens its name.
            const sub = withSub(
              a,
              a.usedBy.length > 0 ? t("agentPage.work.brain.accountAlso", { agents: joinNames(a.usedBy, t) }) : null,
            );
            const machineId = view?.computer?.machineId;
            return (
              <GroupedRow
                key={a.id}
                leading={<ProviderLogo id={a.provider ?? a.kind} size="sm" />}
                label={accountTitle(t, a)}
                faint={unnamedAccount(a)}
                {...(sub ? { sub } : {})}
                {...(machineId && a.mine
                  ? {
                      buttons: [
                        {
                          icon: "pen" as const,
                          label: t("aiAccounts.rename.action", { label: accountTitle(t, a) }),
                          onPress: () => openRenameAiAccount(machineId, a.id),
                        },
                      ],
                    }
                  : {})}
                onPress={() => void assign(a)}
              />
            );
          })}
          <GroupedRow
            label={
              ownable
                ? t("connectAi.own.one", agentGrammar(agentName))
                : t("connectAi.which.other", { brand: planLabel(t, choice) })
            }
            checked={other}
            onPress={() => setOther(true)}
          />
        </GroupedList>
      ) : null}
      {steps && (!choosing || other) ? (
        <AddAccount
          machineId={view?.computer?.machineId ?? ""}
          kind={kind}
          // The Cloud's one computer goes unnamed in the account choice: the sign-in is about the account, not where.
          computer={edition === "cloud" ? t("connectAi.theComputer") : computer}
          {...(isPlanId(choice)
            ? { provider: choice }
            : signInProviderOf(againLogin?.provider)
              ? { provider: signInProviderOf(againLogin?.provider) }
              : {})}
          fresh={existing.length > 0 && other}
          again={hint ? hint.again : signedOut?.id}
          email={hint ? hint.email : signedOut?.email}
          local={view?.ownSignIn}
          ready={ready}
          loading={gates.catching}
          onAdded={(a) => void assign(a)}
          onUse={(a) => void assign(a)}
          onSigningIn={setSigningIn}
        />
      ) : null}
      {steps || ownable ? repliesRow : null}
    </View>
  );
}

/**
 * Why a plan's page waits or can't sign in there (`PlanGate`), with the way on: the computer's wait, a computer to
 * connect. Nothing once it's ready.
 */
function GateWait({
  gate,
  kind,
  coding,
  machineId,
  computer,
  edition,
  signingIn,
  onComputer,
}: {
  gate: PlanGate;
  kind: MachineAccountKind;
  coding: boolean;
  /** The computer the gate is about. */
  machineId: string | undefined;
  /** Its name, as the page says it. */
  computer: string;
  edition: Edition | null;
  signingIn: boolean;
  onComputer: () => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  const machines = useMachines(orgId, edition !== null);
  const hold = holdText(t, org?.standing);
  const row = machines.data?.find((m) => m.id === machineId);
  // Offline or unsupported: what's going on there and what comes next (on the Cloud, by itself: the page asks again).
  const why = gateLine(t, { gate, edition, kind, computer, hold, machine: row });
  let wait: ReactNode = null;
  if (gate.state === "loading") wait = <SkeletonList rows={2} />;
  else if (gate.state === "billing") {
    // A hold stops the Model Gateway for keys too, and paying happens on the web.
    wait = <InfoCard icon="pause">{planHoldPhoneLine(t, org ? paysHere(can(org, "manage_billing")) : false)}</InfoCard>;
  } else if (gate.state === "preparing") {
    const setup = gate.view;
    // A hold decides when anything runs there: it speaks alone. The wait is the app's own (its steps, the time left,
    // who hears when it's ready), for the workspace these pages connect for: the first run's too.
    wait = hold ? (
      <InfoCard icon="pause">{hold}</InfoCard>
    ) : (
      <View style={styles.gap}>
        {setup ? <SetupWait view={setup} workspace={{ orgId, name: org?.name ?? "" }} /> : null}
        <InfoCard icon="clock">{t(coding ? "connectAi.wait.key" : "connectAi.wait.signIn")}</InfoCard>
      </View>
    );
  } else if (
    why &&
    gate.state === "unsupported" &&
    gate.reason === "tool_off" &&
    row &&
    row.kind !== "managed" &&
    !hold
  ) {
    // Switched off on a computer a person connected: said as that, with its way out.
    wait = (
      <InfoCard icon="laptop" action={<ToolOffWayOut machine={row} tool={brainTool(kind)} />}>
        {why.text}
      </InfoCard>
    );
  } else if (
    gate.state === "unsupported" &&
    (gate.reason === "not_installed" || gate.reason === "cant_start") &&
    !hold &&
    installableCli(kind) &&
    row &&
    row.kind !== "managed"
  ) {
    wait = <CliMissingCard machine={row} kind={kind} computer={computer} reason={gate.reason} />;
  } else if (why && !(gate.state === "offline" && signingIn)) {
    wait = <InfoCard icon={why.rechecks ? "clock" : "laptop"}>{why.text}</InfoCard>;
  } else if (gate.state === "missing") {
    wait = (
      <>
        <InfoCard
          icon="laptop"
          action={
            <Button size="sm" variant="primary" label={t("aiAccounts.connect.addComputer")} onPress={onComputer} />
          }
        >
          {t("aiAccounts.connect.noComputer")}
        </InfoCard>
        <Note icon="lock" inset>
          {t("mobile.ai.meanwhile")}
        </Note>
      </>
    );
  } else if (gate.state === "locked") {
    const pairer = row?.pairedBy?.name.split(" ")[0];
    wait = (
      <InfoCard icon="lock">
        {gate.who === "computer"
          ? t("connectAi.accountsLocked", { name: pairer ?? "", computer })
          : t("noAi.lockedOwner")}
      </InfoCard>
    );
  }

  return wait;
}

/**
 * The API key's page: whose key (one row that opens the makers; paid per use, straight to its maker), then the web's
 * two numbered steps: create the key on the maker's page, paste it here. Saved by its button.
 */
function KeyPage({
  mayAddKey,
  keyForm: form,
  keySaved,
  onSaveKey,
  onEndpointSaved,
  keyForLine,
  onMakers,
}: ConnectAiFlowProps & { onMakers: () => void }) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  const hold = usePlanHold(orgId, org);
  const [touched, setTouched] = useState(false);
  const [opened, setOpened] = useState(false);
  const { custom } = form;
  const [endpointSaved, setEndpointSaved] = useState(false);
  const maker = providerOf(form.provider);
  const hint = maker && keyStepHint(maker);
  const clean = form.key.trim();
  const valid = keyLooksValid(form.provider, clean);
  const wrong = touched && clean.length > 0 && !valid;
  const others = wrong ? providersForKey(clean) : [];
  if (hold) return <PlanHoldNote org={org} keys />;
  if (!mayAddKey) return <InfoCard icon="lock">{t("connectAi.keyLocked")}</InfoCard>;
  if (keySaved || endpointSaved) {
    const { settled } = form;
    return (
      <View style={styles.done}>
        <ProviderLogo id={custom ? CUSTOM_PROVIDER : form.provider} size="hero" />
        <Text variant="title2" tone="ink" style={styles.center}>
          {settled
            ? (keyThinks(settled.key) && form.savedNote) || savedKeyLine(t, settled.outcome, settled.key)
            : form.savedNote || t("connectAi.key.saved")}
        </Text>
        {form.resaved || settled?.key.reused ? (
          <Text variant="subhead" tone="muted" style={styles.center}>
            {t("settings.keyResaved")}
          </Text>
        ) : null}
        {settled?.outcome.kind === "other" && keyThinks(settled.key) ? (
          <Button
            variant="secondary"
            label={t("connectAi.key.useForAll")}
            loading={form.makingDefault}
            disabled={form.makingDefault}
            onPress={() => void form.forAll()}
          />
        ) : null}
      </View>
    );
  }
  const site = maker ? new URL(`https://${maker.site}`) : null;
  return (
    <View>
      <GroupedHeader>{t("mobile.ai.whose")}</GroupedHeader>
      <Locked when={form.saving}>
        <GroupedList>
          <GroupedRow
            leading={<ProviderLogo id={custom ? CUSTOM_PROVIDER : form.provider} size="sm" />}
            label={custom ? t("endpoint.option") : providerLabel(form.provider)}
            chevron
            onPress={onMakers}
          />
        </GroupedList>
      </Locked>
      <GroupedFooter>{t("connectAi.key.sub")}</GroupedFooter>
      {custom ? (
        <View style={styles.keySteps}>
          <EndpointForm
            orgId={orgId}
            onDone={async (key) => {
              // The done view opens on what the save came to, never on the line it replaces.
              await onEndpointSaved?.(key);
              setEndpointSaved(true);
            }}
          />
        </View>
      ) : maker && site ? (
        <View style={styles.keySteps}>
          <StepsCard>
            <Step
              n={1}
              state={opened || clean ? "done" : "now"}
              title={t("connectAi.key.create", { provider: providerLabel(form.provider) })}
              hint={hint && t(hint, { provider: maker.label })}
              side={
                <OpenPage
                  href={site.href}
                  primary={!clean}
                  label={t("aiAccounts.add.openKeys", { site: site.host })}
                  onOpened={() => setOpened(true)}
                />
              }
            />
            <Step n={2} divider title={t("connectAi.key.paste")}>
              <Locked when={form.saving}>
                <PasteField
                  value={form.key}
                  onChangeText={form.setKey}
                  onPasted={form.setKey}
                  onBlur={() => setTouched(true)}
                  label={t("connectAi.key.paste")}
                  placeholder={maker.placeholder}
                  secret
                  onSubmit={() => {
                    setTouched(true);
                    if (valid) onSaveKey?.();
                  }}
                />
              </Locked>
              {wrong ? (
                <View style={styles.others}>
                  <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
                    {t(`onboarding.keyInvalid.${form.provider}`)}
                  </Text>
                  {others.length > 0 ? (
                    <>
                      <Text variant="small" tone="faint">
                        {t("onboarding.keyFromOther")}
                      </Text>
                      {/* Buttons, not tag pills: each one switches the key's provider. */}
                      {others.map((p) => (
                        <Button
                          key={p.id}
                          variant="secondary"
                          size="sm"
                          leading={() => <ProviderLogo id={p.id} size="xs" />}
                          label={p.label}
                          onPress={() => form.setProvider(p.id)}
                        />
                      ))}
                    </>
                  ) : null}
                </View>
              ) : null}
            </Step>
          </StepsCard>
          {form.refused ? (
            <>
              <Note icon="x" live inset>
                {form.refused.text}
              </Note>
              {form.refused.href ? <OpenPage href={form.refused.href} label={form.refused.site} /> : null}
            </>
          ) : form.failed ? (
            <Note icon="x" live inset>
              {t("mobile.ai.failed")}
            </Note>
          ) : (
            <Note icon="info" inset>
              {keyForLine ?? t("connectAi.key.forAll")}
            </Note>
          )}
          <View style={styles.save}>
            <Button
              variant="primary"
              wide
              label={form.saving ? t("mobile.ai.saving") : t("mobile.ai.save")}
              loading={form.saving}
              disabled={!valid}
              onPress={() => onSaveKey?.()}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: "center" },
  start: { alignSelf: "flex-start" },
  // Under a grouped list's footer, on its edge.
  footerOut: { paddingTop: 8, paddingHorizontal: 16 },
  gap: { gap: 10 },
  loading: { marginTop: 16 },
  hero: { alignItems: "center", gap: 8, paddingTop: 6, paddingBottom: 4 },
  done: { alignItems: "center", gap: 12, paddingVertical: 24, paddingHorizontal: 10 },
  // The page's lists' width, under the centered words.
  doneReplies: { alignSelf: "stretch", marginHorizontal: -10, marginTop: 8 },
  info: { borderRadius: 14, padding: 14, gap: 10 },
  keySteps: { marginTop: 16, gap: 10 },
  others: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 },
  save: { marginTop: 6 },
});
