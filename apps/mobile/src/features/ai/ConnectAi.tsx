import {
  type ConnectIntent,
  type Credential,
  keys,
  useAiAccounts,
  useAiStatus,
  useApi,
  useModels,
} from "@agenteschat/client";
import { errorText, keyRefusal } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  aiStateOf,
  choiceOfIntent,
  connectsPlanFor,
  freePlanAccount,
  noAiLockedLine,
  PLAN_CHOICES,
  planTitle,
} from "@agenteschat/client/lib/no-ai";
import { can, makesAgents } from "@agenteschat/client/lib/permissions";
import {
  keyLooksValid,
  type ProviderId,
  providerGuess,
  providerLabel,
  providerOf,
} from "@agenteschat/client/lib/providers";
import {
  isRightHand,
  rightHandOnKey,
  type SavedKey,
  settleSavedKey,
  thinksWithLine,
} from "@agenteschat/client/lib/right-hand";
import { useQueryClient } from "@tanstack/react-query";
import { useIsFocused, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { useAnimatedReaction } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { useOrg } from "@/providers/org";
import { Button, SkeletonList, Text, useToast } from "@/ui";
import { CoverBarBackdrop, useCoverScroll } from "@/ui/cover";
import { router } from "@/ui/navigation";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { BottomBar, PushedHeader } from "../shared/parts";
import { ConnectAiPage, viewOf } from "./ConnectAiSteps";
import { ConnectScene } from "./ConnectScene";
import {
  askOf,
  type ConnectAiFlow,
  connectAiHref,
  endConnectAi,
  type KeyDraft,
  type PushedPage,
  patchConnectAi,
  startConnectAi,
  useConnectAi,
} from "./connect-flow";
import { FLOW_STEPS, type FlowView, flowStep } from "./logic";
import { PlanHoldNote, usePlanHold } from "./parts";

/**
 * The workspace's API key typed on the key's page (the web's key panel, saved by the page's button): a pay-as-you-go
 * key for the workspace. Agents without a key of their own think with the newest one of their provider, so nothing
 * else needs pointing. The key and whose it is are the flow's (`draft`: the makers' page picks the maker); the save's
 * state is the page's own.
 */
export function useConnectKey(orgId: string, draft: KeyDraft, setDraft: (patch: Partial<KeyDraft>) => void) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { provider, custom, text: key } = draft;
  const setProvider = (next: ProviderId) => setDraft({ provider: next });
  // "Outro provedor" (ADR 0146): its own form, saved by its own button.
  const setCustom = (on: boolean) => setDraft({ custom: on });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<ReturnType<typeof keyRefusal>>(null);
  const [savedNote, setSavedNote] = useState<string>();
  // The workspace already had this key: the save updated it instead of adding a copy.
  const [resaved, setResaved] = useState(false);
  // What the save came to (`settleSavedKey`), and "Usar esta chave para todos" while it runs.
  const [settled, setSettled] = useState<{ key: Credential; outcome: SavedKey }>();
  const [makingDefault, setMakingDefault] = useState(false);
  const forAll = async () => {
    if (!settled || makingDefault) return;
    setMakingDefault(true);
    try {
      await api.agents.makeDefaultCredential(orgId, settled.key.id);
      setSettled({ ...settled, outcome: { kind: "all" } });
      void qc.invalidateQueries({ queryKey: keys.settings(orgId) });
      void qc.invalidateQueries({ queryKey: keys.aiStatus(orgId) });
    } catch (error) {
      toast({ title: errorText(t, error), icon: "x" });
    } finally {
      setMakingDefault(false);
    }
  };
  const clean = key.trim();
  const looksRight = clean.length === 0 || keyLooksValid(provider, clean);
  // A pasted key says whose it is when only one provider's keys look like it.
  const setKey = (value: string) => {
    setFailed(false);
    setRefused(null);
    setDraft({ text: value, ...(value.trim().length > 12 ? { provider: providerGuess(value, provider) } : {}) });
  };
  const save = async (): Promise<Credential | null> => {
    if (!clean || saving) return null;
    setSaving(true);
    setFailed(false);
    setRefused(null);
    try {
      const entry = providerOf(provider);
      const saved = await api.agents.addCredential(orgId, { provider, label: entry?.label ?? provider, apiKey: clean });
      setResaved(saved.reused === true);
      if (saved.check === "unchecked")
        setSavedNote(t("connectAi.key.savedUnchecked", { provider: providerLabel(provider) }));
      // `aiStatus` lives under `credentials`: both refresh.
      await qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
      return saved;
    } catch (error) {
      const refusal = keyRefusal(t, error);
      setRefused(refusal);
      setFailed(!refusal);
      return null;
    } finally {
      setSaving(false);
    }
  };
  return {
    provider,
    setProvider,
    custom,
    setCustom,
    key,
    setKey,
    looksRight,
    ready: clean.length > 0,
    saving,
    failed,
    refused,
    savedNote,
    setSavedNote,
    resaved,
    settled,
    setSettled,
    makingDefault,
    forAll,
    save,
  };
}

