import {
  type AgentProposal,
  ApiError,
  useAgentProposal,
  useAiAccounts,
  useAiHub,
  useApi,
  useBrainMachines,
  useCatalog,
  useChannels,
  useConnections,
  useCreateAgent,
  useCredentials,
  useCustomServers,
  useDenyAgentProposal,
  useDms,
  useModels,
  useNewAgentSetup,
  usePlatformKey,
  useSkills,
} from "@agenteschat/client";
import { type Level, saveLevels } from "@agenteschat/client/lib/access-levels";
import { draftLevels, draftMailLevels, suggestedAiText } from "@agenteschat/client/lib/action-cards";
import { newAgentStart, newAgentStartText } from "@agenteschat/client/lib/agent-setup";
import { aiChoiceRows } from "@agenteschat/client/lib/ai-choice";
import {
  brainPickOptions,
  newPlanAccountOption,
  planAccountOption,
  planAccountOptionOf,
} from "@agenteschat/client/lib/brain-picker";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { FIELD_LIMITS } from "@agenteschat/client/lib/field-limits";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { defaultPolicy, toMailLevel } from "@agenteschat/client/lib/mail";
import {
  cleanHandle,
  freeHandle,
  handleForName,
  handleProblem,
  PERSONAL_STARTERS,
  type PersonalStarter,
  presetChannels,
  presetLevels,
  ROLE_DEFAULTS,
  ROLE_GROUPS,
  type RoleId,
  savePart,
  takenHandles,
} from "@agenteschat/client/lib/new-agent";
import { addsAgentsTo, can } from "@agenteschat/client/lib/permissions";
import { modelChoices, usableModels } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Image } from "expo-image";
import { useNavigation } from "expo-router";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withSequence, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  ACT_LINE,
  AgentAvatar,
  Button,
  EmptyState,
  fieldText,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type IconName,
  Locked,
  Sky,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { AiChoiceFields } from "../ai/AiChoice";
import { choiceText } from "../ai/hub";
import { chosenAi, newAgentAi, newAgentChoice, pickedAi } from "../ai/logic";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { pickLevel } from "../connectors/pick-level";
import { suggestAgentName } from "../new/logic";
import { useOpenDm } from "../new/useOpenDm";
import { RowBones } from "../roles/parts";
import { useFailed } from "../routines/hooks";
import { proposedRoutineWhen } from "../routines/rule";
import { SettingsPage, useUnsavedGuard } from "../settings/parts";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import {
  BottomBar,
  FocusLive,
  goBack,
  PushedHeader,
  successHaptic,
  Tile,
  tapHaptic,
  useSurface,
} from "../shared/parts";
import { overLimit, TextArea } from "../shared/TextArea";
import { markArrived } from "./arrival";
import { fullLook } from "./edit";
import { ErrorLine, HandleInput } from "./HandleInput";
import { ImportPicker, ImportPreview } from "./ImportAgents";
import { arrivedAgents, IMPORT_AGENTS_HREF, IMPORT_PREVIEW_HREF, landingOf, reportCounts } from "./import";
import { IMPORT_LOGO } from "./import-logos";
import { LookList } from "./LookPicker";
import {
  changeHref,
  firstBlockedStep,
  flowDepth,
  importMarkCards,
  NEW_AGENT_PHONE_STEPS,
  NEW_AGENT_STEP_HREF,
  nextStep,
  type PhoneStep,
  roleLine,
  stepBlocked,
  stepOf,
} from "./new-agent";
import {
  draftDirty,
  editNewAgent,
  endNewAgent,
  finishNewAgent,
  holdNewAgentRelease,
  type NewAgentDraft,
  newAgentNow,
  startNewAgent,
  useNewAgent,
} from "./new-agent-flow";
import { RoleInput } from "./RoleInput";
import { agentImportNow, closeAgentImport, openAgentImport, resetAgentImport, useAgentImport } from "./useAgentImport";

const INSTRUCTIONS_LIMIT = { max: FIELD_LIMITS.instructions };
const NEW_AGENT = { kind: "newAgent" } as const;
/** "Conectar uma IA" at the end of Quem pensa's accounts. */
const CONNECT = "connect";

/**
 * "Criar agente" on the phone, the web's steps for a thumb, each a screen of its own on the stack (the system's back,
 * bar and edge swipe, goes to the step before): Função (the presets, grouped), Quem é (name, @ and look), O que faz
 * (the instructions, prefilled by the role) and Revisar (what it can use and the channels it joins, from the role, and
 * who thinks: the workspace's last setup or Automático, ADR 0094). Budget and who it answers start at the workspace's
 * defaults and change on its page. Created, it opens the direct conversation with it.
 *
 * This is the flow's first screen (`/new-agent`): the role, or where its address starts it. `initialWhat` (an example
 * in the empty Conversas) starts from scratch on who it is, with that text. `proposalId` (an agent's proposal card, ADR
 * 0081) starts on Revisar, filled in with the draft, while the proposal is open; its rows open the steps to change them.
 */
