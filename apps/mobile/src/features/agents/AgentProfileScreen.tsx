import {
  type Agent,
  keys,
  type Memory,
  useAgentAccess,
  useAgentBrain,
  useAgentDetail,
  useAgentForYou,
  useAiStatus,
  useApi,
  useApprovalRules,
  useCatalog,
  useDms,
  useMemory,
  useMemoryAboutMe,
  useMemoryAction,
  useModelLabel,
  useModels,
  useRemoveApprovalRule,
  useRoles,
  useTakeConnectionOffAgent,
  useUsage,
} from "@agenteschat/client";
import { hidesAgentPage, seesFactsOnly } from "@agenteschat/client/lib/agent-facts";
import { approvalRuleServer, approvalRuleWords, approvalTitle } from "@agenteschat/client/lib/approval-words";
import {
  audienceOf,
  audienceSummary,
  canTalk,
  editsAgent,
  managesAgent,
  seesDetails,
} from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { effortLevel } from "@agenteschat/client/lib/brain-advanced";
import { personalOfText } from "@agenteschat/client/lib/connected";
import { modelUnpriced } from "@agenteschat/client/lib/endpoints";
import { FIELD_LIMITS } from "@agenteschat/client/lib/field-limits";
import { formatPercent, timeLeft } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { agentPlan, aiStateOf, planLabel, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { planMeterText, usageShown } from "@agenteschat/client/lib/plan-usage";
import { memoryLine } from "@agenteschat/client/lib/proposals";
import { apiModelName, autoMakerOf, isAuto } from "@agenteschat/client/lib/providers";
import { isRightHand, tellsNameStory } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { planLine } from "@agenteschat/ui/plan-state";
import { useQueryClient } from "@tanstack/react-query";
import { Children, Fragment, isValidElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { useOrg } from "@/providers/org";
import {
  AgentAvatar,
  type AgentLookInput,
  type BadgePresence,
  Button,
  EmptyState,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  haptics,
  Icon,
  type IconName,
  LivePause,
  Locked,
  PixelOrbit,
  ProviderLogo,
  RoleMark,
  SCREEN_X,
  SkeletonOver,
  Sky,
  SwipeRow,
  Text,
  useFirstLoad,
  useTheme,
  useToast,
  WithPresence,
} from "@/ui";
import { CoverBarBackdrop, CoverParallax, useCoverScroll, useScrollFade } from "@/ui/cover";
import { router } from "@/ui/navigation";
import { useReadableSide } from "@/ui/pane";
import { openAgentAi } from "../ai/AgentAiScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { LetMeTalkButton } from "../chat/ReachLines";
import { LandRow } from "../chats/HomeSection";
import { AgentComputerCard } from "../computer/AgentComputerRow";
import { KeptRunningList } from "../computer/KeptRunning";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { openFile } from "../files/open";
import { chatHref } from "../links/logic";
import { UsageQueueSheet } from "../queue/UsageQueueSheet";
import { openRightHandSettings, RightHandMine } from "../right-hand/SettingsScreen";
import { useConnectedById } from "../settings/hooks";
import { agentBadgeInset, Face } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import {
  useColors,
  useDirectory,
  useErrorToast,
  useMeId,
  useMyRoleIds,
  useNow,
  useOrgId,
  useOwnerRoles,
  useOwnsAgent,
  usePushEnded,
  useWhen,
} from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { ownerNameIn, ownerRoleOf } from "../shared/owner";
import { SheetTitle } from "../shared/PromptForm";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { PushedHeader } from "../shared/parts";
import { useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { overLimit, TextArea } from "../shared/TextArea";
import { WaitingCard } from "../shared/WaitingCard";
import { useAgentProfileStatus, usePresenceOf } from "../status/hooks";
import { StatusCard } from "../status/StatusCard";
import { openAgentUsage } from "../usage/UsageScreen";
import { openAgentEdit } from "./AgentEditScreen";
import { AgentFacts } from "./AgentFacts";
import { useAgentMailboxes } from "./AgentMailSection";
import { ApprovalsLevelRow } from "./ApprovalsLevelRow";
import {
  agoOf,
  byPlaybook,
  canEditMemories,
  type DidLine,
  didLines,
  knownAboutMe,
  modelRow,
  othersPersonalOf,
  plainRole,
  spendOf,
  statusCardShown,
  usesOf,
} from "./logic";
import { MergeReposSection } from "./MergeReposSection";
import { MonthPixels } from "./MonthPixels";
import { openAgentMore } from "./more-link";
import { useMemoryOriginText } from "./useMemoryOriginText";
import { agoShort, workTitle, workWhere } from "./work";

const MEMORY_LIMIT = { max: FIELD_LIMITS.memory };

/** Built-in areas in "Can use": their tile. */
const AREA_ICON: Record<string, IconName> = {
  context: "brain",
  drive: "drive",
  issues: "issue",
  calendar: "clock",
  wiki: "doc",
  skills: "sparkle",
  schedule: "clock",
  sandbox: "laptop",
  browser: "globe",
  setup: "pen",
  desktop: "laptop",
};

/** The parts of the profile that open on a screen of their own: what it can reach, what it knows, what it did for you. */
export type ProfileView = "access" | "memory" | "did";

/** One part of an agent's profile on its own pushed screen (`agent-view/[id]?v=`), back to the profile. */
export const openAgentView = (id: string, view: ProfileView) =>
  router.push({ pathname: "/agent-view/[id]", params: { id, v: view } });

/**
 * An agent's profile as a teammate, the web's card as the screen (no views): its sky and living body (its presence on
 * the badge), its name with its @ and role; what waits on you and what it is on now; its computer right under that (its
 * last picture and what it does there); who may talk to it and who answers for it; then Details as rows that open
 * their own screens (`openAgentView`): what it thinks with and its month, Access (what it thinks with, what it can use,
 * what it runs without asking), Memory (what it knows about you and how it works, to correct or forget) and what it
 * did for you. The message field stays at the screen's foot and opens the conversation. Someone it doesn't answer sees
 * only what it is on now. A new agent's checklist is its DM's (ADR 0155 §2), never here: on its page it read as a to-do
 * list about the page's subject, between its head and what it is on. `view`: one of those parts, as its own screen.
 */
export function AgentProfileScreen({ id, view }: { id: string; view?: ProfileView }) {
  const { t } = useTranslation();
  const c = useColors();
  const agent = useDirectory().anyAgent(id);
  // No longer in the team (archived or deleted): its messages name it, it has no profile.
  if (agent?.former) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader title={agent.name} solid={false} />
        <EmptyState size="page" icon="agent" title={t("profile.former")} />
      </View>
    );
  }
  // A teammate's private agent whose page doesn't open for me: as on the web, and as the server answers its link.
  if (hidesAgentPage(agent)) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader title="" solid={false} />
        <EmptyState size="page" icon="agent" title={t("agent.notFound")} />
      </View>
    );
  }
  return (
    <SheetHostProvider>
      <Profile id={id} view={view} />
    </SheetHostProvider>
  );
}

