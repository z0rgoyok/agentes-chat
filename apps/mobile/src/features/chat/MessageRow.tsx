import {
  browserHandoffOf,
  browserTrailOf,
  codeSuggestionOf,
  desktopTrailOf,
  isPinnedSelection,
  keys,
  type Message,
  type MessageReceipt,
  messageLiveRef,
  type ReplyRef,
  type RunConsultation,
  resolvedOf,
  type ScreenKind,
  type SurfaceLinks,
  type ThreadInfo,
  useApi,
  useContinuedRun,
  useReactions,
  useToggleReaction,
  useWaiting,
} from "@agenteschat/client";
import { actionCardOf, costlyProposalOf, stretchCardOf } from "@agenteschat/client/lib/action-cards";
import { foldTalk, TALK_LINE_CHARS, talksToAgent } from "@agenteschat/client/lib/agent-talk";
import { APP_BRANDS } from "@agenteschat/client/lib/apps";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { channelRefsOf } from "@agenteschat/client/lib/channel-refs";
import { type RunPosition, runAround } from "@agenteschat/client/lib/chat";
import { mineOnRight } from "@agenteschat/client/lib/chat-look";
import { choiceReplyLine } from "@agenteschat/client/lib/choices";
import { agentsByAnyHandle } from "@agenteschat/client/lib/directory";
import {
  CONTINUE_ERRORS,
  errorCode,
  errorText,
  filesTextOnlyOf,
  runErrorText,
  sendFailureText,
  sendNeedsEdit,
} from "@agenteschat/client/lib/errors";
import { mentionsReader } from "@agenteschat/client/lib/everyone";
import { feedbackOfferOf } from "@agenteschat/client/lib/feedback-offer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { issueWorkOf } from "@agenteschat/client/lib/issues";
import { workAnchorBody, workContinuable, workIsOver } from "@agenteschat/client/lib/long-work";
import { brainUnavailableOf, messageToolOff } from "@agenteschat/client/lib/machine-outages";
import { isMediaAfterReply, messageMediaOf } from "@agenteschat/client/lib/media";
import { memberRoleColor } from "@agenteschat/client/lib/member-groups";
import { serverBody } from "@agenteschat/client/lib/message-body";
import { missionSetupOf } from "@agenteschat/client/lib/missions";
import { isStandInLine, noAiCardOf } from "@agenteschat/client/lib/no-ai";
import { isTalkerReply, routineReportText, talkerWaited } from "@agenteschat/client/lib/notices";
import { modelStandInText } from "@agenteschat/client/lib/plan-usage";
import { reachHandoffs } from "@agenteschat/client/lib/reach";
import { replyOf } from "@agenteschat/client/lib/reply";
import { isReminderMessage, reminderBody, routineReplyOf } from "@agenteschat/client/lib/routines";
import { replyChipsOf } from "@agenteschat/client/lib/team-plan";
import { usagePauseCardOf, usageWaitOf } from "@agenteschat/client/lib/usage-pause";
import { appVia } from "@agenteschat/client/lib/via";
import { listedText, voiceOf } from "@agenteschat/client/lib/voice";
import { type ReplyStop, splitCanceled } from "@agenteschat/client/lib/work";
import { useShowsWork } from "@agenteschat/client/lib/work-context";
import { type AgentColorName, mixHex } from "@agenteschat/ui/agent/engine";
import { WALLPAPER_LIFT } from "@agenteschat/ui/sky/wallpaper";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type GestureResponderEvent, Keyboard, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  type EntryExitAnimationFunction,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  withTiming,
} from "react-native-reanimated";
import { serverUrl } from "@/lib/server";
import { readValueSync, STORED, writeValueSync } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import {
  Button,
  CHROME_MAX_SCALE,
  Count,
  EventPillAction,
  haptics,
  Icon,
  InkOrbit,
  LineIcon,
  MarkIcon,
  PressScale,
  ProviderLogo,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { Shake } from "@/ui/auth/Shake";
import { router } from "@/ui/navigation";
import { RADIUS } from "@/ui/radius";
import { InstructionProposals } from "../agents/InstructionProposalCard";
import { ProposalCard } from "../agents/ProposalCard";
import { CostlyProposalCard } from "../ai/CostlyProposalCard";
import { NoAiCard } from "../ai/NoAiCard";
import { OfferCard } from "../ai/OfferCard";
import { StretchCard } from "../ai/StretchCard";
import { UsagePauseCard, UsageWaitCancel } from "../ai/UsagePauseCard";
import { HandoffCard } from "../browser/HandoffCard";
import { TrailCard } from "../browser/TrailCard";
import { CodeSuggestionCard } from "../coding/SuggestionCard";
import { iconUri } from "../connectors/logic";
import { DeviceWait } from "../devices/DeviceWait";
import { deviceWaitOf } from "../devices/logic";
import { WaitToolOffAction } from "../devices/ToolOneClick";
import { localFilesOf } from "../files/local-files";
import { LocalFiles, MessageFiles } from "../files/MessageFiles";
import { consultationHref, routineHref } from "../links/logic";
import { MessageAbout, ResolvedLine } from "../live-files/talk/AboutLine";
import { surfaceTagText } from "../me/surface";
import { DecisionCard, MissionCard, PlanCard, ReviewCard, SetupFailedCard } from "../missions/cards";
import { AwayPill, BrainWait } from "../outages/WaitCard";
import { SettingsProposals } from "../right-hand/SettingsCard";
import { ReplyChips, TeamCard } from "../right-hand/TeamCard";
import { TeamWeek } from "../right-hand/TeamWeekCard";
import { type BubbleHead, BubbleHeadContext, type BubblePart, BubblePartContext } from "../shared/bubble-part";
import { AgentFace, Face, withAgentFaces } from "../shared/Face";
import { useColors, useOrgId, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { ownsIn } from "../shared/owner";
import { tapHaptic } from "../shared/parts";
import { VoiceMessage } from "../voice/VoiceMessage";
import { FilesTextOnlyFix, ReceiptMark } from "./AgentReceipts";
import { secretRequestOf } from "./ask-store";
import { useBubbleCap } from "./bubble-cap";
import { ChatMedia } from "./ChatMedia";
import { ClippedMessage, OpenedMessagesContext } from "./ClippedMessage";
import { ConsultQuote, useRunConsults } from "./ConsultGroup";
import { ApprovalInline, QuestionCard, ThreadLink, ThreadReplyingLink } from "./cards";
import { FeedbackOfferRow } from "./FeedbackOffer";
import { HandedTaskChips, IssueWorkCard } from "./issue-work";
import { keepOpen, keptOpen } from "./kept-sizes";
import { cacheContinued } from "./live";
import {
  approvalIdOf,
  artifactsOf,
  BUBBLES_EDGE,
  CHAT_TEXT_MAX_SCALE,
  chatNameOf,
  chatTimeOf,
  consultationsOf,
  DOUBLE_TAP_MS,
  hangsUnder,
  hidesBody,
  MSG_AVATAR,
  MSG_GAP,
  MSG_INSET,
  mayStopRun,
  missionCardRef,
  missionLinkOf,
  missionPlanOf,
  nameInk,
  questionOf,
  ROW_BODY_INSET,
  reactionPills,
  rowFrame,
  workStepsOf,
} from "./logic";
import { liftedEdge, lookRows, plateInset, RowPartContext, useRhythm, useRowLook } from "./look";
import { MessageText } from "./MessageText";
import { aboveInset, QuoteAbove, QuotePlate } from "./QuoteLine";
import { ReachLines } from "./ReachLines";
import { Receipts } from "./Receipts";
import {
  useRowConsultsPart,
  useRowDirectory,
  useRowMeId,
  useRowMyHandle,
  useRowNamesComputers,
  useRowRoles,
} from "./row-data";
import { SecretCard } from "./SecretCard";
import { ModelStandInLine, SpeedFallbackLine, StopPill } from "./StoppedLine";
import { useStopMovedOn, useStoppedRun } from "./stopped-runs";
import { SwipeSlide, SwipeTime, useGiveWay, useSwipeSlide } from "./swipe-time";
import { TeamChecks } from "./TeamChecks";
import { SavedTools, TurnTools } from "./ToolCalls";
import { keptTurn, stepLimitOf, stoppedOf, turnOpener } from "./turn";
import { HandedWorkLines, MessageWorkLine } from "./WorkLine";

/** A run's message asks whether a take over still holds its browser only this recently (older: events only). */
const TRAIL_RECENT_MS = 12 * 60 * 60_000;

/**
 * One message: the face and name (dropped when grouped), a pin mark when
 * pinned, what it consulted, its text, the cards it carries and the reactions. Long press opens its
 * actions (the screen's sheet). An agent's reply takes its live block's place: its tools stay one closed
 * line under its words and what it changed ("Usou N ferramentas"), the same place live, kept and saved, and a
 * stopped one says so with "Continuar". A person's message's
 * receipt is a mark in a line the row already has (`ReceiptMark`), so it never changes the row's height: after the
 * time under my turn, whether an agent read it ("lê na próxima pausa", "leu") or who read it in a DM; at the end of
 * someone else's name line, the agents' receipt of their latest message.
 *
 * What the row holds when it mounts just shows (`skipEntering`): the list mounts a row again each time it comes back
 * into view, and a part that fades in when it changes (a receipt's mark, a decided request's outcome, an undone
 * action's line) faded in again on every scroll. What changes while the row shows still fades in.
 *
 * "See more" opening its message mounts the row again the same way, at its whole height from its first frame (the
 * words' height and a table's columns are kept): grown in place, the bubble's frame stayed taller than its words, an
 * empty block under the last line that pushed what follows away (seen on a phone).
 */
export const MessageRow = memo(function MessageRow(props: RowProps) {
  const opened = useContext(OpenedMessagesContext)?.has(props.message.id) === true;
  return (
    <LayoutAnimationConfig key={opened ? "opened" : "row"} skipEntering>
      <RowBody {...props} />
    </LayoutAnimationConfig>
  );
});

interface RowProps {
  message: Message;
  grouped: boolean;
  /** Next in its turn, but under something else: it takes a turn's gap. */
  newTurn?: boolean | undefined;
  /** My own row's place in a run of my rows (`runPosition`): the corners it shares square off, the time ends it. */
  run?: RunPosition;
  /** The message it groups under, and whether that one shows its thread's link: what hangs under it ends the run. */
  above?: Message;
  aboveThread?: boolean;
  meId: string | null;
  /** Its thread, when it is the root of one the conversation shows as a link. */
  thread?: ThreadInfo;
  /** With no `thread` yet: the agents replying in the thread under it, comma-joined (ADR 0214). */
  replying?: string | undefined;
  /** Absent where it is read only. */
  onLongPress?: (m: Message) => void;
  onRetry?: (m: Message) => void;
  /** A tap on what it answers. */
  onQuote?: (reply: ReplyRef) => void;
  /** The agents' receipt its mark shows: the latest person's message's, on it or on its turn's first row. */
  receipt?: MessageReceipt;
  /** A DM between people: who read this message, my latest. */
  seenBy?: string;
  /** Shown where the person can't act on it (two agents' conversation): no long press, reactions or block. */
  readOnly?: boolean;
  /** On its thread's own screen: a long message between agents is read whole there. */
  inThread?: boolean;
}

function RowBody({
  message: m,
  grouped: groupedIn,
  newTurn,
  meId,
  thread,
  replying,
  onLongPress,
  onRetry,
  onQuote,
  receipt,
  seenBy,
  readOnly = false,
  inThread = false,
  run: runAt = "solo",
  above,
  aboveThread = false,
}: RowProps) {
  const { t, i18n } = useTranslation();
  // Mine and not sent for lack of a connection: it waits and goes by itself when the connection is back.
  const offline = useWaiting(m.local === "failed" ? m.clientId : null);
  // The moment a send fails (not a row drawn already failed, nor one waiting for the connection): the row shakes
  // once and the phone says so, once. A row that was ever on its way keeps the shaking view, so the saved copy
  // taking its place never mounts the row again.
  const failedNow = m.local === "failed" && !offline;
  const sendId = m.clientId ?? m.id;
  const failSeen = useRef({ id: sendId, failed: failedNow });
  const [shook, setShook] = useState(false);
  const [shakes, setShakes] = useState(Boolean(m.local));
  if (m.local && !shakes) setShakes(true);
  useEffect(() => {
    const seen = failSeen.current;
    failSeen.current = { id: sendId, failed: failedNow };
    if (!failedNow) setShook(false);
    else if (seen.id === sendId && !seen.failed) {
      haptics.error();
      setShook(true);
    }
  }, [sendId, failedNow]);
  const shaking = (row: ReactNode) => (shakes ? <Shake when={shook}>{row}</Shake> : row);
  const dir = useRowDirectory();
  const c = useColors();
  const when = useWhen();
  const isAgent = m.author.type === "agent";
  const agent = isAgent && m.author.id ? dir.agentById.get(m.author.id) : undefined;
  const accent = agent ? agentLook(agent).color : undefined;
  const color = agentLook(agent).color;
  const name = dir.nameOf(m.author) || t("mobile.chat.someone");
  const meta = m.meta;
  const standIn = modelStandInText(t, meta);
  // What a routine found, told by its agent (as on the web): a small tag, and the report it answers on demand
  // (that report's own line folds into this message). Unfolded, it comes back unfolded with its row (`keptOpen`).
  const routine = routineReplyOf(m);
  const [reportOpen, setReportOpen] = useState(() => keptOpen(`report:${m.id}`));
  const qc = useQueryClient();
  const orgId = useOrgId();
  const { org } = useOrg();
  const shows = useShowsWork(org);
  // Found again only when the cached lists it reads change, not on every draw of the row.
  const noticeId = routine?.noticeId;
  const listed = noticeId ? qc.getQueryData<Message[]>(keys.messages(orgId, m.channelId)) : undefined;
  const threaded =
    noticeId && m.threadId ? qc.getQueryData<Message[]>(keys.thread(orgId, m.channelId, m.threadId)) : undefined;
  const report = useMemo(
    () => (noticeId ? routineReportText([...(listed ?? []), ...(threaded ?? [])], noticeId) : null),
    [noticeId, listed, threaded],
  );
  // A plain reminder: the agent's own message with a "Lembrete" label (the server's prefix dropped).
  const reminder = isReminderMessage(meta);
  // A short reply it gave while its task kept working (the talker): its message, "enquanto trabalha".
  const talker = isAgent && isTalkerReply(meta);
  // A person's message sent through a connected AI app (ADR 0119): "via Claude".
  const via = m.author.type === "person" ? appVia(meta) : null;
  const viaMark = via?.brand ? APP_BRANDS[via.brand] : undefined;
  // Written on the outside chat surface (ADR 0187): "via <surface>", or that it was forwarded there.
  const surfaceTag =
    m.author.type === "person"
      ? surfaceTagText(t, meta, name, qc.getQueryData<SurfaceLinks>(keys.surfaceLinks), i18n.language)
      : null;
  // What the server wrote itself is said in the person's language; a stopped reply drops the server's note. Where a
  // task ran is said only where the workspace has more than one computer.
  const names = useRowNamesComputers();
  const said = hidesBody(m)
    ? ""
    : reminderBody(splitCanceled(serverBody(t, listedText(m.body, meta), meta, i18n.language, names), meta).body, meta);
  // A long work's anchor once it's over: no promise left, and dimmed (its line says how it ended).
  // The right hand's stand-in line is its pill's sentence (`NoAiCard`): no text above it too.
  const body = isStandInLine(meta) ? "" : m.longWork ? workAnchorBody(t, said, meta, m.longWork) : said;
  const workOver = Boolean(m.longWork && workIsOver(m.longWork));
  // The person's pick on a choice card (ADR 0124): one compact line, not a bubble.
  const choiceReply = meta?.choiceReply && body ? <ChoiceReply text={choiceReplyLine(body)} /> : null;
  const consulted = isAgent && m.author.id ? consultationsOf(meta) : [];
  // A long message from one agent to another (ADR 0034): its first paragraph and "Ver mais", which opens the rest in
  // place. On its thread's screen, and where it is read only, it stays whole.
  const talk = useMemo(
    () =>
      isAgent &&
      !inThread &&
      !readOnly &&
      !m.local &&
      talksToAgent(m, (handle) => agentsByAnyHandle([...dir.agentById.values()]).get(handle)?.id)
        ? foldTalk(body, TALK_LINE_CHARS.phone)
        : null,
    [isAgent, inThread, readOnly, m, body, dir.agentById],
  );
  // A GIF or a sticker (ADR 0091); with no words, the message is the picture alone (no empty bubble).
  const media = messageMediaOf(meta);
  // The one an agent adds after its own reply carries the reply's run: the run's tools, questions and stop line
  // stay on the reply, never shown twice.
  const mediaAfter = isAgent && isMediaAfterReply(meta);
  // It asked other agents first (its run's questions on the run's first message here, and the ones its
  // `meta.consulted` names): quoted at the top of its words, as a reply quotes a message. With no words to sit in (a
  // reply that is only cards), the quote stands on its own right before it, and the reply shows its face and name
  // again under it.
  const reached = useMemo(() => reachHandoffs(m.meta), [m.meta]);
  const rhythm = useRhythm();
  const consults = useRunConsults(
    isAgent && !m.local && !readOnly && !mediaAfter ? m.agentRunId : null,
    m,
    m.id,
    consulted,
    reached,
  );
  // Work it handed over that reports here: its line under this reply says what the pair row would.
  const paired = consults.filter((c) => !m.handedWorks?.some((w) => w.handedBy?.consultationId === c.id));
  const consultQuote =
    isAgent && m.author.id && paired.length > 0 ? (
      <ConsultQuote askerId={m.author.id} channelId={m.channelId} items={paired} />
    ) : null;
  const quoteAlone = consultQuote !== null && (!body || Boolean(choiceReply));
  const quoteInWords = quoteAlone ? null : consultQuote;
  const grouped = groupedIn && !quoteAlone;
  // A question to another agent (in their DM) carries the asking run: its work shows on that run's reply.
  const ownWork = isAgent && Boolean(m.agentRunId) && !meta?.consultation && !mediaAfter;
  const steps = ownWork ? workStepsOf(meta) : null;
  // Posted by a run answering another agent's question from here (its approval, question, secret): whom it helps. Only
  // that question: the row draws again when it changes, not on every reload of the conversation's questions.
  const helpingRun = isAgent && m.agentRunId && !readOnly && !mediaAfter ? m.agentRunId : null;
  const helping = useRowConsultsPart(m.channelId, (list) =>
    helpingRun ? list.byConsultedRun.get(helpingRun) : undefined,
  );
  // No `onLongPress` where the system's menu takes the hold (iOS): the row adds nothing of its own to it.
  const press =
    readOnly || !onLongPress
      ? undefined
      : () => {
          tapHaptic();
          onLongPress(m);
        };
  // Two taps on a message send the thumbs up without opening anything: one light tap, the emoji pops where the
  // finger was and the pill grows in under the words; holding still opens the menu with every reaction. The line
  // "Toque duplo = 👍" sits under one agent's message until it has been seen once.
  const reduced = useReducedMotion();
  // Read once for the row: its pills (`Reactions`), the double tap and the run's corners all take these.
  const cachedReactions = useReactions(orgId, m.id, false);
  const reactions = cachedReactions.data ?? m.reactions;
  const toggle = useToggleReaction(orgId, m.id);
  const lastTap = useRef(0);
  const [pop, setPop] = useState<{ x: number; y: number; at: number } | null>(null);
  const canReact = !readOnly && !m.local;
  // The row takes the tap, so the list (`keyboardShouldPersistTaps="handled"`) never puts the keyboard away for it:
  // the row does, as a tap on the conversation does in any chat.
  const onTap = (e: GestureResponderEvent) => {
    Keyboard.dismiss();
    if (!canReact) return;
    const at = Date.now();
    if (at - lastTap.current > DOUBLE_TAP_MS) {
      lastTap.current = at;
      return;
    }
    lastTap.current = 0;
    haptics.light();
    const mine = reactionPills(reactions, meId).find((p) => p.reaction === THUMBS)?.mine ?? false;
    toggle.mutate({ reaction: THUMBS, on: !mine });
    setPop({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY, at });
    teachDoubleTap();
  };
  useEffect(() => {
    if (!pop) return;
    const timer = setTimeout(() => setPop(null), POP_MS);
    return () => clearTimeout(timer);
  }, [pop]);
  const popNode = pop ? (
    <Animated.View
      key={pop.at}
      pointerEvents="none"
      entering={reduced ? undefined : POP_IN}
      exiting={reduced ? undefined : POP_OUT}
      style={[styles.pop, { left: pop.x - POP / 2, top: pop.y - POP / 2 }]}
    >
      <Text style={styles.popEmoji} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
        👍
      </Text>
    </Animated.View>
  ) : null;
  const hint = useDoubleTapHint(canReact && isAgent && !groupedIn ? m.id : null);
  const hintNode = hint ? (
    <Text variant="caption" tone="faint" style={styles.hint}>
      {t("mobile.chat.doubleTapHint")}
    </Text>
  ) : null;
  const stopped = isAgent && m.agentRunId && !mediaAfter ? stoppedOf(meta) : null;
  // The reply of a run that reached its step limit: the same line, with Continuar.
  const atLimit = isAgent && m.agentRunId && !stopped && !mediaAfter ? stepLimitOf(meta) : null;
  // A long work's end after its AI provider failed: Continuar under it too.
  const providerCut = isAgent && m.agentRunId && !stopped && !atLimit ? workContinuable(meta) : null;
  const approvalId = approvalIdOf(meta);
  const question = isAgent ? questionOf(meta) : null;
  // An agent asks a person for a secret for its computer (ADR 0027).
  const secret = isAgent ? secretRequestOf(meta) : null;
  // The agent needs a person in its browser (ADR 0040): the request, live.
  const handoff = isAgent ? browserHandoffOf(meta) : null;
  // A card its run posts on the way (Connect, a proposal, an approval, a question, a secret, a handoff), from inside a
  // call still running: never the run's reply.
  const postedCard = Boolean(meta?.actionCard || approvalId || question || secret || handoff);
  // This reply just took its live block's place here: the same tools (and the messages it read) stay, also each time
  // the row comes back into view (`keptTurn`). Only the reply: a card took the work so far, its running call read as
  // stopped, kept it for the whole session, and the reply showed it all again.
  const [kept] = useState(() =>
    ownWork && m.agentRunId && !postedCard ? keptTurn(m.id, m.agentRunId, Date.now()) : null,
  );
  // The line its block opened with stays above the tools, where it was, instead of moving into them (`turnOpener`).
  const opened = kept ? turnOpener(kept.items, body) : null;
  const review = missionCardRef(meta, "missionReview");
  const decision = missionCardRef(meta, "missionDecision");
  const plan = missionPlanOf(meta);
  // Preparing the mission's copy of the project failed (ADR 0044): the card with "Tentar de novo".
  const setup = missionSetupOf(meta);
  const link = missionLinkOf(meta);
  // A code session it suggested for a change asked here (ADR 0215 §11): the person's card under the reply.
  const suggestion = m.author.type === "agent" && !m.local ? codeSuggestionOf(meta) : null;
  const files = artifactsOf(meta);
  // Mine, just sent: drawn from the phone while they upload.
  const localFiles = localFilesOf(meta);
  // The message above's reactions as `useReactions` reads them (cached, never fetched here); with no message above,
  // nothing to follow.
  const api = useApi();
  const aboveId = above?.id ?? "";
  const aboveReactions = useQuery({
    queryKey: keys.reactions(orgId, aboveId),
    queryFn: () => api.chat.reactions(orgId, aboveId),
    enabled: false,
    staleTime: 30_000,
    subscribed: above !== undefined,
  }).data;
  const run = runAround(
    runAt,
    above ? hangsUnder(above, aboveThread, aboveReactions, meId) : false,
    hangsUnder(m, Boolean(thread || replying), cachedReactions.data, meId),
  );
  // A card in a row of its own under the same author's words stands as far off them as in the same row.
  const cardRow = !body && !media && postedCard;
  // Settings it proposes, or a workspace action it asks for: their card (`SettingsProposals`).
  const actionKind = actionCardOf(meta)?.kind;
  const settingsCard = actionKind === "settings_proposal" || actionKind === "workspace_action";
  const rowGap = !grouped || newTurn ? rhythm.turn : cardRow ? rhythm.card : rhythm.part;
  const cardTop = body || media ? rhythm.card - rhythm.part : 0;
  // Where it browsed, or what it did on its desktop, after the run (as on the web): the steps' card.
  // Step summaries, no picture: activity, so the person's setting hides them like the tool block.
  const trails =
    isAgent && m.author.id && !m.local && shows
      ? {
          browser: browserTrailOf(meta),
          desktop: desktopTrailOf(meta),
          recent: Date.now() - Date.parse(m.createdAt) < TRAIL_RECENT_MS,
        }
      : null;
  // Calls that have their own card under the message (where it browsed, its desktop) stay out of its tools.
  const onCards: ScreenKind[] = [
    ...(trails?.browser.length ? (["browser"] as const) : []),
    ...(trails?.desktop.length ? (["desktop"] as const) : []),
  ];
  // "Esperando o MacBook Air voltar": its brain's computer is offline (the card, when it says which computer).
  // Waiting for a device someone brought (a phone, another computer): its own pill, with what can be done about it.
  const deviceWait = isAgent && deviceWaitOf(meta) !== null;
  const brainWait = isAgent && !deviceWait && Boolean(brainUnavailableOf(meta)?.machineId);
  // The root of an issue's work thread (asked an agent to implement it): the issue card.
  const issueWork = issueWorkOf(meta);
  // My own message. In the styles that keep it apart, a bubble on the right with no face or name; in the others, a row
  // like anyone's.
  const mine = m.author.type === "person" && Boolean(meId) && m.author.id === meId;
  const look = useRowLook();
  // The name over the words and its time follow the person's Tamanho do texto, as the words do.
  const nameSize = look.text ? chatNameOf(look.text) : undefined;
  const timeSize = look.text ? chatTimeOf(look.text) : undefined;
  const onRight = mine && mineOnRight(look.style);
  const bubbled = look.style === "bubbles";
  const compact = look.style === "compact";
  const { scheme } = useTheme();
  // Over a background: someone else's bubble lifted off it, every bubble with the cards' light edge (`liftedEdge`).
  const lifted = look.wallpaper === true;
  const lift = WALLPAPER_LIFT[scheme === "dark" ? "dark" : "light"];
  const bubbleEdge = lifted ? liftedEdge(scheme) : null;
  const roles = useRowRoles();
  const member = m.author.type === "person" && m.author.id ? dir.memberById.get(m.author.id) : undefined;
  const roleColor = member ? memberRoleColor(member, roles ?? []) : undefined;
  const nameColor = !bubbled
    ? undefined
    : isAgent
      ? nameInk(color, scheme === "dark")
      : roleColor
        ? nameInk(roleColor as AgentColorName, scheme === "dark")
        : undefined;
  const solidInk = bubbled && look.tone === "strong" ? ON_SOLID : undefined;
  const quote = replyOf(meta);
  // About part of a live file (ADR 0199): its line over the message, a tap shows that part in the file.
  const liveRef = messageLiveRef(m);
  // A comment with a pin on a picture, a video or a PDF, resolved (ADR 0208): who did it, under it.
  const resolved = liveRef && !m.local && isPinnedSelection(liveRef.selection) ? resolvedOf(meta) : null;
  const myHandle = useRowMyHandle();
  const mentionsMe = !mine && mentionsReader({ body, meta }, myHandle);

  // The cards it carries: above an agent's tools, which come last.
  const cards = (
    <>
      {issueWork ? (
        <IssueWorkCard work={issueWork} authorId={m.author.type === "person" ? (m.author.id ?? null) : null} />
      ) : null}
      {meta?.missionStart ? <MissionCard threadId={m.id} /> : null}
      {link ? <MissionCard missionId={link.missionId} /> : null}
      {suggestion ? <CodeSuggestionCard message={m} suggestion={suggestion} /> : null}
      {plan ? <PlanCard missionId={plan.missionId} goal={plan.goal} /> : null}
      {review ? <ReviewCard missionId={review.missionId} reviewId={review.id} /> : null}
      {setup ? (
        <SetupFailedCard
          {...(setup.missionId ? { missionId: setup.missionId } : {})}
          threadId={m.threadId}
          error={setup.error}
          {...(setup.reason === "branch_missing" ? { lostBranch: setup.branch ?? null } : {})}
        />
      ) : null}
    </>
  );
  const missionDecision = decision ? <DecisionCard missionId={decision.missionId} decisionId={decision.id} /> : null;
  // Under everything: who resolved it (a comment on a file), the thread it started, its reactions and whether it went
  // out.
  const foot = (
    <>
      {resolved ? <ResolvedLine resolved={resolved} end={onRight} /> : null}
      {thread && !meta?.missionStart ? (
        <View style={onRight ? styles.meEnd : undefined}>
          <ThreadLink thread={thread} />
        </View>
      ) : replying ? (
        <View style={onRight ? styles.meEnd : undefined}>
          <ThreadReplyingLink channelId={m.channelId} threadId={m.id} agentIds={replying.split(",")} />
        </View>
      ) : null}
      {readOnly ? null : (
        <Reactions message={m} reactions={reactions} meId={meId} end={onRight} onToggle={toggle.mutate} />
      )}
      {m.local === "pending" && meta?.voiceAccepted === true ? null : m.local === "pending" ||
        (m.local === "failed" && offline) ? (
        <Sending offline={offline} end={onRight} />
      ) : m.local === "failed" ? (
        // A 16-point caption: 14 of slop gives the retry its 44-point target.
        <Pressable
          onPress={() => onRetry?.(m)}
          accessibilityRole="button"
          hitSlop={14}
          style={({ pressed }) => pressed && styles.pressedDim}
        >
          <Text variant="caption" tone="danger" style={onRight ? styles.meStatus : undefined}>
            {sendFailureText(t, m.sendFailure, i18n.language)}
          </Text>
          <Text variant="caption" tone="ink" style={[styles.retry, onRight ? styles.meStatus : undefined]}>
            {t(sendNeedsEdit(m.sendFailure) ? "channel.editSend" : "channel.retrySend")}
          </Text>
          {/* Why, as it came: a voice note that never left says what stopped it instead of waiting in silence. */}
          {typeof meta?.sendError === "string" ? (
            <Text variant="caption" tone="faint" numberOfLines={2} style={onRight ? styles.meStatus : undefined}>
              {meta.sendError}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
    </>
  );
  // Someone else's bubble gives way to the times only when it is too wide for them (`useGiveWay`): its bubbles end
  // sooner than mine at the screen's edge, so that much room is there before it moves.
  const giveWay = useGiveWay(ROW_BODY_INSET.bubbles.right - BUBBLES_EDGE);
  // Someone else's bubble never taller than what it holds (`useBubbleCap`).
  const bubbleCap = useBubbleCap();
  // A compact row runs to the screen's edge: its face and words slide over with the pull, for its time.
  const slide = useSwipeSlide(compact);

  if (onRight) {
    // In bubbles the time and what became of the message are never in it (a mark coming in or swapping changed the
    // bubble's width): a pull to the left shows them (`SwipeTime`). A send in flight has its place too.
    const swipeTime =
      bubbled && m.local !== "failed" ? (
        <SwipeTime>
          {surfaceTag ? <SurfaceMark tag={surfaceTag} color={c.muted} /> : null}
          <Text variant="caption" tone="muted">
            {when.time(m.createdAt)}
          </Text>
          <ReceiptMark message={m} mine receipt={receipt} seenBy={seenBy} />
        </SwipeTime>
      ) : null;
    const player = voiceOf(meta) ? (
      <View style={styles.meFiles}>
        <VoiceMessage message={m} />
      </View>
    ) : null;
    // A choice's answer, the bubble (a voice message's typed words, its player under them), or a voice message's
    // player, the GIF or sticker or the files of a message with no words, leads.
    const lead = choiceReply ? (
      <View style={styles.meFiles}>{choiceReply}</View>
    ) : body ? (
      <View
        style={[
          bubbled ? lookRows.bubble : styles.bubble,
          styles.bubbleEnd,
          BUBBLE_RUN[run],
          { backgroundColor: (bubbled && look.fill) || c.bubble },
          bubbleEdge,
        ]}
      >
        {quote ? <QuotePlate reply={quote} onJump={onQuote} {...(solidInk ? { ink: solidInk } : {})} /> : null}
        <ClippedMessage id={m.id} behind={[(bubbled && look.fill) || c.bubble]} ink={solidInk}>
          <MessageText
            body={body}
            selectable={false}
            accent={accent}
            channelRefs={channelRefsOf(m.meta)}
            everyone={m.meta?.mentionsEveryone === true}
            {...(solidInk ? { ink: solidInk } : {})}
          />
        </ClippedMessage>
      </View>
    ) : player ? (
      player
    ) : media ? (
      <View style={styles.meFiles}>
        <ChatMedia media={media} align="end" liveId={m.id} />
      </View>
    ) : files.length > 0 ? (
      <View style={styles.meFiles}>
        <MessageFiles files={files} align="end" />
      </View>
    ) : localFiles.length > 0 ? (
      <View style={styles.meFiles}>
        <LocalFiles files={localFiles} align="end" sending={m.local === "pending"} />
      </View>
    ) : null;
    return shaking(
      <Pressable
        onPress={onTap}
        onLongPress={press}
        delayLongPress={380}
        accessibilityHint={press ? t("mobile.chat.longPressHint") : undefined}
        style={({ pressed }) => [
          styles.me,
          rowFrame(rhythm.block, rowGap),
          bubbled && styles.ownBox,
          pressed && press && styles.mePressed,
        ]}
      >
        <SwipeSlide on={bubbled} style={styles.meSlide}>
          <RowPartContext.Provider value={cardTop}>
            <View style={[styles.meParts, { gap: rhythm.part }]}>
              {m.pinned ? (
                <View style={[styles.pinLine, styles.meEnd, { marginBottom: PIN_GAP - rhythm.part }]}>
                  <PinMark />
                  <Text variant="caption" tone="faint">
                    {t("mobile.pins.mark")}
                  </Text>
                </View>
              ) : null}
              {liveRef ? <MessageAbout liveRef={liveRef} messageId={m.id} end /> : null}
              {/* With no words there is no bubble to hold it. */}
              {quote && (!body || choiceReply) ? (
                <View style={styles.meEnd}>
                  <QuotePlate reply={quote} onJump={onQuote} />
                </View>
              ) : null}
              {lead}
              {body ? player : null}
              {body && media ? (
                <View style={styles.meFiles}>
                  <ChatMedia media={media} align="end" liveId={m.id} />
                </View>
              ) : null}
              {(body || media) && files.length > 0 ? (
                <View style={styles.meFiles}>
                  <MessageFiles files={files} align="end" />
                </View>
              ) : null}
              {(body || media) && localFiles.length > 0 ? (
                <View style={styles.meFiles}>
                  <LocalFiles files={localFiles} align="end" sending={m.local === "pending"} />
                </View>
              ) : null}
              {cards}
              {missionDecision}
              {foot}
            </View>
          </RowPartContext.Provider>
          {/* One time per run of my rows (they group a few minutes apart), under its last, the receipt's mark ending
            its line; a send in flight has it too (its own clock), so nothing moves when the server's copy lands. In
            bubbles a pull to the left shows it instead. */}
          {m.local !== "failed" && (run === "end" || run === "solo") && !bubbled ? (
            <View style={[styles.meTime, { marginTop: rhythm.part / 2 }]}>
              {surfaceTag ? <SurfaceMark tag={surfaceTag} color={c.faint} /> : null}
              <Text variant="caption" tone="faint">
                {when.time(m.createdAt)}
              </Text>
              <ReceiptMark message={m} mine receipt={receipt} seenBy={seenBy} />
            </View>
          ) : null}
        </SwipeSlide>
        {swipeTime}
        {popNode}
      </Pressable>,
    );
  }

  // Under a name, or in a bubble with it: the same line, its time last. In `bubbles` it goes in the bubble's end when
  // there is one; in a DM's bubble the line is only what a tag has to say. A row with no bubble (a card alone) keeps
  // the name ahead of its time, as anywhere else: a time alone beside a face reads as a broken line.
  const who = (inBubble: boolean) => (
    <View
      style={[
        styles.who,
        m.author.type === "person" && !inBubble && !compact && styles.whoRoom,
        (inBubble || compact || !words) && styles.whoTight,
      ]}
    >
      {!inBubble || look.names || helping ? (
        <Text
          variant="footnote"
          tone="ink2"
          style={[styles.name, nameSize, nameColor ? { color: nameColor } : undefined]}
          numberOfLines={1}
          maxFontSizeMultiplier={nameSize ? CHAT_TEXT_MAX_SCALE : undefined}
        >
          {name}
        </Text>
      ) : null}
      {reminder ? <Tag icon="bell" label={t("channel.reminder")} /> : null}
      {via ? (
        <Tag
          icon="sparkle"
          lead={viaMark ? <ProviderLogo id={viaMark} size="xs" /> : undefined}
          label={t("apps.via", { name: via.name })}
          hint={t("apps.viaTip", { person: name, name: via.name })}
        />
      ) : null}
      {surfaceTag ? (
        <Tag
          icon="chat"
          lead={<MarkIcon uri={iconUri(serverUrl(), surfaceTag.mark)} fallback="chat" size={12} color={c.muted} />}
          label={surfaceTag.label}
          hint={surfaceTag.hint}
          wrap
        />
      ) : null}
      {routine ? (
        // The tag opens the routine (Rotinas, as on the web); "Ver relatório" beside it unfolds the report.
        <Tag
          icon="clock"
          label={t("channel.routineTag", { name: routine.name })}
          onPress={() => router.push(routineHref(routine.id))}
          hint={t("channel.routineTagTip")}
        />
      ) : null}
      {routine && report ? (
        <Pressable
          onPress={() => {
            keepOpen(`report:${m.id}`, !reportOpen);
            setReportOpen(!reportOpen);
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: reportOpen }}
          hitSlop={NAME_LINE_SLOP}
          style={({ pressed }) => [styles.shrink, pressed && styles.pressedDim]}
        >
          <Text variant="label" tone="muted" numberOfLines={1}>
            {reportOpen ? t("channel.routineReportHide") : t("channel.routineReport")}
          </Text>
        </Pressable>
      ) : null}
      {talker ? (
        <Text
          variant="footnote"
          tone="faint"
          numberOfLines={1}
          style={styles.shrink}
          accessibilityHint={t(talkerWaited(meta) ? "chat.notice.talkerWaitingTip" : "chat.notice.talkerTip")}
        >
          {t(talkerWaited(meta) ? "chat.notice.talkerWaiting" : "chat.notice.talker")}
        </Text>
      ) : null}
      {helping ? <HelpingTag consultation={helping} channelId={m.channelId} /> : null}
      {/* The agent's role tells agents apart where several speak; in a DM (`look.names` off) the bar under its name
          already says it, and it isn't said again on every turn. */}
      {!reminder && !routine && !talker && !helping && agent?.role && look.names && !bubbled && !compact ? (
        <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.shrink}>
          {agent.role}
        </Text>
      ) : null}
      {inBubble || compact ? null : (
        <Text
          variant="footnote"
          tone="faint"
          style={timeSize}
          maxFontSizeMultiplier={timeSize ? CHAT_TEXT_MAX_SCALE : undefined}
        >
          {when.time(m.createdAt)}
        </Text>
      )}
      {brainWait ? <AwayPill message={m} /> : null}
      {m.pinned ? <PinMark /> : null}
      {(receipt || seenBy) && !m.local && !inBubble ? (
        <View style={compact ? undefined : [styles.whoMark, nameSize ? { height: nameSize.lineHeight } : null]}>
          <ReceiptMark message={m} mine={mine} receipt={receipt} seenBy={seenBy} />
        </View>
      ) : null}
    </View>
  );
  const pinLine =
    grouped && m.pinned ? (
      <View style={[styles.pinLine, { marginBottom: PIN_GAP }]}>
        <PinMark />
        <Text variant="caption" tone="faint">
          {t("mobile.pins.mark")}
        </Text>
      </View>
    ) : null;
  // Someone else's bubble: the gray, lifted off a background; a mention of me tints it amber.
  const otherFill = lifted ? lift : c.bubble;
  const mentionFill = lifted ? mixHex(lift, c.amber, AMBER_TINT) : `${c.amber}21`;
  const otherBubble = mentionsMe ? mentionFill : otherFill;
  // What is painted behind someone else's words, bottom first: the screen, then the bubble or a mention's tint.
  const tinted = mentionsMe ? [c.bg, `${c.amber}${bubbled ? "21" : "17"}`] : null;
  const plainBehind = tinted ?? [bubbled ? c.bubble : c.bg];
  // A lifted bubble is solid: its own color is all there is behind its words.
  const behindWords = bubbled && lifted ? [otherBubble] : plainBehind;
  const messageWords = body ? (
    <MessageText
      body={body}
      selectable={false}
      accent={accent}
      channelRefs={channelRefsOf(m.meta)}
      everyone={m.meta?.mentionsEveryone === true}
    />
  ) : null;
  const saying = (text: string) => (
    <MessageText
      body={text}
      muted={workOver}
      selectable={false}
      accent={accent}
      channelRefs={channelRefsOf(m.meta)}
      everyone={m.meta?.mentionsEveryone === true}
    />
  );
  const words = deviceWait ? (
    <DeviceWait message={m} fallback={messageWords} />
  ) : brainWait ? (
    <BrainWait message={m} fallback={messageWords} />
  ) : choiceReply ? (
    choiceReply
  ) : body ? (
    <ClippedMessage
      id={m.id}
      behind={behindWords}
      lead={talk ? saying(talk.lead) : undefined}
      // In a bubble, where its words end keeps the bubble no taller than them (`useBubbleCap`).
      onEnd={bubbled ? bubbleCap.onEnd : undefined}
    >
      {saying(body)}
    </ClippedMessage>
  ) : null;
  // The bubble holds its words, the tags of its name line and, at its end, the time; a row with none keeps its line.
  const inBubble = bubbled && Boolean(body) && !brainWait && !deviceWait && !choiceReply;
  const tagged = Boolean(reminder || via || surfaceTag || routine || talker || helping || m.pinned);
  const opener = opened?.said ? <MessageText body={opened.said} selectable={false} accent={accent} /> : null;
  // Outside a bubble the line it opened with is a part of its own, as the web's second text.
  const openerPart = opener && words ? <View style={{ marginBottom: rhythm.part }}>{opener}</View> : opener;
  const reportOpened =
    report && reportOpen ? (
      <View
        style={[
          styles.report,
          // On a plate a step off what is around it, never a bar at its left edge.
          { backgroundColor: c.plate },
          (inBubble || opener || words) && { marginBottom: rhythm.part },
        ]}
      >
        <MessageText body={report} />
      </View>
    ) : null;

  const quoteAbove = Boolean(quote && !inBubble);
  // A DM's bubbles name nobody (`look.names` off): a card that comes alone (a question, the browser) carries no name
  // line either, unless a tag has something to say.
  const nameLine = !grouped && !(bubbled && !look.names && !tagged);
  // In bubbles, a message that is only a request (an approval, a question, a secret) is a bubble of its own: its name
  // line goes inside the card, at its top, and its time at the card's end (`BubbleHeadContext`), not on a line of the
  // other looks above it.
  const askAlone =
    bubbled &&
    nameLine &&
    !body &&
    !media &&
    !words &&
    !voiceOf(meta) &&
    [approvalId, question, secret].filter(Boolean).length === 1;
  const bubbleHead = askAlone ? { who: who(true), time: when.time(m.createdAt) } : null;
  const nameOrWords = Boolean(inBubble || (nameLine && !askAlone) || pinLine || reportOpened || opener || words);
  // In bubbles, the cards under these words are bubbles of the same message: its fill, 3 points under it, joined
  // (`BubblePartContext`, `BUBBLE_JOIN`).
  const bubblePart = bubbled ? { fill: otherFill, edge: bubbleEdge } : null;
  const partTop = bubbled && (body || media) ? BUBBLE_JOIN - rhythm.part : cardTop;
  return (
    <>
      {quoteAlone && m.author.id ? (
        <View style={[plateInset(look, aboveInset(look)), { marginTop: rhythm.turn }]}>
          <ConsultQuote askerId={m.author.id} channelId={m.channelId} items={paired} alone />
        </View>
      ) : null}
      {liveRef ? (
        <View style={[styles.aboutAbove, { paddingLeft: aboveInset(look), marginTop: rowGap }]}>
          <MessageAbout liveRef={liveRef} messageId={m.id} />
        </View>
      ) : null}
      {quote && !inBubble ? <QuoteAbove look={look} reply={quote} onJump={onQuote} gap={liveRef ? 0 : rowGap} /> : null}
      <Pressable
        onPress={onTap}
        onLongPress={press}
        delayLongPress={380}
        accessibilityHint={press ? t("mobile.chat.longPressHint") : undefined}
        style={({ pressed }) => [
          styles.msg,
          bubbled && lookRows.bubblesRow,
          bubbled && !look.faces && lookRows.bubblesBare,
          // A bubble row paints nothing past its own box: the list puts the next row right under it, and a bubble
          // drawn taller than its row (its frame lagging its layout) covered the messages after it.
          bubbled && styles.ownBox,
          compact && lookRows.compactRow,
          rowFrame(rhythm.block, rowGap),
          // On the quote it answers (or the line about a file's part), its plate never over it.
          quoteAbove && styles.replied,
          liveRef !== null && styles.replied,
          // A mention of me: the row's tint says it, with round corners; no accent bar on its left edge. In bubbles the
          // bubble says it.
          mentionsMe && !inBubble && { backgroundColor: `${c.amber}17`, borderRadius: 14 },
          pressed && press && { backgroundColor: c.sunken },
        ]}
      >
        {look.faces ? (
          <Animated.View
            style={[
              styles.avslot,
              bubbled && lookRows.bubblesSlot,
              compact && lookRows.compactSlot,
              inBubble && giveWay.style,
              compact && slide,
            ]}
          >
            {grouped ? (
              // A grouped row's receipt in its face's place, on its first line: a tap opens who it went to.
              (receipt || seenBy) && !m.local && !inBubble ? (
                <View style={[styles.slotMark, { height: look.text?.lineHeight ?? 24 }]}>
                  <ReceiptMark message={m} mine={mine} receipt={receipt} seenBy={seenBy} />
                </View>
              ) : null
            ) : (
              <Face who={m.author} size={compact ? 18 : bubbled ? 30 : 34} live={false} />
            )}
          </Animated.View>
        ) : null}
        {/* Its face and its body give way together (`useGiveWay`), so the bubble never runs under the face. */}
        <Animated.View style={[styles.body, { gap: rhythm.part }, inBubble && giveWay.style, compact && slide]}>
          <RowParts top={partTop} part={bubblePart} head={bubbleHead}>
            {nameOrWords ? (
              <View onLayout={inBubble ? giveWay.onArea : undefined}>
                {inBubble ? (
                  <>
                    {pinLine}
                    {reportOpened}
                    <View
                      onLayout={(e) => {
                        giveWay.onBubble(e);
                        bubbleCap.onBubble(e);
                      }}
                      style={[
                        lookRows.bubble,
                        OTHER_RUN[run],
                        { backgroundColor: otherBubble },
                        bubbleEdge,
                        bubbleCap.capStyle,
                      ]}
                    >
                      {!grouped && (look.names || tagged) ? who(true) : null}
                      {quoteInWords}
                      {quote ? <QuotePlate reply={quote} onJump={onQuote} /> : null}
                      {opener}
                      {words}
                    </View>
                  </>
                ) : compact && !grouped ? (
                  <>
                    <View style={styles.compactLine}>
                      {who(false)}
                      {!reportOpened && !opener && !quoteInWords ? words : null}
                    </View>
                    {quoteInWords}
                    {reportOpened}
                    {openerPart}
                    {reportOpened || opener || quoteInWords ? words : null}
                  </>
                ) : (
                  <>
                    {nameLine && !askAlone ? who(false) : null}
                    {quoteInWords}
                    {pinLine}
                    {reportOpened}
                    {openerPart}
                    {words}
                  </>
                )}
              </View>
            ) : null}
            {media ? <ChatMedia media={media} liveId={m.id} /> : null}
            {voiceOf(meta) ? <VoiceMessage message={m} /> : null}
            {isAgent && meta?.speedFallback === true ? <SpeedFallbackLine message={m} /> : null}
            {isAgent && standIn ? <ModelStandInLine message={m} text={standIn} /> : null}
            {(stopped || atLimit || providerCut) && m.agentRunId ? (
              <StoppedLine
                message={m}
                runId={m.agentRunId}
                stopped={
                  stopped ?? {
                    byUserId: null,
                    byAgentId: null,
                    code: null,
                    continuedRunId: atLimit?.continuedRunId ?? providerCut?.continuedRunId ?? null,
                  }
                }
                limit={providerCut ? "failed" : atLimit ? (atLimit.stuck ? "stuck" : "steps") : undefined}
              />
            ) : null}
            {isAgent && m.actions?.length ? <Receipts message={m} onTap={onTap} onLongPress={press} /> : null}
            {isAgent ? <HandedTaskChips message={m} /> : null}
            {isAgent ? <TeamChecks message={m} /> : null}
            {isAgent ? <ReachLines message={m} /> : null}
            {isAgent && feedbackOfferOf(meta) ? <FeedbackOfferRow message={m} /> : null}
            {isAgent && m.longWork ? <MessageWorkLine message={m} threaded={Boolean(thread)} /> : null}
            {isAgent && !m.local ? <HandedWorkLines message={m} /> : null}
            {files.length > 0 ? <MessageFiles files={files} /> : null}
            {localFiles.length > 0 ? <LocalFiles files={localFiles} sending={m.local === "pending"} /> : null}
            {trails && m.author.id && trails.browser.length > 0 ? (
              <TrailCard
                agentId={m.author.id}
                runId={m.agentRunId ?? null}
                steps={trails.browser}
                stopped={stopped}
                recent={trails.recent}
              />
            ) : null}
            {trails && m.author.id && trails.desktop.length > 0 ? (
              <TrailCard
                agentId={m.author.id}
                runId={m.agentRunId ?? null}
                steps={trails.desktop}
                stopped={stopped}
                screen="desktop"
              />
            ) : null}
            {cards}
            {/* Its tools after its words, what it changed and its cards: the same place live, kept and saved. Left
            open, they come back open (`keptOpen`). */}
            {kept ? (
              <TurnTools
                items={opened?.lines ?? kept.items}
                agentName={agent?.name ?? name}
                color={color}
                done
                settled
                keep={`tools:${m.id}`}
              />
            ) : steps && m.agentRunId && !meta?.workUpdate ? (
              <SavedTools
                runId={m.agentRunId}
                messageId={m.id}
                meta={meta}
                agentName={agent?.name ?? name}
                color={color}
                skipScreens={onCards}
                keep={`tools:${m.id}`}
              />
            ) : null}
            {/* What waits for a person's click comes last, after the words and the tools. Each card with work of its
            own before it knows it has nothing to show (queries, the directory, a clock) is drawn only on a
            message that carries it: under every agent's message, a scroll paid for all of them on each row. */}
            {isAgent && noAiCardOf(meta) ? <NoAiCard message={m} /> : null}
            {isAgent && stretchCardOf(meta) ? <StretchCard message={m} /> : null}
            {isAgent && costlyProposalOf(meta) ? <CostlyProposalCard message={m} /> : null}
            {isAgent && usagePauseCardOf(meta) ? <UsagePauseCard message={m} /> : null}
            {isAgent && usageWaitOf(meta) ? <UsageWaitCancel message={m} /> : null}
            {isAgent && messageToolOff(meta) ? <WaitToolOffAction message={m} /> : null}
            {isAgent ? <ProposalCard message={m} /> : null}
            {isAgent ? <TeamCard message={m} /> : null}
            {isAgent && replyChipsOf(meta) ? <ReplyChips message={m} /> : null}
            {isAgent ? <OfferCard message={m} /> : null}
            {isAgent && filesTextOnlyOf(meta) ? <FilesTextOnlyFix message={m} /> : null}
            {isAgent ? <InstructionProposals message={m} /> : null}
            {isAgent && settingsCard ? <SettingsProposals message={m} /> : null}
            {isAgent ? <TeamWeek message={m} /> : null}
            {approvalId ? <ApprovalInline approvalId={approvalId} messageId={m.id} /> : null}
            {handoff ? <HandoffCard handoff={handoff} /> : null}
            {question ? (
              <QuestionCard
                key={`${question.id}:${question.status}`}
                question={question}
                asker={helping ? (agent?.name ?? name) : undefined}
              />
            ) : null}
            {secret ? <SecretCard key={`${secret.id}:${secret.status}`} request={secret} /> : null}
            {missionDecision}
            {foot}
          </RowParts>
          {hintNode}
        </Animated.View>
        {/* A bubble holds no time (its words alone set its width), nor does a compact row: a pull to the left shows it,
            in the row's gutter (a compact row's mark stays on its first line). */}
        {inBubble || compact ? (
          <SwipeTime>
            <Text variant="caption" tone="muted">
              {when.time(m.createdAt)}
            </Text>
            {inBubble && (receipt || seenBy) ? (
              <ReceiptMark message={m} mine={mine} receipt={receipt} seenBy={seenBy} />
            ) : null}
          </SwipeTime>
        ) : null}
        {popNode}
      </Pressable>
    </>
  );
}

/** Reactions are stored by name: the thumbs up is `+1` (feedback to the agent). */
const THUMBS = "+1";
/** The emoji that pops where the finger was: its box, and how long it stays. */
const POP = 24;
const POP_MS = 420;

let taught: boolean | null = null;
const isTaught = () => {
  if (taught === null) taught = readValueSync(STORED.doubleTapTaught) === "1";
  return taught;
};
function teachDoubleTap() {
  if (taught === true) return;
  taught = true;
  writeValueSync(STORED.doubleTapTaught, "1");
}
/** The one row that carries the hint this time (the first agent's row to ask for it). */
let hintOwner: string | null = null;
/** How long the hint has to be on screen to count as seen. */
const HINT_SEEN_MS = 6000;

/**
 * Whether this row shows "Toque duplo = 👍": one row per app run, never again once it has been on screen for a
 * while or the person double tapped anywhere.
 */
function useDoubleTapHint(id: string | null): boolean {
  const [shown] = useState(() => {
    if (!id || isTaught()) return false;
    if (hintOwner === null) hintOwner = id;
    return hintOwner === id;
  });
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(teachDoubleTap, HINT_SEEN_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return shown;
}

/** Past this long with no answer from the server (ms), a send says "Sending" under it. */
const SLOW_SEND_MS = 2000;

/**
 * My message on its way reads as sent the moment it is (its words in ink, its time): "Sending" only when the server is
 * really slow to take it (`SLOW_SEND_MS`); offline, a clock and when it will go.
 */
function Sending({ offline, end }: { offline: boolean; end: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_SEND_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!offline && !slow) return null;
  return (
    <View style={[styles.status, end && styles.statusEnd]}>
      {offline ? <Icon name="clock" size={12} color={c.faint} /> : <InkOrbit size={10} color={c.faint} />}
      <Text variant="caption" tone="faint">
        {offline ? t("mobile.chat.offlineWait") : t("mobile.chat.sending")}
      </Text>
    </View>
  );
}

/**
 * A reply someone stopped: what it wrote stays, with one pill under it, "You stopped Ada · 14:16 | Continue | Add a
 * reason" ("At the step limit | Continue" under the reply of a run that reached its step limit). The run's stop
 * notice, when the conversation has it, gives the pill its words (who, the reason, "Add a reason") and draws nothing
 * itself (`stoppedRunsOf`). Continue picks up from where it stopped (a new run) and goes away once it did, for
 * everyone.
 */
function StoppedLine({
  message: m,
  runId,
  stopped,
  limit,
}: {
  message: Message;
  runId: string;
  stopped: ReplyStop & { continuedRunId: string | null };
  /**
   * It ended at its step limit, or because it got stuck, or its long work failed on its AI provider (the end's text
   * already says so, so only Continue shows): nobody stopped it.
   */
  limit?: "steps" | "stuck" | "failed";
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const meId = useRowMeId();
  const dir = useRowDirectory();
  const [busy, setBusy] = useState(false);
  // The stop's notice, when it is in this conversation: who stopped it, the reason, its time.
  const stop = useStoppedRun(limit ? null : runId);
  // Continued here or on another device (`run.continued`), or already in the message's meta.
  const continued = useContinuedRun(m.id) ?? stopped.continuedRunId;
  const by = limit ? null : stop?.notice.byUserId || stopped.byUserId;
  const byMe = Boolean(meId) && by === meId;
  // The pill names whoever it can (`stopLine`); these are its words when it can't: the step limit, stuck, the plain
  // stop, or its cause when no person stopped it (an archived agent, a closed workspace).
  const fallback = limit
    ? limit === "failed"
      ? null
      : t(limit === "stuck" ? "mobile.chat.stopped.stuck" : "mobile.chat.stopped.limit")
    : by
      ? t("mobile.chat.stopped.plain")
      : (runErrorText(t, stopped.code) ?? t("mobile.chat.stopped.plain"));
  const author = m.author.id ? dir.agentById.get(m.author.id) : undefined;
  const owner = author?.ownerUserId ?? null;
  // Holding the role that answers for it counts as its owner (ADR 0085, addendum of 2026-11-21).
  const owns = ownsIn(dir.memberById, meId, author);
  const loaded = [
    ...(qc.getQueryData<Message[]>(keys.messages(orgId, m.channelId)) ?? []),
    ...((m.threadId && qc.getQueryData<Message[]>(keys.thread(orgId, m.channelId, m.threadId))) || []),
  ];
  // Same people who may stop it (the server checks again): who manages the agent, its owner, or who asked.
  const may =
    byMe ||
    mayStopRun(
      { agentId: m.author.id ?? "", threadId: m.threadId ?? m.id, triggerMessageId: null },
      { meId, manageAgents: managesAgent(author), agentOwnerId: owner, owns, messages: loaded },
    );
  // The agent works here again, or wrote after the stop: it went on, the stop offers nothing.
  const movedOn = useStopMovedOn(runId);
  // Only a stop a person made (also through the right hand) or a run at its limit picks up again: never the system's.
  const open = Boolean(limit || by) && may && !continued && !busy && !movedOn;
  const onContinue = () => {
    setBusy(true);
    api.agents
      .continueRun(orgId, runId)
      .then(({ runId: newRunId }) => cacheContinued(qc, orgId, m.channelId, m.id, newRunId))
      .catch((err: unknown) => {
        setBusy(false);
        // Refused for a reason it can say (already continued, the agent busy here, not allowed): say it.
        // The event or a refetch hides the button when it has no job left.
        const code = errorCode(err);
        toast({
          title: code && CONTINUE_ERRORS.has(code) ? errorText(t, err) : t("mobile.chat.stopped.failed"),
          icon: "x",
        });
      });
  };
  if (fallback === null) {
    // Its text already says why (its long work's provider failed): Continue alone, nothing to say. The kit's small
    // button, which keeps its place with a spinner while it asks (it used to vanish on the tap and come back on a
    // refusal) and goes once the work picked up.
    if (continued || !(open || busy)) return null;
    return (
      <View style={styles.stopped}>
        <Button
          variant="secondary"
          size="sm"
          label={t("mobile.chat.stopped.continue")}
          loading={busy}
          onPress={onContinue}
        />
      </View>
    );
  }
  const agentName = dir.nameOf(m.author) || t("channel.unknownAgent");
  return (
    <View style={styles.stopped}>
      <StopPill
        agent={agentName}
        notice={stop?.notice}
        at={stop?.message.createdAt}
        byUserId={by}
        byAgentId={limit ? null : stopped.byAgentId}
        fallback={fallback}
        cont={
          !continued && (open || busy) ? (
            <EventPillAction
              key="continue"
              lead="play"
              label={t("mobile.chat.stopped.continue")}
              loading={busy}
              onPress={onContinue}
            />
          ) : null
        }
      />
    </View>
  );
}

/** The person's pick sent from a choice card (ADR 0124): a check and what they picked. */
function ChoiceReply({ text }: { text: string }) {
  const c = useColors();
  return (
    <View style={styles.choiceReply}>
      <LineIcon name="check" size={13} color={c.muted} variant="footnote" />
      <Text variant="footnote" tone="ink" style={[styles.medium, styles.shrink]}>
        {text}
      </Text>
    </View>
  );
}

/**
 * A small neutral chip next to the name ("Lembrete", "Rotina «Bom dia»"): icon, no colored dot. With
 * `onPress` it opens what it stands for (the routine a message answers).
 */
function Tag({
  icon,
  lead,
  label,
  onPress,
  hint,
  wrap,
}: {
  icon: "bell" | "chat" | "clock" | "sparkle";
  /** In place of the icon (an app's mark). */
  lead?: ReactNode;
  label: string;
  onPress?: () => void;
  hint?: string;
  /** The whole label on as many lines as it needs, for a name nobody here chose (an operator's surface). */
  wrap?: boolean;
}) {
  const c = useColors();
  const chip = (
    <View style={[styles.tag, { backgroundColor: c.sunken }]} accessibilityHint={onPress ? undefined : hint}>
      {lead ?? <Icon name={icon} size={12} color={c.muted} />}
      <Text variant="caption" tone="muted" numberOfLines={wrap ? 0 : 1} style={styles.shrink}>
        {label}
      </Text>
    </View>
  );
  if (!onPress) return chip;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={hint}
      hitSlop={NAME_LINE_SLOP}
      style={({ pressed }) => [styles.tagPress, pressed && styles.pressedDim]}
    >
      {chip}
    </Pressable>
  );
}

/** Beside the time of my own message written on the outside chat surface: its logo, the words read aloud. */
function SurfaceMark({ tag, color }: { tag: { label: string; hint: string; mark: string | null }; color: string }) {
  return (
    <View accessible accessibilityLabel={tag.label} accessibilityHint={tag.hint}>
      <MarkIcon uri={iconUri(serverUrl(), tag.mark)} fallback="chat" size={12} color={color} />
    </View>
  );
}

/** On a card this agent posted while answering another agent's question: "ajudando o Theo · Ver conversa". */
function HelpingTag({ consultation: c, channelId }: { consultation: RunConsultation; channelId: string }) {
  const { t } = useTranslation();
  const dir = useRowDirectory();
  const from = agentGrammar(dir.agentById.get(c.agentId)?.name ?? t("mobile.chat.someone"));
  return (
    <>
      <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.shrink}>
        {withAgentFaces(t("chat.consultPanel.helping", { name: from.name, context: from.context }), [
          { name: from.name, agentId: c.agentId },
        ])}
      </Text>
      <Pressable
        onPress={() => router.push(consultationHref(c.id, channelId))}
        accessibilityRole="button"
        hitSlop={NAME_LINE_SLOP}
        style={({ pressed }) => [styles.shrink, pressed && styles.pressedDim]}
      >
        <Text variant="label" tone="muted" numberOfLines={1}>
          {t("chat.consultPanel.see")}
        </Text>
      </Pressable>
    </>
  );
}

/** Pinned: a small neutral pin (no colored dot). */
function PinMark() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.pin} accessible accessibilityLabel={t("mobile.pins.mark")}>
      <Icon name="pin" size={12} color={c.faint} />
    </View>
  );
}

/**
 * People's pills show a count (mine outlined); an agent that reacted shows its face. Handed the row's reactions and
 * its toggle: the row reads them once.
 */
function Reactions({
  message: m,
  reactions,
  meId,
  end,
  onToggle,
}: {
  message: Message;
  reactions: Message["reactions"];
  meId: string | null;
  end: boolean;
  onToggle: (input: { reaction: string; on: boolean }) => void;
}) {
  const { t } = useTranslation();
  const { colors: c, reducedMotion: reduced } = useTheme();
  const pills = reactionPills(reactions, meId);
  const shown = pills.length > 0 && !m.local;
  // A pill someone adds or takes back while the row shows fades and the others slide aside; those there when the row
  // mounts (scrolling to it) just show, and none lingers when the row goes.
  const motion = reduced ? {} : { entering: PILL_IN, exiting: PILL_OUT, layout: PILL_MOVE };
  return (
    <LayoutAnimationConfig skipEntering skipExiting>
      {shown ? (
        <View style={[styles.reacts, end && styles.meEnd]}>
          {pills.flatMap((p) => [
            ...(p.people > 0
              ? [
                  <Animated.View key={`p:${p.reaction}`} {...motion}>
                    {/* The press's own light tap is the toggle's haptic. */}
                    <PressScale
                      onPress={() => onToggle({ reaction: p.reaction, on: !p.mine })}
                      fill={false}
                      // 30 drawn, 44 to the finger; not sideways, where the next pill is 6 away.
                      hitSlop={REACT_SLOP}
                      accessibilityRole="button"
                      accessibilityLabel={t("mobile.chat.reactionLabel", { emoji: p.emoji, count: p.people })}
                      accessibilityState={{ selected: p.mine }}
                      contentStyle={[styles.react, { backgroundColor: c.sunken }, p.mine && { borderColor: c.ink2 }]}
                    >
                      <Text variant="subhead" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                        {p.emoji}
                      </Text>
                      <Count value={p.people} size={14} />
                    </PressScale>
                  </Animated.View>,
                ]
              : []),
            ...p.agentIds.map((agentId) => (
              <Animated.View
                key={`a:${p.reaction}:${agentId}`}
                {...motion}
                accessible
                accessibilityLabel={t("mobile.chat.agentReacted", { emoji: p.emoji })}
                style={[styles.react, { backgroundColor: c.sunken }]}
              >
                <Text variant="subhead" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                  {p.emoji}
                </Text>
                <AgentFace agentId={agentId} size={16} live={false} />
              </Animated.View>
            )),
          ])}
        </View>
      ) : null}
    </LayoutAnimationConfig>
  );
}

const REACT_SLOP = { top: 7, bottom: 7 };
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** A pill arriving: from 0.95 and clear to whole, in 150 ms (never from nothing). */
const PILL_IN: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.95 }] },
    animations: {
      opacity: withTiming(1, { duration: 150, easing: EASE_OUT }),
      transform: [{ scale: withTiming(1, { duration: 150, easing: EASE_OUT }) }],
    },
  };
};
const PILL_OUT = FadeOut.duration(120);
const PILL_MOVE = LinearTransition.duration(200);
/** The emoji at the finger: in at once, rising a little as it leaves. */
const POP_IN: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 0 }, { scale: 0.95 }] },
    animations: {
      opacity: withTiming(1, { duration: 120, easing: EASE_OUT }),
      transform: [
        { translateY: withTiming(-10, { duration: 300, easing: EASE_OUT }) },
        { scale: withTiming(1, { duration: 150, easing: EASE_OUT }) },
      ],
    },
  };
};
const POP_OUT = FadeOut.duration(160);