export function NewAgentScreen({
  initialWhat = "",
  proposalId = null,
  channelId = null,
  accountId = null,
}: {
  initialWhat?: string;
  proposalId?: string | null;
  /** A channel's "Criar agente" (its Adicionar sheet): the agent starts in that channel. */
  channelId?: string | null;
  /** A plan account of mine just connected (Connect AI's "Criar um agente com este plano"): it thinks with that one. */
  accountId?: string | null;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const proposal = useAgentProposal(orgId, proposalId);
  // The draft as it was when it opened: once created here the proposal is closed, and the form stays on.
  const opened = useRef<AgentProposal | null>(null);
  if (proposal.data?.canDecide && opened.current?.messageId !== proposal.data.messageId) opened.current = proposal.data;
  if (proposalId && !opened.current) {
    // Nothing to go on with: the bar's back leaves.
    return (
      <SettingsPage title={t("newAgent.title")}>
        {proposal.isPending ? (
          // The draft's own shape while it loads: the review's rows, never a blank page.
          <GroupedList>
            <RowBones />
            <RowBones name={56} />
            <RowBones name={34} />
          </GroupedList>
        ) : (
          <EmptyState
            size="page"
            icon="agent"
            title={
              proposal.error instanceof ApiError && proposal.error.status === 403
                ? t("newAgent.proposalNoAccess")
                : t("newAgent.proposalClosed")
            }
          />
        )}
      </SettingsPage>
    );
  }
  return <FlowStart what={initialWhat} from={opened.current} channelId={channelId} accountId={accountId} />;
}

/**
 * Starts the flow's draft and shows the step it starts on. It is the flow's bottom screen, so leaving the flow with
 * something typed asks here (the steps' own back never does); the flow ends when this screen goes away.
 */
function FlowStart({
  what,
  from,
  channelId,
  accountId,
}: {
  what: string;
  from: AgentProposal | null;
  channelId: string | null;
  accountId: string | null;
}) {
  const { org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const [first] = useState(() => {
    const proposed = from?.params.draft;
    return startNewAgent({
      what,
      suggested: suggestAgentName([...dir.agentById.values()].map((a) => a.name)),
      from,
      channelId,
      accountId,
      levels: proposed && can(org, "manage_agents") ? draftLevels(proposed) : {},
      mail: proposed && meId ? draftMailLevels(proposed, meId) : {},
    });
  });
  const d = useDraft() ?? first;
  const leave = useUnsavedGuard(draftDirty(d));
  // The step that finishes (Criar, an import, a refusal) lets the leaving through this screen's guard.
  useEffect(() => holdNewAgentRelease(first.id, leave), [first.id, leave]);
  useEffect(() => () => endNewAgent(first.id), [first.id]);
  return <Step step={first.entry} d={d} />;
}

/**
 * A step pushed over the flow's first screen (`/new-agent/<step>`): on to it from the step before, or from Revisar to
 * change it (`change`), saying why it can't go on yet when Criar sent it there (`tried`).
 */
export function NewAgentStepScreen({
  step,
  change = false,
  tried = false,
}: {
  step: PhoneStep;
  change?: boolean;
  tried?: boolean;
}) {
  const d = useDraft();
  // Opened with no flow under it (its address on its own, after a restart): nothing to show, back where it came from.
  useEffect(() => {
    if (!newAgentNow()) goBack();
  }, []);
  return d ? <Step step={step} d={d} change={change} tried={tried} /> : null;
}

interface StepProps {
  d: NewAgentDraft;
  /** Opened from Revisar to change it: its button says Pronto and goes back there. */
  change?: boolean;
  tried?: boolean;
}

/** A step's page: what lives on it (the agent in its sky, on "who it is") holds still while a step is over it. */
function Step(props: StepProps & { step: PhoneStep }) {
  return (
    <FocusLive>
      <StepBody {...props} />
    </FocusLive>
  );
}

function StepBody({ step, ...props }: StepProps & { step: PhoneStep }) {
  if (step === "role") return <RoleStep {...props} />;
  if (step === "identity") return <IdentityStep {...props} />;
  if (step === "instructions") return <InstructionsStep {...props} />;
  return <ReviewStep {...props} />;
}

/** The flow's draft as this screen last saw it: a screen sliding away once the flow ended keeps what it showed. */
function useDraft(): NewAgentDraft | null {
  const live = useNewAgent();
  const last = useRef(live);
  if (live) last.current = live;
  return last.current;
}

/** Where the step stands, as the bar's subtitle ("2 of 4"); a step opened from Revisar to change it counts nothing. */
function useStepCount(d: NewAgentDraft, step: PhoneStep, change: boolean): string | undefined {
  const { t } = useTranslation();
  const at = change ? null : stepOf(d.entry, step);
  return at ? t("mobile.choices.step", at) : undefined;
}

/**
 * The step's way on: the next step's screen, pushed; or, opened from Revisar, back to it, once (a second tap while it
 * slides away would leave Revisar too).
 */
function useStepExit(step: PhoneStep, change: boolean) {
  const gone = useRef(false);
  return () => {
    if (change) {
      if (gone.current) return;
      gone.current = true;
      goBack();
      return;
    }
    const next = nextStep(step);
    if (next) router.push(NEW_AGENT_STEP_HREF[next]);
  };
}

/** Runs `go` a beat later (the tapped row's check shows first); never once the screen went away. */
function useLater() {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (go: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(go, ms);
  };
}

/** Leaves every screen of the flow at once (its steps, its first screen, an import's), back where it was opened. */
function useLeaveFlow() {
  const navigation = useNavigation();
  return () => {
    const depth = flowDepth(navigation.getState()?.routes.map((r) => r.name) ?? []);
    if (depth > 0) router.dismiss(depth);
  };
}

/** Mine, and the ones a proposal names: only where I may put an agent (in it and posting, or managing it). */
function useMyChannels(from: AgentProposal | null) {
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const proposed = from?.params.draft;
  return useMemo(() => {
    const dmIds = new Set((dms.data ?? []).map((dm) => dm.channelId));
    return (channels.data ?? []).filter(
      (ch) => (ch.isMember || proposed?.channelIds.includes(ch.id)) && !dmIds.has(ch.id) && addsAgentsTo(ch, meId, org),
    );
  }, [channels.data, dms.data, proposed, meId, org]);
}

/**
 * A step's screen: the native bar ("Criar agente", where the step stands under it, the system's back) over the grouped
 * gray, and the step's one action pinned under its scroll, riding the keyboard.
 */
function StepPage({
  subtitle,
  bar,
  children,
}: {
  subtitle?: string | undefined;
  bar?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("newAgent.title")} subtitle={subtitle} solid={false} grouped />
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.body, bar ? null : { paddingBottom: 32 + insets.bottom }]}
        >
          {children}
        </ScrollView>
        {bar ? <BottomBar bottom={insets.bottom}>{bar}</BottomBar> : null}
      </KeyboardAvoidingView>
    </View>
  );
}

/** The step's question and one line under it. */
function StepHead({ title, lead }: { title: string; lead?: string }) {
  return (
    <View style={styles.head}>
      <Text variant="title2" accessibilityRole="header">
        {title}
      </Text>
      {lead ? (
        <Text variant="small" tone="muted">
          {lead}
        </Text>
      ) : null}
    </View>
  );
}