function Profile({ id, view }: { id: string; view?: ProfileView | undefined }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const failed = useErrorToast();
  const sheet = useSheet();
  const when = useWhen();
  const meId = useMeId();
  const org = useOrg().org;
  const insets = useSafeAreaInsets();
  const now = useNow();
  // The cover's sky lags behind the scroll and stretches on pull; the agent fades as it nears the bar.
  const { y, onScroll } = useCoverScroll();
  const underBar = AVATAR_TOP - (insets.top + BAR_HEIGHT);
  // On a large screen the card keeps to the readable column under its sky, which runs edge to edge (ADR 0212).
  const side = useReadableSide();
  const sides = side > 0 ? { paddingHorizontal: SCREEN_X + side } : null;
  // The bar's title is the system's own words: none while the cover shows the name, the name once it has gone under
  // the bar (a view of our own there sat in a glass capsule of its own on iOS 26, the page showing through it). Set
  // when the scroll crosses that line, never per frame.
  const [named, setNamed] = useState(false);
  useAnimatedReaction(
    () => y.value > underBar + NAME_UNDER_BAR,
    (now, before) => {
      if (now !== before) scheduleOnRN(setNamed, now);
    },
    [underBar],
  );
  const agent = dir.agentById.get(id);
  const models = useModels();
  // Someone it doesn't answer (not its owner, not an admin) sees only its public card: no tools, memory or month.
  const details = seesDetails(agent);
  // A teammate's private agent seen through "Editar agentes": its facts, nothing of how it works.
  const facts = seesFactsOnly(agent);
  // The team's right hand (ADR 0137): what it is and how it works, its model, Configurar for who manages agents.
  const rightHand = isRightHand(agent);
  // A personal workspace's agent (ADR 0159 §3): its rules, repositories and the rest in Advanced.
  const personal = isPersonal(org);
  // The cover's sky and the face come alive once the push has ended: the slide has the threads to itself.
  const arrived = usePushEnded();
  // A hello when its profile opens (a rare, small moment): it smiles once, unless it is at work.
  const hello = useHello(arrived);
  const modelLabel = useModelLabel();
  const detail = useAgentDetail(orgId, id);
  const access = useAgentAccess(orgId, id, details);
  const usage = useUsage(orgId);
  const forYou = useAgentForYou(orgId, id);
  const knows = useMemoryAboutMe(orgId, id);
  const mailboxes = useAgentMailboxes(id, details);
  const work = useWorkingNow().filter((w) => w.agentId === id);
  const asking = useWaitingApprovals().filter((a) => a.agentId === id);
  // On a billing hold an AI comes after the plan: no row to connect one.
  const held = usePlanHold(orgId, org) !== null;
  const aiStatus = useAiStatus(orgId);
  const noAi = !held && aiStateOf(aiStatus.data, id) === "no_ai";
  const waitingNow = asking[0];
  const look = agentLook(agent);
  const name = agent?.name ?? detail.data?.name ?? "";
  const g = genderOf(name);
  // The person asked for access; a role that answers for it (ADR 0085, addendum of 2026-11-21) has nobody to write
  // to, and its name stands where the person's would.
  const ownerId = agent?.ownerUserId ?? null;
  const ownerRoles = useOwnerRoles();
  const ownerRole = ownerRoleOf(agent, ownerRoles);
  const owner = ownerNameIn(agent, dir.memberById, ownerRoles);
  const myRoleIds = useMyRoleIds();
  const owns = useOwnsAgent();
  const mine = owns(agent);
  const roleName = (agent?.role || detail.data?.role || "").trim();
  const plain = plainRole(agent?.instructions || detail.data?.instructions);
  const busy = work.length > 0;
  const editable = canEditMemories(agent, { id: meId, org, roleIds: myRoleIds });
  // Its presence (ADR 0084): the badge, and the card with what it does where nothing else here says it.
  const status = useAgentProfileStatus(id, name);
  const statusLine = usePresenceOf().agent(id)?.status?.status ?? null;
  // Its owner or who manages it (the server's `canManage`: "Editar qualquer agente" where it reaches).
  const decides = mine || managesAgent(agent);
  // The request in the card above leaves the list, so it is said once.
  const did = didLines(forYou.data?.items).filter(
    (l) => !(waitingNow && l.href?.kind === "approval" && l.href.id === waitingNow.id),
  );
  const memories = knownAboutMe(knows.data);
  const learned = byPlaybook(memories);
  const uses = usesOf(access.data);
  const connected = useConnectedById();
  // Other people's personal connections it holds: who manages connectors or agents and its owner may only turn them off.
  const takesOff = details && (decides || can(org, "manage_connectors"));
  const theirs = othersPersonalOf(useAgentAccess(orgId, id, takesOff, { others: true }).data, meId);
  const catalog = useCatalog();
  const takeOff = useTakeConnectionOffAgent(orgId);
  // A computer brain: its maker's mark and the model by the plan that pays for it ("Sonnet pelo plano do Claude"; its
  // computer only where it tells two apart).
  const thinks =
    agent?.brain && agent.brain.kind !== "model" ? brainLine(t, agent.brain, "", { agents: dir.agents }) : null;
  // As the web's cell: the plan as the row's name ("Pensa com" › "Claude"), the model under it, and its effort for who
  // sees it (its owner and admins) where the model is fixed (Automático picks the effort too).
  const effortView = useAgentBrain(orgId, id, decides && thinks !== null).data;
  const brainKind = agent?.brain?.kind;
  const thinksPlan =
    brainKind && brainKind !== "model"
      ? planLabel(t, planOfAccount({ kind: brainKind, provider: agent?.brain?.provider ?? null }))
      : null;
  const thinksModel = isAuto(agent?.brain?.model) ? t("brain.auto.label") : (agent?.brain?.model ?? null);
  const thinksEffort =
    effortView && effortView.brain !== "model" && !isAuto(effortView.effectiveModel)
      ? t("agentPage.work.cell.effort", {
          level: t(`agentPage.work.brain.effortsLower.${effortLevel(effortView.effort)}`),
        })
      : null;
  const thinksSpeed = agent?.brain?.speed ? t("agentPage.work.brain.speeds.fast") : null;
  const thinksUnder = [thinksModel, thinksEffort, thinksSpeed].filter(Boolean).join(" · ");
  const spend = detail.data
    ? spendOf({
        budgetUsedPercent: detail.data.budgetUsedPercent,
        monthlyBudgetUsd: detail.data.monthlyBudgetUsd ?? null,
        ...(detail.data.defaultBudgetUsd !== undefined ? { defaultBudgetUsd: detail.data.defaultBudgetUsd } : {}),
        usage: usage.data?.find((u) => u.agentId === id) ?? null,
      })
    : null;
  // On a plan, its limits first and the budget only once it spent through the API (ADR 0063 §5).
  const shown = usageShown(agent?.brain, detail.data?.budgetUsedPercent ?? 0);
  // Formatters are costly to build: one per language, not one per render.
  const locale = i18n.language || "en";
  const moneyFormat = useMemo(() => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }), [locale]);
  const money = (v: number) => moneyFormat.format(v);
  const monthFormat = useMemo(
    () => new Intl.DateTimeFormat(when.locale, { month: "long", timeZone: "UTC" }),
    [when.locale],
  );
  const originText = useMemoryOriginText();
  // Forgetting is the list's swipe (as the system's lists delete), confirmed by a system alert that says what stays.
  const memoryAct = useMemoryAction(orgId, id);
  const forgetAsk = (m: Memory) =>
    Alert.alert(
      t("mobile.intentAgents.knows.forgetTitle"),
      t("mobile.intentAgents.knows.forgetBody", agentGrammar(name)),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("mobile.intentAgents.knows.forget"),
          style: "destructive",
          onPress: () =>
            memoryAct.mutate(
              { type: "archive", id: m.id, archived: true },
              {
                onSuccess: () => toast({ title: t("mobile.intentAgents.fix.forgotten"), agentId: id }),
                onError: failed,
              },
            ),
        },
      ],
    );

  // "Chat" and "Ask for access": a conversation already known here opens on the tap; else the server opens it while
  // the button spins, and a second tap meanwhile does nothing. Pushed over the profile, which back returns to (the
  // shared `useOpenDm` empties the stack first, for the New sheet).
  const dms = useDms(orgId);
  const [opening, setOpening] = useState(false);
  const openDm = (to: { agentId: string } | { userId: string } = { agentId: id }) => {
    if (opening) return;
    const known = dms.data?.find((d) =>
      "agentId" in to
        ? d.with.type === "agent" && d.with.id === to.agentId
        : d.with.type === "person" && d.with.id === to.userId,
    );
    if (known) {
      router.push(chatHref(known.channelId));
      return;
    }
    setOpening(true);
    api.dms
      .open(orgId, to)
      .then(({ channelId }) => {
        void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
        router.push(chatHref(channelId));
      })
      .catch(failed)
      .finally(() => setOpening(false));
  };

  const open = (href: DidLine["href"]) => {
    if (!href) return;
    if (href.kind === "issue") router.push(`/issues/${href.number}`);
    else if (href.kind === "chat") router.push(chatHref(href.channelId, href.threadId));
    else if (href.kind === "file") openFile({ id: href.id });
    else router.push(`/approval/${href.id}`);
  };

  const memoryRow = (m: Memory) => {
    const row = (
      <GroupedRow
        icon="brain"
        label={m.summary ?? memoryLine(t, m)}
        labelLines={2}
        sub={originText(m)}
        // The same screen Memória opens for it (one place to read, fix or forget a memory).
        chevron
        onPress={() => router.push(`/memory/${m.id}`)}
      />
    );
    if (!editable) return <Fragment key={m.id}>{row}</Fragment>;
    return (
      <SwipeRow
        key={m.id}
        right={{
          label: t("mobile.intentAgents.knows.forget"),
          icon: "trash",
          color: c.danger,
          ink: c.bg,
          onAction: () => forgetAsk(m),
        }}
      >
        {/* The swipe's pane shows under the row, so the row is opaque, in the list's own white. */}
        <View style={{ backgroundColor: c.raised }}>{row}</View>
      </SwipeRow>
    );
  };

  // A role is named even to who holds it: others answer for it too.
  const ownerLine = rightHand
    ? null
    : mine && !agent?.ownerRoleId
      ? t("mobile.intentAgents.ownerYou")
      : owner
        ? t("mobile.intentAgents.owner", { name: owner })
        : null;
  // The right hand's one role name, as its row in Conversas and its conversation's header say it.
  const roleLine = rightHand
    ? t("rightHand.labelCapitalized")
    : [
        // Its @ and role, as the web's card; what it does only where it has no role.
        agent?.handle ? `@${agent.handle}` : null,
        roleName || plain || null,
        facts ? t("agentPage.facts.private") : null,
      ]
        .filter(Boolean)
        .join(" · ");
  // One fact under each line: when. What it was is in the line itself and in its tile.
  const didSub = (l: DidLine) => when.short(l.at);
  const didHead = t("mobile.intentAgents.did.title", agentGrammar(name));

  // "This month" in one row (ADR 0063 §5): the plan it thinks with, or its model, and how much of it is used; the
  // budget once it spent through the API. The usage page has the rest.
  const meter = planMeterText(t, i18n.language);
  const planNow = shown.plan ? planLine(shown.plan.usage, meter, now) : null;
  // The budget's share as the web says it ("<1%" for a little spent); money only where the API gives it (ADR 0026).
  const budgetText = () => {
    if (!spend || !shown.budget) return null;
    if (spend.kind === "money")
      return t("settings.usageAgentLine", { spent: money(spend.spentUsd), budget: money(spend.budgetUsd) });
    return `${formatPercent(i18n.language, spend.percent)} ${t("mobile.agent.ofMonthBudget")}`;
  };
  const budgetLine = budgetText();
  // On Automático, the maker of the key it runs on ("Claude"), as the right hand's panel names its key.
  const apiModel = !agent?.model
    ? null
    : apiModelName(t, agent.model, modelLabel(agent.model) ?? undefined, autoMakerOf(aiStatus.data, id));
  const monthLabel =
    shown.plan?.account ?? thinksPlan ?? thinks?.text ?? apiModel ?? t("usageViews.agent.title", agentGrammar(name));
  // A plan's maker, or the maker Automático's models come from through the API.
  const monthMark = thinks?.mark ?? agent?.brain?.maker;
  // A short value fits on the right ("week 40%", "$3.20 of $50.00"); a sentence goes under the name.
  const monthValue = planNow?.top
    ? `${meter.short(planNow.top)} ${planNow.top.used}%`
    : !shown.plan && spend?.kind === "money"
      ? budgetLine
      : null;
  const budgetUnder = budgetLine !== null && monthValue !== budgetLine;
  const monthSub = [
    planNow?.alert ?? null,
    budgetUnder ? budgetLine : null,
    !budgetUnder && budgetLine && spend && spend.fraction >= 1 ? t(`mobile.agent.exhausted${g}`, { name }) : null,
    // A model with no price can't count against the budget: said where the budget is.
    budgetLine && agent && modelUnpriced(models.data?.models, agent.model) ? t("endpoint.budgetUnpriced") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // What it is on now, each thing said once: the request waiting on you as its card (it leaves "What it did for
  // you"), its status card only where no job row or request says it, then the jobs themselves.
  const left = waitingNow ? timeLeft(t, waitingNow.expiresAt, new Date(now)) : null;
  const review = () => {
    if (waitingNow) router.push(`/approval/${waitingNow.id}`);
  };
  const showsStatus =
    Boolean(status?.card) && statusCardShown(statusLine, { working: busy, asking: asking.length > 0 });
  const nowBlock = (
    <>
      {noAi ? (
        <View style={styles.block}>
          <GroupedList>
            <GroupedRow
              icon="bolt"
              label={t("noAi.agent", agentGrammar(agent?.name ?? ""))}
              labelLines={3}
              chevron
              onPress={() => openConnectAi({ agentId: id, plan: agentPlan(agent) ?? undefined })}
            />
          </GroupedList>
        </View>
      ) : null}
      {waitingNow ? (
        <View style={styles.block}>
          <WaitingCard
            agentId={id}
            // Its name is right above the card: the kind line says what it asks, not who.
            kind={{ icon: "shield", label: t("mobile.intentAgents.asksApproval") }}
            title={approvalTitle(t, waitingNow)}
            expires={left ? { createdAt: waitingNow.createdAt, expiresAt: waitingNow.expiresAt } : null}
            action={{ label: t("mobile.chats.wait.review"), onPress: review }}
            onPress={review}
            accessibilityLabel={[t("ask.kind.approval"), approvalTitle(t, waitingNow)].join(", ")}
          />
        </View>
      ) : null}
      {showsStatus && status?.card ? (
        <View style={styles.block}>
          <StatusCard
            emoji={status.card.emoji}
            icon={status.card.icon}
            text={status.card.text}
            note={status.card.note}
          />
        </View>
      ) : null}
      {status?.waiting ? (
        // Its place in the line, a row of the page as everything else here (it opens the line's sheet).
        <View style={styles.block}>
          <GroupedList>
            <GroupedRow
              icon="wait"
              label={t("queue.see")}
              more
              onPress={() => sheet.open(<UsageQueueSheet agentId={id} />)}
            />
          </GroupedList>
        </View>
      ) : null}
      {work.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.home.workingNow")}</GroupedHeader>
          <GroupedList>
            {work.map((w) => (
              <GroupedRow
                key={w.key}
                leading={
                  <View style={styles.orbit}>
                    <PixelOrbit color={look.color} size={14} />
                  </View>
                }
                label={workTitle(t, w)}
                sub={[w.what ? workWhere(t, w) : null, agoShort(t, agoOf(w.since, now))].filter(Boolean).join(" · ")}
                chevron
                onPress={() =>
                  w.missionId ? router.push(`/mission/${w.missionId}`) : router.push(chatHref(w.channelId, w.threadId))
                }
              />
            ))}
          </GroupedList>
        </>
      ) : null}
    </>
  );

  // What it thinks with and how much of it is used this month, one row of Details (ADR 0063 §5): the plan or key as
  // its value, the usage under it. The usage page has the rest.
  const monthUnder = [monthValue, monthSub].filter(Boolean).join(" · ");
  const monthRow = (
    <GroupedRow
      key="thinks"
      {...(monthMark ? { leading: <ProviderLogo id={monthMark} size="sm" /> } : { icon: "key" as const })}
      label={t("mobile.intentAgents.thinks")}
      value={monthLabel}
      {...(monthUnder ? { sub: monthUnder, subLines: 2 } : {})}
      chevron
      onPress={() => openAgentUsage(id)}
    />
  );

  // What it did for you, on its own screen: its month day by day in its own tones (the web's Activity tab), then every
  // line. Its sections keep their place while its data loads the first time (`TabPage`).
  const didView = (
    <TabPage loading={forYou.isLoading} bones={2}>
      {detail.data && detail.data.runsThisMonth > 0 ? (
        <View style={styles.pixels}>
          <MonthPixels
            perDay={detail.data.runsByDay}
            color={look.color}
            label={t("agentPage.activity.chartLabel", {
              count: detail.data.runsThisMonth,
              month: monthFormat.format(new Date()),
            })}
          />
        </View>
      ) : null}
      {forYou.data ? (
        <>
          <GroupedList>
            {did.map((l) => (
              <GroupedRow
                key={l.key}
                icon={l.icon}
                label={t(`mobile.intentAgents.did.${l.title.key}`, l.title.values)}
                sub={didSub(l)}
                {...(l.href ? { chevron: true, onPress: () => open(l.href) } : {})}
              />
            ))}
          </GroupedList>
          {did.length === 0 ? <GroupedFooter>{t(`mobile.intentAgents.did.empty${g}`, { name })}</GroupedFooter> : null}
        </>
      ) : forYou.isError ? (
        // What didn't load is never "Nothing yet": what happened, and the way to ask again.
        <LoadFailed onRetry={() => void forYou.refetch()} />
      ) : null}
    </TabPage>
  );

  // The approval rule under what it can use: in one sentence, naming whoever decides for it.
  const asksNote = () => {
    if (decides) return t("mobile.intentAgents.uses.asksYou");
    if (ownerRole) return t("mobile.intentAgents.uses.asksOwnerRole", { role: ownerRole.name });
    return owner ? t("mobile.intentAgents.uses.asksOwner", { name: owner }) : t("mobile.intentAgents.uses.asksAdmins");
  };
  const usesNote =
    uses.lines.length === 0 && mailboxes.length === 0
      ? t("mobile.intentAgents.uses.empty")
      : uses.asks
        ? asksNote()
        : null;
  // The right hand's AI is each person's, on its settings ("Sua IA"): its access shows only what it may use.
  const accessView = (
    <TabPage loading={access.isLoading} bones={2}>
      {thinks && !rightHand ? (
        <>
          <GroupedHeader>{t("mobile.intentAgents.thinks")}</GroupedHeader>
          <GroupedList>
            {/* Its owner and admins change its AI and model on its AI page, pushed from this row (the only way in: the
                conversation's bar has no button for it). Anyone else reads it. */}
            <GroupedRow
              leading={thinks.mark ? <ProviderLogo id={thinks.mark} size="sm" /> : undefined}
              label={thinksPlan ?? thinks.text}
              {...(thinksUnder ? { sub: thinksUnder, subLines: 2 } : {})}
              {...(decides && agent ? { chevron: true, onPress: () => openAgentAi(agent.id) } : {})}
            />
          </GroupedList>
        </>
      ) : null}
      {access.data || mailboxes.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.agent.canUse")}</GroupedHeader>
          <GroupedList>
            {uses.lines.map((u) =>
              "area" in u.label ? (
                <GroupedRow
                  key={u.key}
                  icon={AREA_ICON[u.label.area] ?? "doc"}
                  label={t(`mobile.intentAgents.uses.area.${u.label.area}`, { defaultValue: u.label.area })}
                  value={t(`mobile.intentAgents.uses.level.${u.level}`)}
                />
              ) : (
                <GroupedRow
                  key={u.key}
                  leading={
                    <ConnectorIcon
                      def={(u.connectionId ? connected.get(u.connectionId)?.def : null) ?? null}
                      image={u.connectionId ? connected.get(u.connectionId)?.image : null}
                      label={u.label.text}
                      size={30}
                    />
                  }
                  label={u.label.text}
                  {...(u.personal
                    ? {
                        sub: t("vault.tab.personal"),
                        hint: {
                          name: t("common.about", { label: u.label.text }),
                          text: t("connectors.personal.worksWhenAsked"),
                        },
                      }
                    : {})}
                  value={t(`mobile.intentAgents.uses.level.${u.level}`)}
                />
              ),
            )}
            {/* Someone else's personal connection: whose it is and Desligar, never its tools or level. */}
            {takesOff
              ? theirs.map((c) => (
                  <GroupedRow
                    key={`theirs:${c.connectionId}`}
                    leading={
                      <ConnectorIcon
                        def={catalog.data?.connectors.find((d) => d.id === c.connector) ?? null}
                        label={c.label}
                        size={30}
                      />
                    }
                    label={c.label}
                    labelLines={0}
                    sub={personalOfText(t, dir.memberById.get(c.ownerUserId ?? "")?.name ?? t("channel.unknownPerson"))}
                    subLines={0}
                    // Its × takes it off this agent (gone while that save is on its way), as a mailbox's does.
                    {...(takeOff.isPending
                      ? {}
                      : {
                          remove: {
                            label: t("connectors.personal.turnOff"),
                            onPress: () =>
                              takeOff.mutate(
                                { connectionId: c.connectionId, agentId: id },
                                {
                                  onSuccess: () =>
                                    toast({
                                      title: t("connectors.personal.takenOff", { name: c.label, agent: name }),
                                      agentId: id,
                                    }),
                                  onError: failed,
                                },
                              ),
                          },
                        })}
                  />
                ))
              : null}
            {/* Its mailboxes beside its apps (ADR 0038): a tap on one's own picks the level. */}
            {mailboxes.map((m) => (
              <GroupedRow
                key={`mail:${m.id}`}
                icon="mail"
                label={m.address}
                {...(m.sub ? { sub: m.sub, subLines: 2 } : {})}
                {...(m.hint ? { hint: m.hint } : {})}
                value={m.level}
                // The value changes in its row, through the app's picker: its mark, not a chevron to a screen.
                {...(m.onPress ? { menu: true, onPress: m.onPress } : {})}
                // Someone else's mailbox: its × takes the agent's access away (gone while that save is on its way).
                {...(m.remove && !m.remove.busy
                  ? { remove: { label: m.remove.label, onPress: m.remove.onPress } }
                  : {})}
              />
            ))}
            {decides ? (
              // A new service for this agent starts in Conectores (who uses it is chosen there).
              <GroupedRow
                key="connect"
                icon="plus"
                label={t("mobile.connectors.fromAgent")}
                chevron
                onPress={() => router.push("/connectors")}
              />
            ) : null}
          </GroupedList>
          {usesNote ? <GroupedFooter>{usesNote}</GroupedFooter> : null}
        </>
      ) : null}
      {agent ? (
        <View style={styles.apart}>
          <ApprovalsLevelRow agent={agent} />
        </View>
      ) : null}
      {personal ? (
        // A personal workspace keeps its rules, repositories and the rest in Advanced (ADR 0159 §3).
        rightHand ? null : (
          <View style={styles.apart}>
            <GroupedList>
              <GroupedRow icon="more" label={t("agentPage.tabs.advanced")} chevron onPress={() => openAgentMore(id)} />
            </GroupedList>
          </View>
        )
      ) : (
        <>
          <AlwaysApproved agentId={id} name={name} mayRemove={mine || can(org, "approve_actions")} />
          <MergeReposSection agentId={id} mayEdit={decides} />
          {ownerLine ? (
            <View style={styles.apart}>
              <GroupedList>
                {/* A role that answers for it shows its mark, and under it who that means (ADR 0085, addendum of
                    2026-11-21). */}
                <GroupedRow
                  {...(ownerRole
                    ? { leading: <RoleMark color={ownerRole.color} icon={ownerRole.icon} size={22} /> }
                    : { icon: "person" as const })}
                  label={ownerLine}
                />
              </GroupedList>
              {ownerRole ? (
                <GroupedFooter>
                  {t("newAgent.ownerRoleHelp", { ...agentGrammar(name), role: ownerRole.name })}
                </GroupedFooter>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </TabPage>
  );

  // Who may correct what it knows, said once under the memories (a tap corrects, a swipe forgets).
  const editFoot = editable
    ? t("mobile.intentAgents.knows.footSwipe")
    : ownerRole
      ? t("mobile.intentAgents.knows.footOwnerRole", { role: ownerRole.name })
      : owner
        ? t("mobile.intentAgents.knows.footOwner", { name: owner })
        : t("mobile.intentAgents.knows.footAdmins");
  const memoryKnows = (
    <>
      <GroupedHeader>{t("mobile.intentAgents.knows.title", agentGrammar(name))}</GroupedHeader>
      <GroupedList>{learned.people.map(memoryRow)}</GroupedList>
      <GroupedFooter>
        {learned.people.length > 0 ? editFoot : t(`mobile.intentAgents.knows.empty${g}`, { name })}
      </GroupedFooter>
      {learned.playbook.length > 0 ? (
        <>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("agentPage.memory.playbook", agentGrammar(name)) }),
              text: t("agentPage.memory.playbookNote"),
            }}
          >
            {t("agentPage.memory.playbook", agentGrammar(name))}
          </GroupedHeader>
          <GroupedList>{learned.playbook.map(memoryRow)}</GroupedList>
          {learned.people.length === 0 ? <GroupedFooter>{editFoot}</GroupedFooter> : null}
        </>
      ) : null}
    </>
  );
  // What it knows that didn't load keeps its header and says so, with the way to ask again (it never just vanishes).
  const memoryFailed = (
    <>
      <GroupedHeader>{t("mobile.intentAgents.knows.title", agentGrammar(name))}</GroupedHeader>
      <LoadFailed onRetry={() => void knows.refetch()} />
    </>
  );
  const memoryView = (
    <TabPage loading={knows.isLoading} bones={2}>
      {knows.data ? memoryKnows : knows.isError ? memoryFailed : null}
      {/* What people told it to always do, under what it learned, as the web's Memória. */}
      <GivenRules agentId={id} name={name} rightHand={rightHand} />
    </TabPage>
  );

  // One part of the profile on its own screen (`openAgentView`), with the large title of the app's pushed lists.
  if (view) {
    const viewTitle =
      view === "access" ? t("agentPage.fields.levels") : view === "memory" ? t("agentPage.tabs.memory") : didHead;
    return (
      <PushedLargeTitle title={viewTitle} grouped>
        <View style={[styles.page, styles.viewPage]}>
          {view === "access" ? accessView : view === "memory" ? memoryView : didView}
        </View>
      </PushedLargeTitle>
    );
  }

  // Whom it answers or who manages it starts a conversation; one already there opens for anyone (the server's `openDm`).
  // Editing it alone talks to nobody (ADR 0085 addendum of 2026-11-17).
  const talkable =
    canTalk(agent) ||
    managesAgent(agent) ||
    Boolean(dms.data?.some((d) => d.with.type === "agent" && d.with.id === id));
  // The message field at the foot (the web card's), where the conversation opens; asking for access stays a button.
  const talksHere = details || !ownerId;
  const docked = talksHere && talkable;

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        // The browser card's own text field: its buttons and the page take a tap with the keyboard up.
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ paddingBottom: insets.bottom + (docked ? DOCK_ROOM : 40) }}
      >
        <View style={styles.cover}>
          <LivePause paused={!arrived}>
            <CoverParallax y={y} style={StyleSheet.absoluteFill}>
              <Sky color={look.color} depth={1} style={StyleSheet.absoluteFill} />
            </CoverParallax>
            <CoverFace
              look={look}
              busy={busy}
              hello={hello}
              presence={status?.presence}
              label={status?.line}
              y={y}
              underBar={underBar}
            />
          </LivePause>
        </View>
        <View style={[styles.prof, sides]}>
          <Text variant="display2" style={styles.center}>
            {name}
          </Text>
          {roleLine ? (
            <Text variant="small" tone="muted" numberOfLines={2} style={styles.center}>
              {roleLine}
            </Text>
          ) : null}
          {tellsNameStory(agent) ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {t("rightHand.profile.nameStory")}
            </Text>
          ) : null}
          {/* Asking for access stays one action under the name; talking is the message field at the foot. */}
          {talksHere ? null : ownerId ? (
            <View style={styles.acts}>
              <Button
                variant="primary"
                label={
                  facts && dir.memberById.get(ownerId)
                    ? t("agentPage.facts.ask", { owner: dir.memberById.get(ownerId)?.name })
                    : t("profile.askAccess")
                }
                loading={opening}
                onPress={() => openDm({ userId: ownerId })}
              />
            </View>
          ) : null}
          {agent?.canTalk === false && !facts ? (
            <Text variant="small" tone="muted" style={styles.center}>
              {details ? t("mobile.agent.cantTalk") : t("profile.detailsHidden", agentGrammar(name))}
            </Text>
          ) : null}
          {agent ? <LetMeTalkButton agent={agent} /> : null}
        </View>

        {rightHand && agent ? (
          <View style={[styles.page, sides]}>
            {/* Its computer as any agent's: the viewer's own seat there. */}
            {details ? <AgentComputerCard agentId={id} style={styles.computer} /> : null}
            {nowBlock}
            <GroupedHeader>{t("rightHand.settings.mine")}</GroupedHeader>
            <RightHandMine agent={agent} />
            <GroupedHeader>{t("rightHand.profile.how")}</GroupedHeader>
            <GroupedList>
              <GroupedRow icon="shield" label={t("rightHand.profile.permissions")} labelLines={2} />
              <GroupedRow icon="lock" label={t("rightHand.profile.private")} labelLines={2} />
              <GroupedRow icon="hash" label={t("rightHand.profile.channels")} labelLines={2} />
              <GroupedRow
                {...(agent.brain?.maker
                  ? { leading: <ProviderLogo id={agent.brain.maker} size="sm" /> }
                  : { icon: "brain" as const })}
                label={t("rightHand.profile.model")}
                {...modelRow(
                  t,
                  agent.brain,
                  apiModelName(t, agent.model, modelLabel(agent.model) ?? undefined, autoMakerOf(aiStatus.data, id)),
                )}
              />
            </GroupedList>
            {details ? accessView : null}
            {/* What it keeps for the viewer and the rules they gave it: theirs to see and take back. */}
            {memoryView}
          </View>
        ) : details ? (
          // The web's card as the screen: what it is on, its computer, who may talk to it and who answers for it, then
          // Details as rows that open their own screens.
          <View style={[styles.page, sides]}>
            {nowBlock}
            {/* Its computer right under what it is on, and what it keeps running there (ADR 0176); both only for
                whoever may watch its computer. */}
            <AgentComputerCard agentId={id} style={styles.computer} />
            <KeptRunningList agentId={id} />
            {agent ? <AudienceGroup agent={agent} /> : null}
            {owner ? (
              <View style={styles.apart}>
                <GroupedList>
                  {/* A role that answers for it shows its mark (ADR 0085, addendum of 2026-11-21). */}
                  <GroupedRow
                    {...(ownerRole
                      ? { leading: <RoleMark color={ownerRole.color} icon={ownerRole.icon} size={22} /> }
                      : { icon: "person" as const })}
                    label={t("mobile.agent.responsible")}
                    value={owner}
                  />
                </GroupedList>
              </View>
            ) : null}
            <GroupedHeader>{t("common.details")}</GroupedHeader>
            <GroupedList>
              {monthRow}
              <GroupedRow
                key="access"
                icon="key"
                label={t("agentPage.fields.levels")}
                chevron
                onPress={() => openAgentView(id, "access")}
              />
              <GroupedRow
                key="memory"
                icon="brain"
                label={t("agentPage.tabs.memory")}
                chevron
                onPress={() => openAgentView(id, "memory")}
              />
              <GroupedRow
                key="did"
                icon="checkc"
                label={didHead}
                {...(did.length > 0 ? { value: String(did.length) } : {})}
                chevron
                onPress={() => openAgentView(id, "did")}
              />
            </GroupedList>
          </View>
        ) : facts && agent ? (
          <View style={[styles.page, sides]}>
            <AgentFacts
              agent={agent}
              detail={detail.data}
              owner={owner ?? null}
              thinks={thinks?.text ?? modelLabel(agent.model)}
            />
          </View>
        ) : (
          <View style={[styles.page, sides]}>{nowBlock}</View>
        )}
      </Animated.ScrollView>
      {docked ? (
        <MessageDock
          side={side}
          label={t("home.ask.label", agentGrammar(name))}
          busy={opening}
          bottom={insets.bottom}
          onPress={() => openDm()}
        />
      ) : null}
      {/* What the clear bar becomes behind the name once the cover is under it (the system draws it on iOS 26). */}
      <CoverBarBackdrop
        y={y}
        from={underBar - 30}
        to={underBar + 70}
        height={insets.top + BAR_HEIGHT}
        tone={c.grouped}
      />
      {/* Its person changes its look; who edits it, its role and instructions; who manages it, everything ("Editar",
          as the web's Configurações). The right hand's settings open for everyone: each person has their own there. */}
      <PushedHeader
        // The bar has no title while the cover shows: the face and the name fade in as the cover's leave under it.
        title={named ? name : ""}
        plate
        solid={false}
        {...(rightHand
          ? { action: { label: t("rightHand.profile.configure"), onPress: openRightHandSettings, opens: true } }
          : (decides || editsAgent(agent)) && agent
            ? { action: { label: t("agent.edit"), onPress: () => openAgentEdit(id), opens: true } }
            : {})}
      />
    </View>
  );
}