export type ConnectKey = ReturnType<typeof useConnectKey>;

/**
 * "Conectar uma IA" (`/connect-ai?from=<messageId>&intent=<step>&provider=<id>&agentId=<id>&plan=<plan>
 * &email=<address>&ready=1&forNew=1&again=<login>`): its first page, which starts the flow from its address. The flow
 * is one pushed screen per question, asked in the bar ("Como a Dora vai pensar?") over a line that counts the steps
 * ("1 de 3"): how the agent will think (a plan or a key, and what the workspace already has), then the plan's sign-in
 * on the agent's computer or the workspace's API key, then done. Each page past this one is pushed over the one before
 * (`ConnectAiPushed`), so the system's back (the bar's button and the edge swipe) goes one page back, and from this
 * one leaves the flow. A message that asked for a plan or a key opens on that page, and `plan` on that plan's (Sign in
 * again). Once connected from a message, the agent answers it by itself. `email`: one more login of the account other
 * agents use. `again`: with `plan`, Settings' Sign in again (a new key for a coding plan's): that exact login, `email`
 * its own. `ready`: opened because the workspace's computer just got ready (its notification): a plan's page says so.
 */
export function ConnectAiStart() {
  const params = useLocalSearchParams<Partial<Record<string, string>>>();
  // Started on the first render, so every page reads it from its first frame; ended when this page leaves the stack
  // (the back from it, or Pronto taking the whole flow away).
  const [id] = useState(() => startConnectAi(askOf(params)));
  useEffect(() => () => endConnectAi(id), [id]);
  const [view] = useState(() =>
    viewOf(PLAN_CHOICES.find((c) => c === params.plan) ?? choiceOfIntent(params.intent as ConnectIntent | undefined)),
  );
  return <ConnectAiScreen flowId={id} depth={1} view={view} />;
}

/** A page of the flow past its first (`/connect-ai/<page>?s=<flow>&d=<depth>&choice=<plan>`). */
export function ConnectAiPushed({ page }: { page: PushedPage["page"] }) {
  const { s, d, choice } = useLocalSearchParams<{ s?: string; d?: string; choice?: string }>();
  const view: FlowView =
    page === "plan" ? { page, choice: PLAN_CHOICES.find((c) => c === choice) ?? "claude" } : { page };
  return <ConnectAiScreen flowId={s ?? ""} depth={Math.max(1, Number(d) || 1)} view={view} />;
}

/** A page's title in the bar, past the first page's question. */
function pageTitle(t: TFunction, view: PushedPage) {
  if (view.page === "have") return t("connectAi.chat.allTitle");
  if (view.page === "plans") return t("connectAi.pick.placeholder");
  if (view.page === "key") return t("connectAi.key.title");
  if (view.page === "makers") return t("mobile.ai.whose");
  return planTitle(t, view.choice);
}