/** Função: the presets, grouped (a personal workspace's own starting points), from scratch, or agents from another app. */
function RoleStep({ d, change = false, tried = false }: StepProps) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const mayImport = can(org, "create_agents");
  const personal = isPersonal(org);
  const myChannels = useMyChannels(d.from);
  const count = useStepCount(d, "role", change);
  const exit = useStepExit("role", change);
  const later = useLater();
  const { role, starter, roleText } = d;
  const proposed = d.from?.params.draft;
  const pickRole = (id: RoleId) => {
    tapHaptic();
    const agentName = id === "custom" ? "" : t(`newAgent.roles.${id}.agent`);
    // A new role fills in the rest. The role it already has keeps what was typed, and a proposal keeps its draft.
    editNewAgent((now) => ({
      role: id,
      starter: null,
      ...((id !== now.role || now.starter) && !proposed
        ? {
            roleText: "",
            name: agentName,
            handle: handleForName(agentName),
            handleTouched: false,
            look: fullLook(ROLE_DEFAULTS[id].look),
            instructions: t(`newAgent.roles.${id}.instructions`),
            channelIds: new Set([...now.asked, ...presetChannels(id, myChannels)]),
          }
        : {}),
    }));
    // A tap is the answer: on to the next step, or back to Revisar when it was opened there.
    later(exit, 180);
  };
  /** A personal workspace's starting point: from scratch, with its agent's name, look, role and line filled in. */
  const pickStarter = (s: PersonalStarter) => {
    tapHaptic();
    editNewAgent((now) => ({
      role: "custom",
      starter: s.id,
      ...(now.starter !== s.id && !proposed
        ? {
            roleText: t(`teamTemplates.agents.${s.id}.role`),
            name: s.name,
            handle: handleForName(s.name),
            handleTouched: false,
            look: fullLook(s.look),
            instructions: t(`teamTemplates.agents.${s.id}.line`),
            channelIds: new Set(now.asked),
          }
        : {}),
    }));
    later(exit, 180);
  };
  return (
    <StepPage
      subtitle={count}
      // Nothing to press yet on the first step (a tap on a role goes on by itself): no bar at all.
      bar={
        change || role !== null ? (
          <Button
            variant="primary"
            wide
            label={change ? t("mobile.common.done") : t("common.continue")}
            onPress={exit}
          />
        ) : null
      }
    >
      <StepHead title={t("newAgent.steps.role.title")} lead={t("newAgent.steps.role.lead")} />
      <GroupedList>
        <GroupedRow
          leading={<RowTile icon="plus" />}
          label={t("newAgent.roles.custom.name")}
          sub={t("newAgent.roles.custom.desc")}
          subLines={2}
          checked={role === "custom" && !starter}
          onPress={() => pickRole("custom")}
        />
      </GroupedList>
      {role === "custom" && !starter ? (
        <RoleInput
          value={roleText}
          onChangeText={(v) => editNewAgent({ roleText: v })}
          placeholder={t("agent.roleHelp")}
        />
      ) : null}
      {/* Right under "Do zero", a card of its own: the other way to start, before the presets. Its own screens. */}
      {mayImport && !proposed && !change ? (
        <View style={styles.other}>
          <GroupedList>
            <GroupedRow
              leading={<ImportMarks />}
              label={t("newAgent.importCard")}
              sub={t("newAgent.importCardLine")}
              subLines={2}
              chevron
              onPress={() => router.push(IMPORT_AGENTS_HREF)}
            />
          </GroupedList>
        </View>
      ) : null}
      {personal ? (
        // One person's agents (ADR 0159 §3): the right hand's personal ones, not a company's roles.
        <>
          <GroupedHeader>{t("newAgent.roleGroups.personal")}</GroupedHeader>
          <GroupedList>
            {PERSONAL_STARTERS.map((s) => (
              <GroupedRow
                key={s.id}
                leading={<AgentAvatar agent={fullLook(s.look)} size={36} live={false} />}
                label={t(`teamTemplates.agents.${s.id}.role`)}
                sub={roleLine(
                  t(`teamTemplates.agents.${s.id}.line`),
                  t("newAgent.startsAs", { name: s.name }),
                  s.name,
                  i18n.language,
                )}
                subLines={2}
                checked={starter === s.id}
                onPress={() => pickStarter(s)}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
      {(personal ? [] : ROLE_GROUPS).map((group) => (
        <Fragment key={group.id}>
          <GroupedHeader>{t(`newAgent.roleGroups.${group.id}`)}</GroupedHeader>
          <GroupedList>
            {group.roles.map((id) => {
              const agent = t(`newAgent.roles.${id}.agent`);
              return (
                <GroupedRow
                  key={id}
                  leading={<AgentAvatar agent={fullLook(ROLE_DEFAULTS[id].look)} size={36} live={false} />}
                  label={t(`newAgent.roles.${id}.name`)}
                  sub={roleLine(
                    t(`newAgent.roles.${id}.desc`),
                    t("newAgent.startsAs", { name: agent }),
                    agent,
                    i18n.language,
                  )}
                  subLines={2}
                  checked={role === id}
                  onPress={() => pickRole(id)}
                />
              );
            })}
          </GroupedList>
        </Fragment>
      ))}
      {tried && !role ? (
        <View style={styles.foot}>
          <ErrorLine text={t("newAgent.errors.roleRequired")} />
        </View>
      ) : null}
    </StepPage>
  );
}

/** Quem é: the agent in its sky, its name, its @ and its look. */
function IdentityStep({ d, change = false, tried: triedFirst = false }: StepProps) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const dir = useDirectory();
  const count = useStepCount(d, "identity", change);
  const exit = useStepExit("identity", change);
  const [tried, setTried] = useState(triedFirst);
  const { name, handle, look } = d;
  // The face answers the name (a first-time moment): it looks down at the field while the name is typed and, when the
  // field is left (the keyboard's Next), smiles and hops 4 points on a spring. Transform only, on the UI thread.
  const [naming, setNaming] = useState(false);
  const [cheer, setCheer] = useState(false);
  const reduced = useReducedMotion();
  const hop = useSharedValue(0);
  const hopStyle = useAnimatedStyle(() => ({ transform: [{ translateY: hop.get() }] }));
  // The keyboard's Next on the name goes on to the @, which shows once the name is left: it takes the focus then, and
  // the keyboard stays up between them.
  const handleField = useRef<TextInputInstance | null>(null);
  const toHandle = useRef(false);
  useEffect(() => {
    if (naming || !toHandle.current) return;
    toHandle.current = false;
    handleField.current?.focus();
  }, [naming]);
  const nameDone = () => {
    // Left once: the Next that moves on and the blur that follows it are one leaving.
    if (!naming) return;
    setNaming(false);
    if (!name.trim()) return;
    setCheer(true);
    if (!reduced) {
      const up = withSpring(-4, { duration: 220, dampingRatio: 0.6 });
      const down = withSpring(0, { duration: 300, dampingRatio: 0.8 });
      hop.set(withSequence(up, down));
    }
    setTimeout(() => setCheer(false), 900);
  };
  const changeName = (value: string) =>
    editNewAgent((now) => ({ name: value, ...(now.handleTouched ? {} : { handle: handleForName(value) }) }));
  const taken = useMemo(
    () => takenHandles([...dir.agentById.values()], [...dir.memberById.values()]),
    [dir.agentById, dir.memberById],
  );
  const shownName = name.trim() || t("newAgent.previewName");
  const handleIssue = handle || tried ? handleProblem(handle, taken) : null;
  const handleText =
    handleIssue === "taken"
      ? t("newAgent.errors.handleTaken", { handle, suggestion: freeHandle(handle, taken) })
      : handleIssue === "format"
        ? t("newAgent.errors.handleFormat")
        : handleIssue === "empty"
          ? t("newAgent.errors.handleEmpty")
          : handle
            ? t("newAgent.handleHelp", { handle })
            : t("newAgent.handleEmpty");
  const next = () => {
    if (stepBlocked("identity", { role: d.role, name, handle, taken })) {
      setTried(true);
      return;
    }
    exit();
  };
  const field = [styles.field, fieldText("body"), { color: c.ink }];
  return (
    <StepPage
      subtitle={count}
      bar={
        <Button variant="primary" wide label={change ? t("mobile.common.done") : t("common.continue")} onPress={next} />
      }
    >
      <StepHead title={t("mobile.newAgent.identityQuestion")} lead={t("mobile.newAgent.identityLead")} />
      {/* The agent standing in its own sky, as on its page: what the fields below change. Its sky is the step's
          one color; the face is the one on its profile (96, unframed). */}
      <View style={[styles.stage, surface]}>
        <Sky color={look.color} surface="raised" style={StyleSheet.absoluteFill} />
        <Animated.View style={hopStyle}>
          <AgentAvatar
            agent={look}
            size={96}
            name={shownName}
            framed={false}
            {...(naming ? { gaze: "down" as const } : {})}
            {...(cheer ? { expression: "happy" as const } : {})}
          />
        </Animated.View>
      </View>
      <GroupedHeader>{t("newAgent.name")}</GroupedHeader>
      <GroupedList>
        <TextInput
          value={name}
          onChangeText={changeName}
          maxLength={32}
          autoCorrect={false}
          placeholder={t("newAgent.namePlaceholder")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("newAgent.name")}
          style={field}
          onFocus={() => setNaming(true)}
          onBlur={nameDone}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => {
            toHandle.current = true;
            nameDone();
          }}
        />
      </GroupedList>
      {tried && !name.trim() ? (
        <View style={styles.foot}>
          <ErrorLine text={t("newAgent.errors.nameRequired")} />
        </View>
      ) : naming ? (
        // While the name is typed: only the stage, the name and where its @ comes from. The rest comes back with Next.
        <GroupedFooter>
          {handle ? t("mobile.newAgent.handleFromName", { handle }) : t("mobile.newAgent.handleFromNameEmpty")}
        </GroupedFooter>
      ) : null}
      {naming ? null : (
        <Animated.View entering={reduced ? undefined : REST_IN}>
          <GroupedHeader>{t("newAgent.handle")}</GroupedHeader>
          <GroupedList>
            <HandleInput
              ref={handleField}
              value={handle}
              onChangeText={(v) => editNewAgent({ handleTouched: true, handle: cleanHandle(v) })}
              label={t("newAgent.handle")}
              placeholder={t("newAgent.handlePlaceholder")}
              ok={Boolean(handle) && !handleIssue}
            />
          </GroupedList>
          {handleIssue ? (
            <View style={styles.foot}>
              <ErrorLine text={handleText} />
            </View>
          ) : (
            // What the @ is for, in one line: how to call it in the chat.
            <GroupedFooter>{handle ? t("mobile.newAgent.handleMention", { handle }) : handleText}</GroupedFooter>
          )}
          <LookList look={look} onChange={(value) => editNewAgent({ look: value })} />
        </Animated.View>
      )}
    </StepPage>
  );
}

/** O que faz: the instructions, prefilled by the role, with the role's own a tap away. */
function InstructionsStep({ d, change = false }: StepProps) {
  const { t } = useTranslation();
  const count = useStepCount(d, "instructions", change);
  const exit = useStepExit("instructions", change);
  const { role, instructions } = d;
  const g = agentGrammar(d.name.trim() || t("newAgent.defaultName"));
  const setInstructions = (value: string) => editNewAgent({ instructions: value });
  // Past the limit the field says so under it, and the step waits until it is shortened.
  const over = overLimit(instructions, INSTRUCTIONS_LIMIT);
  return (
    <StepPage
      subtitle={count}
      bar={
        <Button
          variant="primary"
          wide
          label={change ? t("mobile.common.done") : t("common.continue")}
          disabled={over}
          onPress={exit}
        />
      }
    >
      <StepHead title={t("newAgent.steps.instructions.title", g)} lead={t("newAgent.steps.instructions.lead")} />
      {/* The list draws the field's surface (radius 14, raised), like the fields around it. */}
      <GroupedList>
        <TextArea
          value={instructions}
          limit={INSTRUCTIONS_LIMIT}
          onChangeText={setInstructions}
          placeholder={t("newAgent.instructionsPlaceholder")}
          accessibilityLabel={t("newAgent.instructions")}
          minHeight={220}
          scrollEnabled={false}
          style={styles.bare}
        />
      </GroupedList>
      {role && role !== "custom" && instructions !== t(`newAgent.roles.${role}.instructions`) ? (
        <View style={[ACT_LINE.row, styles.restore]}>
          <Text variant="footnote" tone="faint" style={ACT_LINE.text}>
            {t("newAgent.startedFrom", { role: t(`newAgent.roles.${role}.name`) })}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            label={t("newAgent.restore")}
            onPress={() => setInstructions(t(`newAgent.roles.${role}.instructions`))}
          />
        </View>
      ) : null}
      {!instructions.trim() ? <GroupedFooter>{t("newAgent.noInstructions", g)}</GroupedFooter> : null}
    </StepPage>
  );
}

/**
 * Revisar: who it is, its role and what it does (each row opens its step to change it, pushed over Revisar), who
 * thinks, what it can use and the channels it joins; Criar makes it and leaves the whole flow.
 */
function ReviewStep({ d }: StepProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const failed = useFailed();
  const api = useApi();
  const orgId = useOrgId();
  const { org } = useOrg();
  const mayImport = can(org, "create_agents");
  // Giving a new agent apps is for who edits any agent: anyone else's starts without them (ADR 0085 §5).
  const managesAgents = can(org, "manage_agents");
  const meId = useMeId();
  const dir = useDirectory();
  const create = useCreateAgent(orgId);
  const openDm = useOpenDm();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const library = useSkills(orgId);
  const lastSetup = useNewAgentSetup(orgId, mayImport);
  const brainMachines = useBrainMachines(orgId);
  const models = useModels();
  const credentials = useCredentials(orgId, can(org, "manage_credentials"));
  const platform = usePlatformKey(orgId);
  const deny = useDenyAgentProposal(orgId);
  const myChannels = useMyChannels(d.from);
  const leaveFlow = useLeaveFlow();
  const count = useStepCount(d, "review", false);
  const [busy, setBusy] = useState(false);
  const {
    from,
    role,
    roleText,
    name,
    handle,
    look,
    instructions,
    channelIds,
    proposedLevels,
    mailLevels,
    withRoutine,
    aiPick,
    optionsBefore,
  } = d;
  const proposed = from?.params.draft;

  // Who thinks (ADR 0094): the workspace's last setup where it can think for an agent of mine, unless a proposal says.
  const keys = credentials.data ?? [];
  const choices = modelChoices(models.data?.models ?? [], keys, platform.data ?? false);
  const usable = usableModels(choices);
  const start = proposed ? null : newAgentStart(lastSetup.data, { ownerIsMe: true, usable, keys });
  // Or anything else "Quem pensa" offers (the one AI choice), picked in place.
  const aiAccounts = useAiAccounts(orgId, !proposed);
  const held = usePlanHold(orgId, org) !== null;
  const brainOptions = brainPickOptions(t, i18n.language, {
    api: choices,
    machines: brainMachines.data ?? [],
    accounts: aiAccounts.data?.accounts ?? [],
    ownerIsMe: true,
    held,
  });
  // "Conectar uma IA" from this step (the same screens as Settings, for the agents I create): a plan account that
  // wasn't among the choices when it opened is what the agent thinks with, over a pick made before; nothing new keeps
  // the pick.
  const ownPlan = planAccountOption(brainOptions);
  const askedPlan = d.accountId ? planAccountOptionOf(brainOptions, d.accountId) : undefined;
  const connectedHere = optionsBefore ? newPlanAccountOption(brainOptions, optionsBefore) : undefined;
  // No last setup to start from: a plan account of mine that can think for it (one connected before I had an agent).
  const pick = connectedHere ? null : aiPick;
  const chosen = connectedHere ?? (pick ? null : (askedPlan ?? (proposed || start ? null : (ownPlan ?? null))));
  const thinks = pick
    ? chosenAi(pick, start?.autonomy)
    : chosen
      ? pickedAi(chosen.pick, aiAccounts.data?.computers)
      : newAgentAi(start);
  const choice = pick ?? newAgentChoice(chosen?.pick, chosen ? null : start, usable.size > 0);
  const { hub, loading: hubLoading } = useAiHub(orgId);
  const pickRow = pick
    ? aiChoiceRows(hub, { target: NEW_AGENT, viewerId: meId ?? "", current: pick }).find((r) => r.selected)
    : undefined;
  const startText = start
    ? newAgentStartText(t, i18n.language, start, {
        models: models.data?.models ?? [],
        machines: brainMachines.data ?? [],
        provider: lastSetup.data?.account?.provider,
      })
    : "";
  // What it thinks with unless another is picked, in words.
  const startsOn = chosen?.title ?? (start ? startText : t("brain.auto.label"));
  const connect = () => {
    editNewAgent({ optionsBefore: new Set(brainOptions.map((o) => o.value)) });
    openConnectAi({ forNew: "1" });
  };
  // The person left this screen while it was made: it exists, as the toast says, and moving them now would pop or
  // cover wherever they went.
  const left = useRef(false);
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);

  const items = useMemo(
    () => connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []),
    [connections.data, servers.data, catalog.data],
  );
  const levels = useMemo(
    // A proposal's levels (the reviewer's, here) over the role's; the apps it doesn't name open as any role's.
    () => (managesAgents ? { ...presetLevels(role ?? "custom", items, isPersonal(org)), ...proposedLevels } : {}),
    [proposedLevels, role, items, managesAgents, org],
  );
  const granted = items.filter((i) => (levels[i.id] ?? "none") !== "none");
  const myMail = (proposed?.mail ?? []).filter((m) => m.accountId in mailLevels);
  // Revisar lists what a proposal asked for at any level, so a change can be taken back.
  const listedApps = proposed ? items.filter((i) => i.id in proposedLevels || granted.includes(i)) : granted;
  const taken = useMemo(
    () => takenHandles([...dir.agentById.values()], [...dir.memberById.values()]),
    [dir.agentById, dir.memberById],
  );
  const shownName = name.trim() || t("newAgent.previewName");
  const g = agentGrammar(name.trim() || t("newAgent.defaultName"));
  const roleName = role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : roleText.trim();
  // A level is chosen among the three in the app's picker, as everywhere else on the phone, never cycled by taps.
  const chooseLevel = (title: string, current: string, choose: (level: Level) => void) =>
    void pickLevel(t, title, current).then((level) => {
      if (level) choose(level);
    });
  const setProposedLevel = (id: string, level: Level) =>
    editNewAgent((now) => ({ proposedLevels: { ...now.proposedLevels, [id]: level } }));
  const setMailLevel = (accountId: string, level: Level) =>
    editNewAgent((now) => ({ mailLevels: { ...now.mailLevels, [accountId]: level } }));

  const refuse = () => {
    if (!from) return;
    deny.mutate(from.messageId, {
      onSuccess: () => {
        finishNewAgent();
        if (!left.current) leaveFlow();
      },
      onError: failed,
    });
  };

  const submit = async () => {
    if (busy) return;
    // A step that can't go on yet opens over Revisar, saying why; back here once it is right.
    if (overLimit(instructions, INSTRUCTIONS_LIMIT)) {
      router.push(changeHref("instructions"));
      return;
    }
    const bad = NEW_AGENT_PHONE_STEPS[firstBlockedStep({ role, name, handle, taken })];
    if (bad) {
      router.push(changeHref(bad, true));
      return;
    }
    setBusy(true);
    try {
      const agent = await create.mutateAsync({
        name: name.trim(),
        handle,
        role: role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : roleText.trim(),
        instructions,
        model: thinks.model,
        // Its setup checklist suggests from the ready-made role it started from (ADR 0155 §2).
        setup: { role: role && role !== "custom" ? role : null },
        ownerUserId: meId ?? null,
        // A personal workspace's new agent answers its owner only (ADR 0159 §3a): someone who joins later is not
        // answered by every agent made while the person was alone.
        audience: { mode: isPersonal(org) ? "owner" : "everyone", userIds: [] },
        credentialId: thinks.credentialId,
        monthlyBudgetUsd: null,
        appearance: look,
        ...(from ? { proposal: from.messageId } : {}),
        ...(thinks.autonomy ? { autonomy: thinks.autonomy } : {}),
      });
      // It exists: leaving the flow from here on asks nothing.
      finishNewAgent();
      // What the role brings, as the web's last step: its channels, its apps' levels, the default skills. One part
      // at a time, so a refused one doesn't keep the rest (the AI below too) from saving.
      const failures: unknown[] = [];
      const joined = myChannels.filter((ch) => channelIds.has(ch.id));
      if (joined.length > 0)
        await savePart(failures, () =>
          api.agents.setChannels(
            orgId,
            agent.id,
            joined.map((ch) => ({ channelId: ch.id })),
          ),
        );
      const grants = Object.fromEntries(granted.map((i) => [`connector:${i.id}`, levels[i.id] as Level]));
      if (Object.keys(grants).length > 0) await savePart(failures, () => saveLevels(api, orgId, agent.id, grants));
      const list = library.data ?? [];
      if (list.length > 0)
        await savePart(failures, () =>
          api.skills.setForAgent(
            orgId,
            agent.id,
            list.map((s) => ({ skillId: s.id, enabled: s.defaultForNewAgents })),
          ),
        );
      // The AI the server suggests for me: an account of mine on its computer; the workspace's model needs nothing.
      const ai = proposed?.ai;
      if (ai?.kind === "account") {
        await savePart(failures, async () => {
          await api.sandbox.setTarget(orgId, agent.id, ai.machineId);
          await api.agents.setBrain(orgId, agent.id, { brain: ai.brain, account: ai.accountId });
        });
      }
      // Or the last setup's plan, with its model, effort and the rest; on the API, its context window.
      const plan = thinks.plan;
      if (plan) {
        await savePart(failures, async () => {
          if (plan.machineId) await api.sandbox.setTarget(orgId, agent.id, plan.machineId);
          await api.agents.setBrain(orgId, agent.id, plan.input);
        });
      } else if (thinks.contextTokens !== null) {
        await savePart(failures, () =>
          api.agents.setBrain(orgId, agent.id, { brain: "model", contextTokens: thinks.contextTokens }),
        );
      }
      // My own mailboxes at the level chosen here (every send asks), then its routine, now that it is where it reports.
      for (const [accountId, level] of Object.entries(mailLevels)) {
        if (level === "none") continue;
        await savePart(failures, () =>
          api.mail.setAgent(orgId, agent.id, accountId, {
            level: toMailLevel(level),
            canDelete: false,
            policy: defaultPolicy(),
          }),
        );
      }
      if (from && proposed?.routine && withRoutine)
        await savePart(failures, () => api.agents.proposalRoutine(orgId, from.messageId));
      if (failures.length > 0) toast({ title: t("mobile.newAgent.partly"), icon: "x" });
      else {
        successHaptic();
        // Agentes greets it once when it is next on screen (its row comes in, the others look at it).
        markArrived(agent.id);
        // It joined (a personal workspace has no team to join: it is here, ADR 0159), and what it thinks with, under
        // its face: the one note before its conversation opens.
        const thinksLabel = pickRow ? choiceText(t, pickRow, i18n.language).label : startsOn;
        toast({
          title: isPersonal(org)
            ? t("newAgent.createdTitlePersonal", { name: agent.name })
            : t("mobile.agents.created", { name: agent.name }),
          subtitle: t("mobile.agents.thinksWith", { label: thinksLabel }),
          agentId: agent.id,
          // Its profile one tap away while its conversation opens under the toast.
          action: { label: t("mobile.chat.profile"), onPress: () => router.push(`/agent/${agent.id}`) },
        });
      }
      if (left.current) return;
      if (from) {
        // From its card: the flow's screens go, back to that conversation as it was, Connect over it when it has
        // nothing to think with.
        leaveFlow();
        if (ai?.kind === "none" && !held) openConnectAi({ agentId: agent.id });
        return;
      }
      // It exists either way (Criar again would only find its @ taken): on to its conversation, every screen over the
      // tabs closed on the way. Only a plan the person chose to connect here opens over it; with nothing to think with
      // yet, the conversation's own line says so and connects from there (ADR 0061 §6), so nothing jumps in front of
      // its first message.
      void openDm({ agentId: agent.id }).then(() => {
        // On a billing hold nothing connects before the plan.
        if (held) return;
        if (thinks.connect) openConnectAi({ agentId: agent.id, plan: thinks.connect });
      });
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepPage
      subtitle={count}
      bar={
        <Button
          variant="primary"
          wide
          label={t("newAgent.create", { name: name.trim() || shownName })}
          loading={busy}
          onPress={() => void submit()}
        />
      }
    >
      <Locked when={busy}>
        <StepHead title={t("actionCard.agentProposal.review")} />
        {/* Who it is, first row: a tap opens its name, @ and look, pushed over Revisar. */}
        <GroupedList>
          <GroupedRow
            leading={<AgentAvatar agent={look} size={36} name={shownName} live={false} />}
            label={shownName}
            sub={`@${handle}`}
            chevron
            onPress={() => router.push(changeHref("identity"))}
          />
        </GroupedList>

        {/* Its role: a flow that started past the roles (an example, a proposal) has no step under it to go back to. */}
        <GroupedHeader>{t("newAgent.steps.role.name")}</GroupedHeader>
        <GroupedList>
          <GroupedRow
            label={roleName || t("newAgent.roles.custom.name")}
            chevron
            onPress={() => router.push(changeHref("role"))}
          />
        </GroupedList>

        <GroupedHeader>{t("mobile.agent.does")}</GroupedHeader>
        <GroupedList>
          <GroupedRow
            label={instructions.trim().split("\n")[0] || t("newAgent.onlyContext")}
            chevron
            onPress={() => router.push(changeHref("instructions"))}
          />
        </GroupedList>

        {/* A proposal's AI reads "Thinks with …" itself: no header over it. */}
        {proposed ? (
          <>
            <View style={styles.gap} />
            <GroupedList>
              <GroupedRow icon="brain" label={suggestedAiText(t, proposed.ai)} labelLines={2} />
            </GroupedList>
          </>
        ) : (
          // On a billing hold nothing connects nor thinks before the plan: no choice to make, as on the web.
          !held && (
            <>
              <GroupedHeader>{t("mobile.intentAgents.thinks")}</GroupedHeader>
              {choice && !hub && !hubLoading ? (
                // An older server has no "Contas de IA" to choose from: what it starts on, said.
                <GroupedList>
                  <GroupedRow icon="key" label={startsOn} labelLines={2} />
                  <GroupedRow icon="plus" label={t("aiAccounts.page.connect")} onPress={connect} />
                </GroupedList>
              ) : choice ? (
                <AiChoiceFields
                  target={NEW_AGENT}
                  value={choice}
                  onChange={(next) => editNewAgent({ aiPick: next, optionsBefore: null })}
                  extras={[
                    {
                      option: {
                        key: CONNECT,
                        label: t("aiAccounts.page.connect"),
                        leading: { kind: "icon", name: "plus" },
                        section: " ",
                      },
                      onPick: connect,
                    },
                  ]}
                />
              ) : (
                <GroupedList>
                  <GroupedRow icon="plus" label={t("aiAccounts.page.connect")} onPress={connect} />
                </GroupedList>
              )}
              {/* On a key or the workspace's model: the plan is the other way, said once. */}
              {!choice || choice.brain === "model" ? (
                <GroupedFooter>{t("mobile.newAgent.planHint", g)}</GroupedFooter>
              ) : null}
            </>
          )
        )}

        <GroupedHeader>{t("newAgent.preview.uses")}</GroupedHeader>
        <GroupedList>
          {listedApps.map((i) => {
            const level = levels[i.id] ?? "none";
            const app = itemName(t, i);
            return (
              <GroupedRow
                key={i.id}
                leading={<ConnectorIcon def={i.def} image={i.image} label={app} size={32} />}
                label={app}
                {...(i.account ? { sub: i.account } : {})}
                value={
                  proposed
                    ? t(`access.level.${level}`)
                    : t(`mobile.intentAgents.uses.level.${level === "write" ? "write" : "read"}`)
                }
                {...(proposed
                  ? {
                      // Chosen in place (the app's picker), not on a screen: the value's up-down mark.
                      menu: true,
                      onPress: () => chooseLevel(app, level, (l) => setProposedLevel(i.id, l)),
                    }
                  : {})}
              />
            );
          })}
          {myMail.map((box) => (
            <GroupedRow
              key={box.accountId}
              icon="mail"
              label={box.address}
              value={t(`access.level.${mailLevels[box.accountId] ?? "none"}`)}
              menu
              onPress={() =>
                chooseLevel(box.address, mailLevels[box.accountId] ?? "none", (l) => setMailLevel(box.accountId, l))
              }
            />
          ))}
          {listedApps.length + myMail.length === 0 ? (
            <GroupedRow
              label={t("newAgent.preview.onlyTalks")}
              faint
              {...(managesAgents
                ? {}
                : {
                    hint: {
                      name: t("common.about", { label: t("newAgent.preview.uses") }),
                      text: t("newAgent.accessAdmins"),
                    },
                  })}
            />
          ) : null}
        </GroupedList>
        <GroupedFooter>{t("newAgent.approvalsNote")}</GroupedFooter>

        {proposed?.routine ? (
          <>
            <GroupedHeader>{t("newAgent.routine")}</GroupedHeader>
            <GroupedList>
              <GroupedRow
                label={`${proposed.routine.name} · ${proposedRoutineWhen(t, i18n.language, proposed.routine)}`}
                labelLines={2}
                toggle={withRoutine}
                onPress={() => editNewAgent((now) => ({ withRoutine: !now.withRoutine }))}
              />
            </GroupedList>
            <GroupedFooter>{proposed.routine.prompt}</GroupedFooter>
          </>
        ) : null}

        <GroupedHeader>{t("newAgent.channelsJoin")}</GroupedHeader>
        <GroupedList>
          {myChannels.map((ch) => (
            <GroupedRow
              key={ch.id}
              label={`#${ch.name}`}
              toggle={channelIds.has(ch.id)}
              onPress={() =>
                editNewAgent((now) => {
                  const nextSet = new Set(now.channelIds);
                  if (nextSet.has(ch.id)) nextSet.delete(ch.id);
                  else nextSet.add(ch.id);
                  return { channelIds: nextSet };
                })
              }
            />
          ))}
        </GroupedList>
        <GroupedFooter>{myChannels.length > 0 ? t("newAgent.channelsHelp") : t("newAgent.noChannels")}</GroupedFooter>
        {from ? (
          // Saying no to the proposal: the page's last row, apart, in red (never a button floating under the list).
          <>
            <View style={styles.gap} />
            <GroupedList>
              <GroupedRow
                icon="x"
                label={t("approval.refuse")}
                danger
                disabled={busy || deny.isPending}
                onPress={refuse}
              />
            </GroupedList>
          </>
        ) : null}
      </Locked>
    </StepPage>
  );
}

/**
 * Bringing agents from another app (`/new-agent/import`), pushed from the first step or from Configurações › Importar
 * e exportar: where they come from. What a read finds opens over it on a screen of its own; back from there, this one.
 */
export function NewAgentImportScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const imp = useAgentImport(orgId);
  useEffect(() => {
    const id = openAgentImport();
    return () => closeAgentImport(id);
  }, []);
  const planned = imp.planned;
  useEffect(() => {
    if (planned) router.push(IMPORT_PREVIEW_HREF);
  }, [planned]);
  return (
    <StepPage>
      <StepHead title={t("shell.importAgents")} lead={t("onboarding.import.lead")} />
      <View style={styles.stack}>
        <ImportPicker imp={imp} orgId={orgId} />
      </View>
    </StepPage>
  );
}