/**
 * The agent on its cover, smiling once as the profile opens unless it is at work (`hello`). It answers a touch:
 * startled for a moment, a small hop, then a smile, and back to itself. Its presence is the badge; a screen reader
 * hears it in words, with why. It fades as the cover scrolls under the bar.
 */
function CoverFace({
  look,
  busy,
  hello,
  presence,
  label,
  y,
  underBar,
}: {
  look: AgentLookInput;
  busy: boolean;
  hello: boolean;
  presence: BadgePresence | null | undefined;
  label: string | undefined;
  /** The cover's scroll, and how far it goes before the face reaches the bar: it fades there. */
  y: SharedValue<number>;
  underBar: number;
}) {
  const { motion: m, reducedMotion } = useTheme();
  const fade = useScrollFade(y, underBar - 30, underBar + 70);
  const [mood, setMood] = useState<"surprised" | "happy" | null>(null);
  const hop = useSharedValue(1);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );
  const hopped = useAnimatedStyle(() => ({ transform: [{ scale: hop.get() }] }));
  const touch = () => {
    haptics.light();
    for (const timer of timers.current) clearTimeout(timer);
    setMood("surprised");
    if (!reducedMotion)
      hop.set(withSequence(withTiming(0.9, { duration: m.fast, easing: m.easeOut }), withSpring(1, m.bounce)));
    timers.current = [
      setTimeout(() => setMood("happy"), STARTLED_MS),
      setTimeout(() => setMood(null), STARTLED_MS + HELLO_MS),
    ];
  };
  const expression = mood ?? (hello && !busy ? "happy" : undefined);
  return (
    <Animated.View style={fade} {...(label ? { accessible: true, accessibilityLabel: label } : {})}>
      <Pressable accessible={false} onPress={touch}>
        <Animated.View style={hopped}>
          <WithPresence size={FACE} presence={presence} inset={agentBadgeInset(look, FACE)}>
            <AgentAvatar
              agent={look}
              size={FACE}
              mode={busy ? "run" : "idle"}
              {...(expression ? { expression } : {})}
            />
          </WithPresence>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

/**
 * One view of the profile (Today, Access, Memory), its sections as children. While its data loads the first time,
 * grouped lists stand in for them, so nothing pops in; then the stand-ins fade and the sections rise in, one after
 * the other. A view that opens with its data just shows, and so does a refetch.
 */
function TabPage({ loading, bones, children }: { loading: boolean; bones: number; children: ReactNode }) {
  const first = useFirstLoad(loading);
  const sections = Children.toArray(children).filter(isValidElement);
  return (
    <View>
      {first.skeleton ? (
        <SkeletonOver leaving={first.landing}>
          <GroupBones groups={bones} />
        </SkeletonOver>
      ) : null}
      {loading
        ? null
        : sections.map((section, i) => (
            // A section that grows moves the ones under it as its own rows move (`GroupedList`).
            <LandRow key={section.key ?? i} land={first.landing} index={i} moves>
              {section}
            </LandRow>
          ))}
    </View>
  );
}

/** Stand-ins shaped as grouped lists: a header's bar, then a group of one or two rows. */
function GroupBones({ groups }: { groups: number }) {
  const c = useColors();
  const bone = { backgroundColor: c.sunken };
  return (
    <View>
      {BONES.slice(0, groups).map((rows, g) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed shapes, never reordered
        <View key={g}>
          <View style={styles.boneHead}>
            <View style={[styles.boneBar, bone]} />
          </View>
          <View style={[styles.boneList, { backgroundColor: c.raised }]}>
            {rows.map((width, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed shapes, never reordered
              <View key={i} style={styles.boneRow}>
                <View style={[styles.boneTile, bone]} />
                <View style={styles.grow}>
                  <View style={[styles.boneLabel, bone, { width: `${width}%` }]} />
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** The stand-in groups: each one's rows, as the label's width in percent of its column. */
const BONES: number[][] = [[52, 38], [44], [58, 36]];

/**
 * "Aprovado sempre", as on the web's Ferramentas e acesso: what the agent runs without asking, approved for good
 * from a request, by whom and when. Its owner and whoever decides approvals take one back with its ×, at once.
 * Shown only when there is something.
 */
export function AlwaysApproved({ agentId, name, mayRemove }: { agentId: string; name: string; mayRemove: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useErrorToast();
  const when = useWhen();
  const dir = useDirectory();
  const connected = useConnectedById();
  const rules = useApprovalRules(orgId, agentId);
  const remove = useRemoveApprovalRule(orgId, agentId);
  const list = rules.data ?? [];
  if (list.length === 0) return null;
  return (
    <>
      <GroupedHeader>{t("agentPage.access.always.title")}</GroupedHeader>
      <GroupedList>
        {list.map((rule) => {
          const what = approvalRuleWords(t, rule);
          const who = rule.createdByUserId ? dir.memberById.get(rule.createdByUserId)?.name : undefined;
          const at = when.short(rule.createdAt);
          return (
            <GroupedRow
              key={rule.id}
              leading={
                <ConnectorIcon
                  def={(rule.connectionId && connected.get(rule.connectionId)?.def) || null}
                  image={rule.connectionId ? connected.get(rule.connectionId)?.image : null}
                  label={approvalRuleServer(t, rule)}
                  size={30}
                />
              }
              label={what}
              labelLines={2}
              sub={
                who
                  ? t("agentPage.access.always.by", { name: who, when: at })
                  : t("agentPage.access.always.byNobody", { when: at })
              }
              subLines={2}
              // Its × takes it back at once (gone while a removal is on its way).
              {...(mayRemove && !remove.isPending
                ? {
                    remove: {
                      label: t("agentPage.access.always.remove", { what }),
                      onPress: () =>
                        remove.mutate(rule.id, {
                          onSuccess: () => toast({ title: t("agentPage.access.always.removed", { name }), agentId }),
                          onError: failed,
                        }),
                    },
                  }
                : {})}
            />
          );
        })}
      </GroupedList>
      <GroupedFooter>{t("agentPage.access.always.help")}</GroupedFooter>
    </>
  );
}

/**
 * "Regras que as pessoas deram", as on the web's Memória: what people told it to always do, by whom and when. Its
 * giver, the agent's owner and admins take one back with a swipe, confirmed by a system alert (never a bare × that
 * deletes on the tap). Shown only when there is something.
 */
function GivenRules({ agentId, name, rightHand }: { agentId: string; name: string; rightHand: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useErrorToast();
  const when = useWhen();
  const memory = useMemory(orgId, agentId);
  const remove = useMemoryAction(orgId, agentId);
  const list = (memory.data ?? []).filter((m) => m.kind === "rule" && !m.archived);
  if (list.length === 0) return null;
  const ask = (m: Memory) =>
    Alert.alert(t("mobile.intentAgents.knows.ruleTitle"), t("mobile.intentAgents.knows.ruleBody", agentGrammar(name)), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("mobile.intentAgents.knows.ruleRemove"),
        style: "destructive",
        onPress: () =>
          remove.mutate(
            { type: "archive", id: m.id, archived: true },
            {
              onSuccess: () => toast({ title: t("agentPage.memory.ruleRemoved"), agentId }),
              onError: failed,
            },
          ),
      },
    ]);
  return (
    <>
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("agentPage.memory.rules") }),
          text: t(rightHand ? "agentPage.memory.rulesNoteRightHand" : "agentPage.memory.rulesNote"),
        }}
      >
        {t("agentPage.memory.rules")}
      </GroupedHeader>
      <GroupedList>
        {list.map((m) => {
          const row = (
            <GroupedRow
              icon="flag"
              label={m.text}
              labelLines={3}
              sub={t("agentPage.memory.ruleBy", {
                name: m.origin?.name ?? t("memory.origin.someone"),
                date: when.short(m.origin?.at ?? m.updatedAt),
              })}
            />
          );
          if (!m.removable) return <Fragment key={m.id}>{row}</Fragment>;
          return (
            <SwipeRow
              key={m.id}
              right={{
                label: t("mobile.intentAgents.knows.ruleRemove"),
                icon: "trash",
                color: c.danger,
                ink: c.bg,
                onAction: () => ask(m),
              }}
            >
              <View style={{ backgroundColor: c.raised }}>{row}</View>
            </SwipeRow>
          );
        })}
      </GroupedList>
    </>
  );
}

/** "Corrigir uma memória": edit the text (the old one stays in the history) or forget it (archived). */
export function MemoryFix({
  memory: m,
  agentId,
  agentName,
  g,
  source,
  onSee,
  onDone,
  title,
}: {
  memory: Memory;
  agentId: string;
  agentName: string;
  g: string;
  source: string;
  onSee: (() => void) | undefined;
  onDone: () => void;
  /** In place of "Corrigir a memória de…" (the team's memory, ADR 0167). */
  title?: string;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const toast = useToast();
  const action = useMemoryAction(orgId, agentId);
  const [text, setText] = useState(m.text);
  const changed = text.trim() !== "" && text.trim() !== m.text.trim() && !overLimit(text, MEMORY_LIMIT);
  const failed = useErrorToast();
  const save = () =>
    action.mutate(
      { type: "edit", id: m.id, text: text.trim() },
      {
        onSuccess: () => {
          toast({ title: t("mobile.intentAgents.fix.saved"), agentId });
          onDone();
        },
        onError: failed,
      },
    );
  const forget = () =>
    action.mutate(
      { type: "archive", id: m.id, archived: true },
      {
        onSuccess: () => {
          toast({ title: t("mobile.intentAgents.fix.forgotten"), agentId });
          onDone();
        },
        onError: failed,
      },
    );
  return (
    <>
      <SheetTitle title={title ?? t(`mobile.intentAgents.fix.title${g}`, { name: agentName })} />
      <Locked when={action.isPending}>
        <TextArea value={text} onChangeText={setText} autoFocus limit={MEMORY_LIMIT} />
      </Locked>
      <View style={styles.src}>
        <Icon name="chat" size={15} color={c.muted} />
        <Text variant="small" tone="muted" numberOfLines={1} style={styles.grow}>
          {source}
        </Text>
        {onSee ? (
          <Pressable
            onPress={onSee}
            accessibilityRole="link"
            hitSlop={12}
            style={({ pressed }) => (pressed ? styles.pressed : null)}
          >
            <Text variant="small" tone="ink2" style={styles.bold}>
              {t("mobile.intentAgents.fix.see")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Button
        variant="primary"
        wide
        icon="check"
        label={t("mobile.intentAgents.fix.save")}
        disabled={!changed || action.isPending}
        onPress={save}
      />
      <Button
        variant="ghost"
        wide
        label={t("mobile.intentAgents.fix.forget")}
        disabled={action.isPending}
        onPress={forget}
      />
    </>
  );
}

/**
 * "Who can talk" as the web's card says it: everyone in the workspace or only who answers for it in one row, or its
 * roles and people one row each, with who answers for it (who always may) said under them.
 */
function AudienceGroup({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const org = useOrg().org;
  const dir = useDirectory();
  const roles = useRoles(useOrgId()).data?.roles;
  const ownerRoles = useOwnerRoles();
  const a = audienceOf(agent);
  const ownerRole = ownerRoleOf(agent, ownerRoles);
  const owner = ownerNameIn(agent, dir.memberById, ownerRoles);
  const nameOf = (userId: string) => dir.memberById.get(userId)?.name;
  const roleName = (roleId: string) => roles?.find((r) => r.id === roleId)?.name;
  const picked =
    a.mode === "people"
      ? [
          ...a.roleIds.flatMap((roleId) => {
            const r = roles?.find((x) => x.id === roleId);
            return r
              ? [
                  <GroupedRow
                    key={`role:${roleId}`}
                    leading={<RoleMark color={r.color} icon={r.icon} size={22} />}
                    label={r.name}
                  />,
                ]
              : [];
          }),
          ...a.userIds.flatMap((userId) => {
            const m = dir.memberById.get(userId);
            return m
              ? [
                  <GroupedRow
                    key={`person:${userId}`}
                    leading={<Face who={{ type: "person", id: userId }} size={26} live={false} />}
                    label={m.name}
                  />,
                ]
              : [];
          }),
        ]
      : [];
  const always =
    a.mode === "people"
      ? ownerRole
        ? t("audience.ownerRoleAlways", { role: ownerRole.name })
        : owner
          ? t("audience.ownerAlways", { name: owner })
          : null
      : null;
  return (
    <>
      <GroupedHeader>{t("audience.section")}</GroupedHeader>
      <GroupedList>
        {picked.length === 0
          ? [
              <GroupedRow
                key="summary"
                icon="members"
                label={audienceSummary(t, agent, nameOf, roleName, org ?? undefined)}
                labelLines={2}
              />,
            ]
          : picked}
      </GroupedList>
      {always ? <GroupedFooter>{always}</GroupedFooter> : null}
    </>
  );
}

/** The web card's message field at the screen's foot: a tap opens the conversation, where it is written and sent. */
function MessageDock({
  side,
  label,
  busy,
  bottom,
  onPress,
}: {
  /** The readable column's margin on a large screen, as the page's. */
  side: number;
  label: string;
  busy: boolean;
  bottom: number;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <View
      style={[
        styles.dock,
        { paddingBottom: bottom + 8, backgroundColor: c.grouped },
        side > 0 ? { paddingHorizontal: SCREEN_X + side } : null,
      ]}
    >
      <Pressable
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy }}
        style={({ pressed }) => [
          styles.dockField,
          { backgroundColor: c.raised, borderColor: c.line2 },
          pressed && styles.pressed,
        ]}
      >
        <Text variant="body" tone="faint" numberOfLines={1} style={styles.grow}>
          {label}
        </Text>
        <Icon name="chat" size={18} color={c.faint} />
      </Pressable>
    </View>
  );
}

/** Room under the page for the message field at its foot (its 48, 8 above it and 8 over the home indicator's room). */
const DOCK_ROOM = 96;

/** How long the face holds its smile when the profile opens, and after a touch. */
const HELLO_MS = 900;
/** How long a touched face stays startled before it smiles. */
const STARTLED_MS = 280;

/** True for a moment after the profile has come in (`arrived`): the face's hello. */
function useHello(arrived: boolean) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!arrived) return;
    const off = setTimeout(() => setOn(false), HELLO_MS);
    return () => clearTimeout(off);
  }, [arrived]);
  return on;
}

/** Height of the sky cover, the bar's area included. */
const COVER_HEIGHT = 250;
/** The agent's face, unframed, and the room under it at the cover's foot. */
const FACE = 96;
const COVER_FOOT = 14;
/** Where the agent's top sits in the cover, and the bar's height. */
const AVATAR_TOP = COVER_HEIGHT - COVER_FOOT - FACE;
const BAR_HEIGHT = 44;
/** The face beside the name in the bar. */
/** How far the name scrolls past the bar's foot before the bar takes it as its title. */
const NAME_UNDER_BAR = 70;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // Not clipped: on a pull the sky grows up into the gap above the content.
  cover: { height: COVER_HEIGHT, alignItems: "center", justifyContent: "flex-end", paddingBottom: COVER_FOOT },
  // Face, name 28, what it does 15: 8 apart; the buttons 16 under them. At the page's sides, as everything under it.
  prof: { paddingHorizontal: SCREEN_X, gap: 8 },
  center: { textAlign: "center" },
  // Chat alone, centered under the words at its own width; 16 under them (8 of `prof` and 8 here).
  acts: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 8 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
  // The head, the computer, the views and the lists 24 apart: the same step between each block of the page.
  computer: { marginTop: 24 },
  page: { paddingHorizontal: SCREEN_X },
  // One part on its own screen: its first block a step under the large title.
  viewPage: { paddingTop: 8 },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: SCREEN_X, paddingTop: 8 },
  dockField: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 48,
    // Its words where a row's start.
    paddingHorizontal: GROUPED_ROW.padX,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
  },
  block: { marginTop: 16 },
  // The orbit centered in the row's 36 leading column, where a tile would sit.
  orbit: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  pixels: { marginBottom: 12 },
  apart: { marginTop: 24 },
  src: { flexDirection: "row", alignItems: "center", gap: 6 },
  shrink: { flexShrink: 1 },
  // A grouped header's room (20 above its 18 line, 8 under), the bar in the line's middle.
  boneHead: { height: 46, paddingTop: 24, paddingHorizontal: GROUPED_ROW.padX },
  boneBar: { width: 96, height: 10, borderRadius: 5 },
  boneLabel: { height: 12, borderRadius: 6 },
  // As `GroupedList`'s card.
  boneList: { borderRadius: 14, overflow: "hidden" },
  boneRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
  },
  boneTile: { width: 28, height: 28, borderRadius: 8 },
});