function ConnectAiScreen({ flowId, depth, view }: { flowId: string; depth: number; view: FlowView }) {
  const { t } = useTranslation();
  const c = useColors();
  const live = useConnectAi(flowId);
  // Pronto takes the flow's pages away together: a page still sliding off once the flow ended keeps what it showed.
  const last = useRef(live);
  if (live) last.current = live;
  const flow = live ?? last.current;
  if (!flow)
    // Opened by its address alone, with no flow under it: the bar and its back, nothing to ask.
    return (
      <View style={[styles.screen, { backgroundColor: c.grouped }]}>
        <PushedHeader title={t("connectAi.title.any")} solid={false} grouped />
      </View>
    );
  return <FlowScreen flowId={flowId} flow={flow} depth={depth} view={view} />;
}

function FlowScreen({
  flowId,
  flow,
  depth,
  view,
}: {
  flowId: string;
  flow: ConnectAiFlow;
  depth: number;
  view: FlowView;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const status = useAiStatus(orgId);
  const { ask } = flow;
  // An API key is the organization's (admins); a plan thinks only for its owner's agents (ADR 0059 §3).
  const mayAddKey = can(org, "manage_credentials");
  const hold = usePlanHold(orgId, org);
  // From the create-agent step: for the agent being made, never one I have.
  // The team's right hand thinks with each person's own AI (ADR 0137 §11): everyone's to connect for their DM.
  const mine = ask.forNew === "1" ? [] : dir.agents.filter((a) => a.ownerUserId === meId || isRightHand(a));
  const named = ask.agentId ? [ask.agentId] : null;
  const agents = (
    named ? dir.agents.filter((a) => ask.forNew !== "1" && named.includes(a.id) && connectsPlanFor(a, meId)) : mine
  ).map((a) => ({ id: a.id, name: a.name }));
  // The agents connected on any page of this flow think with it before the AI status says so.
  const hasAi = (id: string) => flow.linked.includes(id) || (aiStateOf(status.data, id) ?? "no_ai") !== "no_ai";
  // Settings' Sign in again: that login, on the plan's page it opened on.
  const againChoice = PLAN_CHOICES.find((choice) => choice === ask.plan);
  const again = ask.again && againChoice ? { id: ask.again, choice: againChoice, email: ask.email ?? null } : undefined;
  const form = useConnectKey(orgId, flow.key, (patch) =>
    patchConnectAi(flowId, (now) => ({ key: { ...now.key, ...patch } })),
  );
  const models = useModels();
  const toast = useToast();
  // What this page connected: the key, an account for the agents to come, or an agent's plan (or what it had).
  const [keySaved, setKeySaved] = useState(false);
  const [accountAdded, setAccountAdded] = useState(false);
  const [planDone, setPlanDone] = useState(false);
  const answer = () => {
    void qc.invalidateQueries({ queryKey: keys.aiStatus(orgId) });
    if (ask.from) void api.chat.answerNow(orgId, ask.from).catch(() => undefined);
  };
  // Opened for one agent: its name in the title.
  const one = named?.length === 1 ? dir.agentById.get(named[0] ?? "") : undefined;
  const rightHand = isRightHand(one);
  // Opened for one agent (the right hand aside): a key saved here goes on it. Else it is for every agent.
  const keyAgent = one && !rightHand ? one : undefined;
  const settleKey = async (key: Credential) => {
    try {
      const agent = keyAgent && { ...keyAgent, brain: keyAgent.brain?.kind };
      form.setSettled({ key, outcome: await settleSavedKey(api, orgId, key, agent, models.data?.models ?? []) });
      void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      void qc.invalidateQueries({ queryKey: keys.settings(orgId) });
      if (keyAgent) void qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, keyAgent.id) });
    } catch (error) {
      toast({ title: errorText(t, error), icon: "x" });
    }
  };
  // No agent of theirs yet, and it isn't opened for someone else's: a plan signs in for the agents they create.
  const bare = !named && agents.length === 0;
  // Or one of that plan they already have, which the plan's page says is connected.
  const ai = useAiAccounts(orgId, bare);
  // Signing a login in again is never done before it starts, even when that login reads as free.
  const planAccount =
    bare && !again && view.page === "plan" ? freePlanAccount(ai.data?.accounts, view.choice) : undefined;
  const hasPlan = planAccount !== undefined;
  // That plan's next step is an agent that thinks with it, for whoever may make one (never over one being made).
  const makeWith = planAccount && ask.forNew !== "1" && makesAgents(org) ? planAccount : undefined;
  // Someone else's agent they don't manage: who connects a plan instead.
  const owner = one?.ownerUserId ? dir.memberById.get(one.ownerUserId)?.name : undefined;
  const locked =
    agents.length > 0 || bare ? undefined : one ? noAiLockedLine(t, one.name, owner) : t("noAi.lockedAdmins");
  // The next page, pushed over this one: the system's back comes back here.
  const go = (next: PushedPage) => router.push(connectAiHref(flowId, depth + 1, next) as never);
  // Pronto: every page of the flow goes, down to its first, back to where it was opened from.
  const leave = () => router.dismiss(depth);
  const insets = useSafeAreaInsets();
  // The first page's cover: its scroll, and the bar's title once the question under it has gone under the bar (set
  // when the scroll crosses that line, never per frame).
  const { y, onScroll } = useCoverScroll();
  const [titled, setTitled] = useState(false);
  useAnimatedReaction(
    () => y.value > SCENE_HEIGHT + QUESTION_UNDER_BAR,
    (now, before) => {
      if (now !== before) scheduleOnRN(setTitled, now);
    },
  );
  const focused = useIsFocused();
  const done = keySaved || planDone || accountAdded || hasPlan;
  const step = flowStep(view, done);
  const home = view.page === "home" && !done;
  // Where the flow stands, a line of the page (the system's bar has no line under its title): the steps alone on the
  // first page, whose question names the agent; past it, the agent it is for too ("2 of 3 · Dora").
  const stepLine = [t("mobile.ai.stepOf", { step, total: FLOW_STEPS }), home ? null : (one?.name ?? null)]
    .filter(Boolean)
    .join(" · ");
  const title = done
    ? t("connectAi.done")
    : view.page === "home"
      ? one
        ? t("mobile.ai.question", agentGrammar(one.name))
        : t("mobile.ai.questionAny")
      : pageTitle(t, view);
  const page = hold ? (
    <PlanHoldNote org={org} inset />
  ) : dir.loading || status.isPending ? (
    <SkeletonList rows={3} />
  ) : (
    <ConnectAiPage
      view={view}
      go={go}
      flowId={flowId}
      flow={flow}
      agents={agents}
      hasAi={hasAi}
      {...(ask.agentId ? { startAgentId: ask.agentId } : {})}
      {...(ask.email ? { email: ask.email } : {})}
      {...(again ? { again } : {})}
      locked={locked}
      bare={bare}
      onAccount={() => {
        setAccountAdded(true);
        void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
        void qc.invalidateQueries({ queryKey: keys.brainMachines(orgId) });
        answer();
      }}
      {...(one && one.ownerUserId !== meId && mayAddKey && !rightHand
        ? { theirs: { id: one.id, name: one.name } }
        : {})}
      justReady={ask.ready === "1"}
      mayAddKey={mayAddKey}
      keyForm={form}
      keySaved={keySaved}
      onSaveKey={() =>
        void form.save().then(async (key) => {
          if (!key) return;
          // The right hand asked for a key ("Usar uma chave de API"): the workspace's AI from now on, and the person's
          // own DM goes back to it.
          if (one && rightHand) {
            const moved = await rightHandOnKey(api, orgId, one, key, models.data?.models ?? []).then(
              () => true,
              (error) => {
                toast({ title: errorText(t, error), icon: "x" });
                return false;
              },
            );
            if (moved && key.check !== "unchecked")
              form.setSavedNote(thinksWithLine(t, "workspace", one.name, key.label));
            void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
            void qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, one.id) });
          } else await settleKey(key);
          setKeySaved(true);
          // Saved, and its field gone: the flow keeps no copy of the key for the next time its page opens.
          form.setKey("");
          answer();
        })
      }
      onEndpointSaved={async (key) => {
        await settleKey(key);
        setKeySaved(true);
        answer();
      }}
      {...(keyAgent ? { keyForLine: t("connectAi.key.forAgent", { agent: keyAgent.name }) } : {})}
      // Computers live in the app: no site opens for one.
      onComputer={() => router.push("/computer-setup" as never)}
      onPlanDone={(id) => {
        patchConnectAi(flowId, (now) => ({ linked: [...now.linked, id] }));
        setPlanDone(true);
        answer();
      }}
    />
  );
  if (home)
    return (
      <View style={[styles.screen, { backgroundColor: c.grouped }]}>
        <Animated.ScrollView
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        >
          <ConnectScene y={y} height={insets.top + BAR_HEIGHT + SCENE_HEIGHT} />
          <View style={styles.body}>
            {/* The question under the cover, with what it leaves open, then the ways. */}
            <View style={styles.intro}>
              <Text variant="footnote" tone="muted">
                {stepLine}
              </Text>
              <Text variant="display2" accessibilityRole="header">
                {title}
              </Text>
              {hold ? null : (
                <Text variant="subhead" tone="muted">
                  {t("mobile.ai.questionLead")}
                </Text>
              )}
            </View>
            {page}
          </View>
        </Animated.ScrollView>
        {/* What the clear bar becomes once the cover is under it (the system draws it on iOS 26). */}
        <CoverBarBackdrop
          y={y}
          from={SCENE_HEIGHT - 30}
          to={SCENE_HEIGHT + 30}
          height={insets.top + BAR_HEIGHT}
          tone={c.grouped}
        />
        {/* The clock over the night reads in white, in both themes, until the bar takes the question. */}
        {focused && !titled ? <StatusBar style="light" /> : null}
        {/* The system's bar, clear over the cover: no title while the question shows under it. */}
        <PushedHeader title={titled ? title : ""} plate solid={false} />
      </View>
    );
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={title} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
      >
        {/* A plan's page opens on its mark, centred: its line is too. */}
        <Text variant="footnote" tone="muted" style={[styles.step, view.page === "plan" ? styles.center : null]}>
          {stepLine}
        </Text>
        {page}
      </ScrollView>
      {done ? (
        // The last step's one button, pinned at the screen's foot.
        <BottomBar bottom={insets.bottom}>
          <View style={styles.foot}>
            {makeWith ? (
              <Button
                variant="primary"
                wide
                label={t("connectAi.makeAgent")}
                onPress={() => {
                  // Criar agente takes the flow's place: its back lands where the flow was opened from.
                  leave();
                  router.push(`/new-agent?account=${encodeURIComponent(makeWith.id)}` as never);
                }}
              />
            ) : null}
            <Button variant={makeWith ? "secondary" : "primary"} wide label={t("connectAi.done")} onPress={leave} />
          </View>
        </BottomBar>
      ) : null}
    </View>
  );
}

/** The bar's height, and the first page's cover under it (the scene at its foot). */
const BAR_HEIGHT = 44;
const SCENE_HEIGHT = 150;
/** How far the question scrolls past the cover's foot before the bar takes it as its title. */
const QUESTION_UNDER_BAR = 70;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 4 },
  // The first page's step, question and what it leaves open, in the lists' text column, 20 clear of the list.
  intro: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 20, gap: 6 },
  // Past it, where the flow stands at the top of the page, in the same column.
  step: { paddingHorizontal: 16, paddingBottom: 12 },
  center: { textAlign: "center" },
  foot: { gap: 8 },
});