/**
 * What a read found (`/new-agent/import-preview`): the agents and what comes with them, to pick, and the bar's button
 * that brings them. Back drops the plan, to choose another file or reply.
 */
export function NewAgentImportPreviewScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const imp = useAgentImport(orgId);
  const leaveFlow = useLeaveFlow();
  const [busy, setBusy] = useState(false);
  // The person left this screen while the agents came: they arrived, as the toast says, and moving them now would
  // replace wherever they went.
  const left = useRef(false);
  useEffect(() => {
    // Opened with nothing read under it (its address on its own): back where it came from.
    if (!agentImportNow()?.plan) goBack();
    left.current = false;
    return () => {
      left.current = true;
      resetAgentImport();
    };
  }, []);
  const runImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const report = await imp.apply();
      if (!report) return;
      const ids = arrivedAgents(report);
      const counts = reportCounts(report, imp.picks.length);
      // Under Criar agente: its screens go too, without asking.
      finishNewAgent();
      successHaptic();
      const first = report.find((i) => i.kind === "agent" && i.targetId === ids[0]);
      toast({
        title: counts.partial
          ? t("mobile.newAgent.import.partial", counts)
          : ids.length > 0
            ? t("mobile.newAgent.import.arrived", { count: ids.length, name: first?.label ?? "" })
            : t("onboarding.import.report.title"),
        ...(counts.capped > 0 ? { subtitle: t("onboarding.import.report.capped", { count: counts.capped }) } : {}),
        ...(ids.length === 1 ? { agentId: ids[0] } : {}),
      });
      const land = landingOf(ids, { left: left.current });
      if (land?.how === "open") {
        leaveFlow();
        router.push(land.href);
      } else if (land) router.dismissTo(land.href);
    } finally {
      setBusy(false);
    }
  };
  return (
    <StepPage
      bar={
        imp.planned && imp.picks.length > 0 ? (
          <Button
            variant="primary"
            wide
            label={t("onboarding.import.go", { count: imp.picks.length })}
            loading={busy}
            disabled={busy}
            onPress={() => void runImport()}
          />
        ) : null
      }
    >
      <StepHead title={t("shell.importAgents")} lead={t("onboarding.import.lead")} />
      <View style={styles.stack}>
        <ImportPreview imp={imp} orgId={orgId} />
      </View>
    </StepPage>
  );
}