/** The turn's last corner, cut as a card's is, on the side my bubble stands. */
const BUBBLE_CUT = RADIUS.sm;

/** A row under the quote it answers: they read as one. */
const QUOTE_GAP = 2;
/** A pin's caption stays on its message, as a name on its words. */
const PIN_GAP = 2;

/** The bubble's corners by its place in a run of my rows: the sides it shares with its neighbours square off. */
/** A mention's amber over a lifted bubble, as much as its tint (`21`, hex) shows over the gray. */
const AMBER_TINT = 0x21 / 0xff;

const BUBBLE_RUN: Record<RunPosition, { borderTopRightRadius?: number; borderBottomRightRadius?: number }> = {
  solo: { borderBottomRightRadius: BUBBLE_CUT },
  start: { borderBottomRightRadius: RADIUS.sm },
  mid: { borderTopRightRadius: RADIUS.sm, borderBottomRightRadius: RADIUS.sm },
  end: { borderTopRightRadius: RADIUS.sm, borderBottomRightRadius: BUBBLE_CUT },
};

/**
 * A row's parts' context: how far a card stands off what is above it (`RowPartContext`), and in bubbles that it is a
 * bubble of this message (`BubblePartContext`) and, for a request alone, the message's name and time
 * (`BubbleHeadContext`).
 */