/**
 * A row's tile as big as the roles' faces, so the text of every list on the step starts at the same place: the app's
 * own `Tile` (its corners a third of its side).
 */
function RowTile({ icon }: { icon: IconName }) {
  return <Tile icon={icon} size={36} />;
}

/** The @ field and the look list come back under the name once it is done. */
const REST_IN = FadeIn.duration(200);

/**
 * Three logos fanned in the row's 36-point lead column (`GROUPED_ROW.lead`), the front one whole and the two behind
 * peeking 6 points each: wider, the stack ran out of the card past its left edge and under the title.
 */
const MARK = 24;
const MARK_OVERLAP = 18;
const hasLogo = (card: string): card is keyof typeof IMPORT_LOGO => card in IMPORT_LOGO;

/** Up to three of the apps agents come from, fanned in the lead column, each ringed in the row's colour. */
function ImportMarks() {
  const { colors: c, scheme } = useTheme();
  return (
    <View style={styles.marks} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {importMarkCards(hasLogo).map((card, i) => {
        const logo = IMPORT_LOGO[card];
        return (
          <View
            key={card}
            style={[styles.mark, i > 0 && styles.markAfter, { backgroundColor: c.sunken, borderColor: c.raised }]}
          >
            <Image
              source={scheme === "dark" ? (logo.dark ?? logo.light) : logo.light}
              contentFit="contain"
              style={styles.markLogo}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 32 },
  head: { gap: 2, paddingHorizontal: 4, paddingTop: 10, paddingBottom: 16 },
  stack: { gap: 8 },
  gap: { height: 24 },
  other: { paddingTop: 12 },
  marks: { flexDirection: "row" },
  mark: {
    width: MARK,
    height: MARK,
    borderRadius: MARK / 3,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  markAfter: { marginLeft: -MARK_OVERLAP },
  markLogo: { width: 16, height: 16 },
  foot: { paddingTop: 7, paddingHorizontal: 16 },
  stage: {
    height: 150,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 12,
  },
  field: {
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.tallPadY,
  },
  bare: { borderWidth: 0, borderRadius: 0, backgroundColor: "transparent" },
  restore: { alignItems: "center", columnGap: 16, rowGap: 8, paddingTop: 7, paddingLeft: 16 },
});