function RowParts({
  top,
  part,
  head,
  children,
}: {
  top: number;
  part: BubblePart | null;
  head: BubbleHead | null;
  children: ReactNode;
}) {
  return (
    <RowPartContext.Provider value={top}>
      <BubblePartContext.Provider value={part}>
        <BubbleHeadContext.Provider value={head}>{children}</BubbleHeadContext.Provider>
      </BubblePartContext.Provider>
    </RowPartContext.Provider>
  );
}

/** How far under a bubble its cards sit in `bubbles`: one group of the same message, as a run of bubbles. */
const BUBBLE_JOIN = 3;

/** Anyone else's bubble in `bubbles`: the same, on the left. */
const OTHER_RUN: Record<RunPosition, { borderTopLeftRadius?: number; borderBottomLeftRadius?: number }> = {
  solo: {},
  start: { borderBottomLeftRadius: RADIUS.sm },
  mid: { borderTopLeftRadius: RADIUS.sm, borderBottomLeftRadius: RADIUS.sm },
  end: { borderTopLeftRadius: RADIUS.sm },
};

/** Words and time on my solid bubble. */
const ON_SOLID = "#ffffff";

const styles = StyleSheet.create({
  // Readable turns: more room between turns, a quieter name and time.
  msg: {
    flexDirection: "row",
    gap: MSG_GAP,
    paddingLeft: MSG_INSET,
    paddingRight: 16,
  },
  replied: { marginTop: 0, paddingTop: QUOTE_GAP },
  // Bubbles only: the other looks' cards cast shadows past the row.
  ownBox: { overflow: "hidden" },
  aboutAbove: { paddingRight: 16 },
  // A quote of the agents' talk with no words to sit in: on the words' column, as wide as a bubble's.
  avslot: { width: MSG_AVATAR, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  // A long pick wraps: the check stays on its first line.
  choiceReply: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingVertical: 2 },
  // Wraps on a narrow phone: a routine's tag and "Ver relatório" go to the next line instead of off the edge.
  who: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 4, marginBottom: 4 },
  // A person's name line keeps room at its end for the receipt's mark, with or without one, so a mark that comes
  // never wraps the line.
  whoRoom: { paddingRight: 40 },
  whoMark: { position: "absolute", top: 0, right: 0, height: 19, justifyContent: "center" },
  // On the words' first line: the slot's 2 over the words' own 1.
  slotMark: { marginTop: -1, justifyContent: "center" },
  whoTight: { marginBottom: 0 },
  bubbleEnd: { alignSelf: "flex-end" },
  retry: { fontWeight: "600", textDecorationLine: "underline" },
  compactLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6 },
  name: { fontWeight: "600", fontSize: 14, lineHeight: 19, flexShrink: 1 },
  me: { paddingLeft: 64, paddingRight: BUBBLES_EDGE, alignItems: "flex-end" },
  meParts: { alignSelf: "stretch" },
  // What slides with a pull to the left (`SwipeSlide`): the row's whole width, as its parts were.
  meSlide: { alignSelf: "stretch" },
  meTime: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, height: 16 },
  mePressed: { opacity: 0.7 },
  meEnd: { alignSelf: "flex-end" },
  bubble: {
    maxWidth: "100%",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  meFiles: { alignSelf: "stretch" },
  meStatus: { textAlign: "right" },
  status: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 18 },
  statusEnd: { alignSelf: "flex-end" },
  // The stop's pill (or Continue alone) under the reply's words; the body sets its top.
  stopped: { alignItems: "flex-start" },
  medium: { fontWeight: "600" },
  pressedDim: { opacity: 0.6 },
  shrink: { flexShrink: 1 },
  // The chip's own shrink only works if what holds it can shrink too (a long routine name ends in "…").
  tagPress: { flexShrink: 1, maxWidth: "100%", alignSelf: "center" },
  pin: { alignSelf: "center" },
  // The routine report a message answers, unfolded under its name (like the notice line's text).
  // A plate in the words, as a quote's: the scale's item corner, the plates' room.
  report: { marginTop: 2, paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS.md },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "center",
    flexShrink: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  pinLine: { flexDirection: "row", alignItems: "center", gap: 4 },
  reacts: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  // The thumbs up where the finger was, over the row.
  pop: { position: "absolute", width: POP, height: POP, alignItems: "center", justifyContent: "center" },
  popEmoji: { fontSize: 22, lineHeight: 26 },
  hint: { marginTop: 4 },
  // The outline is always there (clear unless it is mine), so a pill keeps its size when I add or take mine.
  react: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: "transparent",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
});

/** Taps on the name line's small words and chips (16 to 20 points tall) reach 44 points without spreading them. */
const NAME_LINE_SLOP = { top: 14, bottom: 14, left: 6, right: 6 };
