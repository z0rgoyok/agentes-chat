import type { Credential, MachineAccount } from "@agenteschat/client";
import {
  keys,
  useAddCredential,
  useAiAccounts,
  useAiStatus,
  useApi,
  useCredentials,
  useMachines,
  useModels,
} from "@agenteschat/client";
import { accountInLine, listsExisting } from "@agenteschat/client/lib/ai-accounts";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { CUSTOM_PROVIDER } from "@agenteschat/client/lib/endpoints";
import { errorText, keyRefusal } from "@agenteschat/client/lib/errors";
import { namesText, rosterText } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AgentAi,
  type AiChoice,
  ALL_AGENTS,
  agentAi,
  agentPlan,
  aiStateOf,
  allAgents,
  defaultChoice,
  defaultTarget,
  type ExistingSignIn,
  freePlanAccount,
  gateDims,
  kindOf,
  noAiLockedLine,
  type PlanChoice,
  type PlanGate,
  planLabel,
  planMark,
  planOfAccount,
  planTitle,
  signsInOnce,
  signsInPerAgent,
} from "@agenteschat/client/lib/no-ai";
import { can, makesAgents } from "@agenteschat/client/lib/permissions";
import { isPlanId, planOf } from "@agenteschat/client/lib/plans";
import { keyThinks, providerGuess, providerLabel } from "@agenteschat/client/lib/providers";
import {
  isRightHand,
  rightHandOf,
  rightHandOnKey,
  type SavedKey,
  savedKeyLine,
  sceneTeam,
  settleSavedKey,
  thinksWithLine,
} from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  AvatarStack,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  type IconName,
  ProviderLogo,
  SettingNote,
  Spinner,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  AiPicker,
  ExistingRows,
  ExistingThinks,
  type ExistingUsed,
  FaceStrip,
  type KeyDraft,
  KeyPanel,
  KeyUntested,
  PlanAudience,
  PlanPanel,
  type PlanStage,
  PlanWithoutAgent,
  useExistingAi,
  useGatesWithoutAgent,
  usePlanGates,
} from "@/components/ai/ConnectAiSteps";
import { EndpointForm } from "@/components/ai/EndpointForm";
import { PlanHold, usePlanHold } from "@/components/ai/plan-hold";
import { AudienceCard } from "@/components/arrival/AudienceCard";
import { ConnectChoices } from "@/components/arrival/ConnectChoices";
import { bestHave, ConnectHave, haveId } from "@/components/arrival/ConnectHave";
import { ConnectScene, isScenePlan, type SceneAgent, TeamScene, useDawn } from "@/components/arrival/TeamScene";
import { NEW_AGENT_EVENT } from "@/components/new-agent/events";
import type { NewAgentRequest } from "@/components/new-agent/new-agent-context";
import { useOrg } from "@/components/org-context";
import { KeyRefused, ProviderKeySelect } from "@/components/ProviderKey";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";
import "./no-ai.css";
import { type ConnectAiRequest, useConnectAi } from "./connect-ai-context";

export {
  type AnswerState,
  type ConnectAi,
  ConnectAiProvider,
  type ConnectAiRequest,
  useConnectAi,
  useMayConnectAi,
} from "./connect-ai-context";

/*
 * "Conectar uma IA" (ADR 0061): one dialog for every place that says an agent has no AI (the banner, the agent's
 * card, the receipt under a message, its "Sem IA" chip, Settings › Contas de IA). The same picker as the setup's AI
 * step: the plans first (Claude chosen), each signing in on the agent's computer, then the workspace's API key; a
 * message that asked for one of them opens on it. For one agent with no AI, what the person already has comes before
 * them (`ExistingRows`). Connected from a card or a message, the agent then answers it by itself.
 * Opened for one agent the person may connect (their own, or the team's right hand), or for the whole team, it is the
 * narrow dialog under the sky instead (ADR 0160, addendum: `BandDialog`).
 */

/** A chosen plan's steps, named as its maker sells it; the key's, as the picker names it. */
const stepTitle = (t: TFunction, choice: AiChoice) =>
  choice === "key" ? t("connectAi.title.api_key") : planTitle(t, choice);

/**
 * A plain plan panel's title where it is (`PlanStage`): which of the person's accounts the agent (`agent`; none: all of
 * them) will use, or another account to sign in; else the plan's steps (`stepTitle`).
 */
const panelTitle = (t: TFunction, choice: AiChoice, stage: PlanStage | null, agent?: string) => {
  if (choice === "key" || !stage) return stepTitle(t, choice);
  const brand = planLabel(t, choice);
  if (stage.kind === "other") return t("connectAi.which.other", { brand });
  return agent
    ? t("connectAi.which.title", { brand, ...agentGrammar(agent) })
    : t("connectAi.which.titleAll", { brand });
};

/** A footer's note: its icon on the words' first line, the footer's buttons outside it, centred with the line. */
const footNote = (icon: IconName, text: string) => (
  <span className="ac-iconline">
    <Icon name={icon} />
    <span>{text}</span>
  </span>
);

/** The sky over the narrow dialog: who wakes (four drawn, the rest as "+N"), and the AI's mark at the end of a trail. */
interface BandScene {
  agents: readonly SceneAgent[];
  lead?: string;
  awake: boolean;
  day: number;
  more?: number;
  mark?: AiChoice;
  trail?: "walk" | "done";
}

/** How many names a line of who stayed without an AI says before "and N more". */
const NAMES_TEAM = 3;

/** How deep each screen of the narrow dialog is: a deeper one comes in from the end, a shallower one from the start. */
const DEPTH: Record<string, number> = { loading: 0, pick: 0, other: 1, all: 1, agents: 1, steps: 2, used: 3, done: 3 };

/**
 * The narrow dialog under the sky (ADR 0160, addendum), for the conversation's Connect and the team's: the sky with
 * who wakes, the title with the way back on its line, one thing in the middle, a plan's own actions when it has any,
 * and the footer. A screen that changes slides in from the side it comes from, its title with it; no motion for
 * whoever asked for less (arrival.css).
 */
function BandDialog({
  title,
  scene,
  screen,
  onBack,
  onClose,
  actsRef,
  footer,
  children,
}: {
  title: string;
  scene: BandScene;
  /** Which screen it shows (`DEPTH`): a change is what slides. */
  screen: string;
  onBack?: () => void;
  onClose: () => void;
  /** Where a plan's panel puts its own actions: a footer row shown only while it holds any. */
  actsRef?: (el: HTMLElement | null) => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  // The first screen comes with the dialog's own entrance; only a change slides.
  const last = useRef<{ screen: string; dir?: "fwd" | "back" }>({ screen });
  if (last.current.screen !== screen)
    last.current = {
      screen,
      dir: (DEPTH[screen] ?? 0) < (DEPTH[last.current.screen] ?? 0) ? "back" : "fwd",
    };
  const { dir } = last.current;
  const { mark } = scene;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={520}
      bare
      className="arrival arrival-chat"
    >
      <div className="arrival-hero">
        <TeamScene
          agents={scene.agents}
          lead={scene.lead}
          asleep={!scene.awake}
          day={scene.day}
          expression={scene.awake ? "happy" : undefined}
        >
          {scene.more ? <span className="team-scene__more">{`+${scene.more}`}</span> : null}
          {mark && (
            <>
              <span className="team-scene__trail" data-state={scene.trail}>
                {[0, 1, 2, 3, 4].map((n) => (
                  <i key={n} style={{ "--n": n } as CSSProperties} />
                ))}
              </span>
              <span className="team-scene__mark">
                {mark === "key" ? <Icon name="key" /> : <ProviderLogo id={planMark(mark)} size="tile" />}
              </span>
            </>
          )}
        </TeamScene>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      {/* The dialog's name is its hidden title; this is the same sentence, drawn. */}
      <div className="arrival-lede arrival-lede--row">
        {onBack && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="chevronLeft"
            aria-label={t("common.back")}
            onClick={onBack}
          />
        )}
        <p key={screen} className="arrival-lede__title arrival-swap" data-dir={dir} aria-hidden="true">
          {title}
        </p>
      </div>
      <DialogBody>
        <div key={screen} className="arrival-swap" data-dir={dir}>
          {children}
        </div>
      </DialogBody>
      {actsRef && <div className="ac-dialog__foot arrival-chat__acts" ref={actsRef} />}
      {footer}
    </Dialog>
  );
}

export function ConnectAiDialog({
  request,
  poll,
  settingUp,
  onClose,
  onConnected,
  onPairComputer,
}: {
  request: ConnectAiRequest;
  poll: number | false;
  settingUp: boolean;
  onClose: () => void;
  onConnected: (choice: AiChoice) => void;
  /** Connect a computer, in place over this dialog. */
  onPairComputer: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id, true, poll);
  // Another dialog in place of this one: the right hand's own Connect from the team's end.
  const connect = useConnectAi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const add = useAddCredential(org.id, true);
  const api = useApi();
  const toast = useToast();
  const models = useModels();
  // An API key is the organization's (admins); a plan thinks only for its owner's agents (ADR 0059 §3).
  const mayAddKey = can(org, "manage_credentials");
  const hold = usePlanHold();
  // The team's right hand thinks with each person's own AI (ADR 0137 §11): everyone's to connect for their DM.
  const mine = dir.agents.filter((a) => a.ownerUserId === me.user.id || isRightHand(a));
  // An agent's card names whom to choose from. Opened for one agent, it is for that agent alone: the title names it,
  // so no For offers another. Anywhere else every agent of the viewer's stays a choice.
  const named = request.agentIds?.length ? request.agentIds : null;
  // From the agent's conversation: decided once the agents and their AI are known, and kept, since connecting changes
  // both. `others`: more agents of the person's have no AI, so the dialog opens for all of them.
  const machines = useMachines(org.id, true, poll);
  const loaded = !(dir.loading || status.isPending || machines.isPending);
  const machineOf = (id: string) => machines.data?.find((m) => m.agents.some((a) => a.id === id))?.id;
  // A list that names one agent alone and no step (the first-run list with nobody but the right hand, an agent just
  // made) asks for that agent, as `agentId` does. A card that asks for a step (`intent`) keeps the plain dialog, which
  // opens on it.
  const sole = named?.length === 1 && request.intent === undefined ? named[0] : undefined;
  // Any way in that names several agents to choose from, or a step (a key, a plan to sign in to again), keeps the
  // plain dialog.
  const plain =
    (request.agentIds !== undefined && sole === undefined) ||
    request.plan !== undefined ||
    request.apiKey !== undefined ||
    request.forNewAgent === true ||
    request.intent === "api_key";
  const askedId = request.agentId ?? sole;
  const askedFor = askedId && (request.chat || !plain) ? dir.agentById.get(askedId) : undefined;
  const asleep = (id: string) => (aiStateOf(status.data, id) ?? "no_ai") === "no_ai";
  // Past its own screens, Back goes to the dialog it was opened from, when there is one.
  const leave = request.onBack
    ? () => {
        onClose();
        request.onBack?.();
      }
    : undefined;
  // Opened for several agents or none (the channel's notice, Settings › AI accounts, the first-run list, a team just
  // made, a receipt or a card for several agents, the onboarding's AI step): the narrow dialog under the sky, for every
  // agent of the person's that can't think, on the computer of the first of them since a plan signs in on one computer
  // (ADR 0160, addendum). The plain dialog stays for every way in that names one thing or has its own: someone else's
  // agent (locked), a plan to sign in to again (`plan`), a key asked for or pasted, an agent still being made
  // (`forNewAgent`), a billing hold (its notice is the whole dialog), and nobody to wake (no agent of theirs yet, or
  // every one of them already thinks).
  const teamAsk =
    hold === null &&
    !request.arrival &&
    !request.chat &&
    request.plan === undefined &&
    request.apiKey === undefined &&
    !request.forNewAgent &&
    request.intent !== "api_key" &&
    (named ? named.length >= 2 : request.agentId === undefined);
  // The right hand never has a computer (ADR 0137), so it never picks the one a plan signs in on: that is the first
  // other agent's. It wakes with the others and comes last, so neither whom a plan's panel is for nor whose computer
  // it reads is ever the right hand. With nobody else to wake it is one agent alone: the narrow dialog for it.
  const handOf = (id: string) => isRightHand(dir.agentById.get(id));
  // `hand`: the right hand the only one of them still without an AI (the team already thinks), its own dialog then.
  const teamNow = ((): { ids: string[]; hand?: string } => {
    if (!teamAsk) return { ids: [] };
    const ids = (named ?? mine.map((a) => a.id)).filter((id) => mine.some((a) => a.id === id) && asleep(id));
    const lead = ids.find((id) => !handOf(id));
    if (lead === undefined) return { ids: [], hand: ids[0] };
    const where = machineOf(lead) ?? null;
    return {
      ids: [...ids.filter((id) => !handOf(id) && (machineOf(id) ?? null) === where), ...ids.filter((id) => handOf(id))],
    };
  })();
  // The one agent the narrow dialog is for: the one asked for, or the right hand left alone without an AI.
  const askedNow = askedFor ?? (teamNow.hand ? dir.agentById.get(teamNow.hand) : undefined);
  // "All agents" from a conversation: its agent first, then the person's other agents that can't think either, on
  // the same computer (a plan signs in on one computer). The right hand is everyone's to connect (ADR 0137 §11) and
  // has no computer, so it is always for it alone.
  const chatOn = askedNow !== undefined && (askedNow.ownerUserId === me.user.id || isRightHand(askedNow));
  const chatNow = {
    on: chatOn,
    set:
      chatOn && askedNow
        ? [
            askedNow.id,
            ...(isRightHand(askedNow)
              ? []
              : mine
                  .filter(
                    (a) =>
                      a.id !== askedNow.id &&
                      !isRightHand(a) &&
                      asleep(a.id) &&
                      (machineOf(a.id) ?? null) === (machineOf(askedNow.id) ?? null),
                  )
                  .map((a) => a.id)),
          ]
        : [],
  };
  const [chatKept, setChatKept] = useState<typeof chatNow>();
  const [teamKept, setTeamKept] = useState<typeof teamNow>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the agents and their AI load
  useEffect(() => {
    if (!loaded) return;
    setChatKept((kept) => kept ?? chatNow);
    setTeamKept((kept) => kept ?? teamNow);
  }, [loaded]);
  const chat = chatKept ?? chatNow;
  const { ids: teamIds, hand: handAlone } = teamKept ?? teamNow;
  const asked = askedFor ?? (handAlone ? dir.agentById.get(handAlone) : undefined);
  const team = teamAsk && (!loaded || teamIds.length > 0);
  // Whom of them it is for ("Choose": all of them until the person narrows it), the list being edited meanwhile, and
  // each new start for those a round left without an AI ("Connect Lia").
  const [teamPick, setTeamPick] = useState<string[]>();
  const forTeam = teamPick ?? teamIds;
  const [draftPick, setDraftPick] = useState<string[] | null>(null);
  const [round, setRound] = useState(0);
  // The end counts the whole team across those rounds (`whole`, set by the first "Connect Lia"), names why each agent
  // passed over stayed without an AI (its login's reason), and says what they think with: the account signed in.
  const [whole, setWhole] = useState<string[]>();
  const [why, setWhy] = useState<Record<string, string | null>>({});
  const [nobody, setNobody] = useState(false);
  const [thinksWith, setThinksWith] = useState<MachineAccount | null>(null);
  const dom = useId();
  const [scope, setScope] = useState<"all" | "one">();
  const several = chat.set.length >= 2;
  const wide = chat.on && several && scope !== "one";
  const only = team
    ? forTeam.length === 1
      ? forTeam[0]
      : undefined
    : (handAlone ?? (wide ? undefined : named ? (named.length === 1 ? named[0] : undefined) : request.agentId));
  const one = only ? dir.agentById.get(only) : undefined;
  const rightHand = isRightHand(one);
  const pool = request.forNewAgent ? [] : one ? [one.id] : team ? forTeam : wide ? chat.set : named;
  // In the order asked for: the conversation's agent leads "All agents", so its computer is the one a plan signs in on.
  const pooled = pool
    ? pool.flatMap((id) => {
        const a = mine.find((x) => x.id === id);
        return a ? [a] : [];
      })
    : mine;
  const agents = pooled.map((a) => ({
    id: a.id,
    name: a.name,
    appearance: lookOf(a),
    initials: dir.agentInitials(a.id),
  }));
  // Whom a plan signs in for, among other agents: never the right hand, which has no computer (its AI follows the
  // person's), so its missing computer never picks the set or whom the panel is for. Alone, it is its own.
  const others = agents.filter((a) => !handOf(a.id));
  const planAgents = others.length > 0 ? others : agents;
  // The agents a plan or a key was connected for here: they think with it before the AI status says so.
  const [linked, setLinked] = useState<Record<string, AiChoice>>({});
  // From a conversation an agent that can't think has no AI, whatever it is set to (a plan nobody is signed in to):
  // "All agents" on the first screen and in a plan's panel are then the same agents.
  const aiOf = (id: string): AgentAi =>
    linked[id] ?? ((chat.on || team) && asleep(id) ? null : agentAi(dir.agentById.get(id), aiStateOf(status.data, id)));
  const hasAi = (id: string) => aiOf(id) !== null;
  // By the AI status, as its "Sem IA" chip: an agent on a plan whose sign-in is gone has none either.
  const noAi = (id: string) => !linked[id] && (aiStateOf(status.data, id) ?? "no_ai") === "no_ai";
  const accounts = useAiAccounts(org.id);
  const setOf = (c: AiChoice) =>
    c === "key"
      ? []
      : allAgents({
          choice: c,
          agents: planAgents,
          aiOf,
          machineOf,
          sharedOn: (id) =>
            signsInOnce(
              c,
              accounts.data?.computers.find((m) => m.machineId === id),
            ),
        });
  // Only a pick is kept; else whom it's for is worked out on each render (a link opens this before the agents load).
  const [pickedTarget, setPickedTarget] = useState<string>();
  // Held once a sign-in starts (`onStart`): every move it makes gives an agent an AI, which would move the default.
  const [heldReader, setHeldReader] = useState<string>();
  // For all of them, the agent of the conversation is still the one a plan that can't be shared signs in for.
  const aimed = {
    agents: planAgents,
    hasAi,
    // For the team, its plan's panel is for all of them whenever the plan may sign in for more than one.
    picked: pickedTarget ?? (team ? ALL_AGENTS : undefined),
    ...(wide || team ? { host: request.agentId } : { asked: request.agentId }),
  };
  // With no set, the agent whose computer the panel reads, "All agents" too (they're on that one's computer).
  const reader = heldReader ?? defaultTarget({ ...aimed, set: [] });
  const theirs = one !== undefined && one.ownerUserId !== me.user.id && !rightHand;
  // The one agent the dialog is for: what the person already has comes first for it while it has no AI. Who manages
  // it sees the accounts of someone else's agent, locked, and may give it a workspace key (ADR 0041 §4).
  const forId = one?.id ?? (agents.length === 1 ? agents[0]?.id : undefined);
  const mayUseKeys = managesAgent(forId ? dir.agentById.get(forId) : undefined);
  const forAgent = forId ? { id: forId, name: dir.agentById.get(forId)?.name ?? "" } : undefined;
  const gates = usePlanGates(org.id, reader ?? (theirs && mayUseKeys ? one?.id : undefined), poll);
  const credentials = useCredentials(org.id, mayUseKeys && forId !== undefined);
  // No agent of theirs yet, and it isn't opened for someone else's: a plan signs in for the agents they create.
  const bare = agents.length === 0 && !theirs && !named && !team;
  const bareGates = useGatesWithoutAgent(org.id, bare);
  const gateOf = (c: PlanChoice): PlanGate =>
    agents.length > 0 ? gates.gateOf(c) : bare ? bareGates.at(c).gate : { state: "loading" };
  const [used, setUsed] = useState<ExistingUsed | null>(null);
  const [login, setLogin] = useState<ExistingSignIn | null>(null);
  // Where a plain plan panel is (its list of the person's accounts, or another sign-in): the title asks it.
  const [planStage, setPlanStage] = useState<PlanStage | null>(null);
  const [picked, setPicked] = useState<AiChoice | null>(request.start ?? null);
  const choice =
    picked ??
    request.plan ??
    defaultChoice({
      intent: request.intent,
      // With no agent in the workspace, a plan helps as much as a key: Claude first, as everywhere.
      ownsAgents: agents.length > 0 || dir.agents.length === 0 || request.forNewAgent === true,
      mayAddKey,
      claudeGate: gateOf("claude"),
      // Signing in on Claude's panel would move a Codex agent onto Claude Code: one agent opens on its own plan.
      plan: agentPlan(one),
    });
  const all = setOf(choice).map((a) => ({ ...a, done: aiOf(a.id) === choice }));
  const target = defaultTarget({ ...aimed, set: all });
  const [draft, setDraft] = useState<KeyDraft>(() => ({
    provider: request.provider === CUSTOM_PROVIDER ? CUSTOM_PROVIDER : providerGuess(request.apiKey, request.provider),
    apiKey: request.apiKey ?? "",
  }));
  // Anything connected shows Done; only a saved key closes the key's field (after a plan, it's for the other agents).
  const [connected, setConnected] = useState(false);
  // The arrival's stage: never over a billing hold, whose notice is the whole dialog.
  const stage = request.arrival === true && !hold;
  // Its first screen is the cards; a pick moves on to that plan's steps, and Back returns to the cards.
  // A card already picked (`start`, for the team or for one agent) opens on its steps; for the team, a message that
  // asked for Claude or ChatGPT too.
  const [chosen, setChosen] = useState(
    request.start !== undefined
      ? teamAsk || (request.agentId !== undefined && !plain)
      : teamAsk && (request.intent === "claude" || request.intent === "chatgpt"),
  );
  // From a conversation: the sky as a band over a narrow dialog.
  const band = chat.on && !hold;
  // An account picked for every agent: its plan's panel uses it at once.
  const [use, setUse] = useState<MachineAccount>();
  // What the person already has: the row picked (the best one until they pick), or the choices of a new one instead.
  const [haveSel, setHaveSel] = useState<string>();
  const [adding, setAdding] = useState(false);
  // Many accounts: the list of every one, under its search.
  const [allOpen, setAllOpen] = useState(false);
  // Where a plan's panel puts its own two actions (an account to use, another sign-in): the dialog's footer.
  const [footAt, setFootAt] = useState<HTMLElement | null>(null);
  const day = useDawn((stage || band || team) && connected);
  const [keySaved, setKeySaved] = useState(false);
  const [keyNote, setKeyNote] = useState<string>();
  const [refused, setRefused] = useState<ReturnType<typeof keyRefusal>>(null);
  // `connectedNow`: what was connected, when it isn't the choice on screen (an account the person already had).
  const done = (connectedNow: AiChoice = choice) => {
    setConnected(true);
    void qc.invalidateQueries({ queryKey: keys.aiStatus(org.id) });
    // What "Quem pensa" lists (a new agent's step, an agent's page): the plan's models there are ready now.
    void qc.invalidateQueries({ queryKey: keys.brainMachines(org.id) });
    onConnected(connectedNow);
  };
  // The right hand among the agents it was opened for (one, or the whole team with no AI yet): the key becomes the
  // workspace's AI, so its DM answers with it too.
  const hand = rightHand
    ? one
    : (team ? forTeam : named)?.flatMap((id) => {
        const a = dir.agentById.get(id);
        return a && isRightHand(a) && noAi(a.id) ? [a] : [];
      })[0];
  // The one agent the dialog is for, the right hand aside: a key saved here goes on it. Else it is for every agent.
  const keyAgent = one && !hand ? one : undefined;
  const [savedKey, setSavedKey] = useState<{ key: Credential; outcome: SavedKey }>();
  const [makingDefault, setMakingDefault] = useState(false);
  const settleKey = async (key: Credential) => {
    try {
      const agent = keyAgent && { ...keyAgent, brain: keyAgent.brain?.kind };
      const outcome = await settleSavedKey(api, org.id, key, agent, models.data?.models ?? []);
      setSavedKey({ key, outcome });
      if (keyAgent) {
        void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
        void qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, keyAgent.id) });
      }
      if (outcome.kind === "made") void qc.invalidateQueries({ queryKey: keys.settings(org.id) });
    } catch (error) {
      toast.show(errorText(t, error), "error");
    }
  };
  const keyForAll = async (key: Credential) => {
    setMakingDefault(true);
    try {
      await api.agents.makeDefaultCredential(org.id, key.id);
      setSavedKey({ key, outcome: { kind: "all" } });
      void qc.invalidateQueries({ queryKey: keys.settings(org.id) });
      void qc.invalidateQueries({ queryKey: keys.aiStatus(org.id) });
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setMakingDefault(false);
    }
  };
  const savedLine = savedKey ? (
    keyThinks(savedKey.key) ? (
      <SettingNote
        icon="check"
        live
        action={
          savedKey.outcome.kind === "other" && (
            <Button loading={makingDefault} disabled={makingDefault} onClick={() => void keyForAll(savedKey.key)}>
              {t("connectAi.key.useForAll")}
            </Button>
          )
        }
      >
        {savedKey.key.reused && `${t("settings.keyResaved")} `}
        {keyNote ?? savedKeyLine(t, savedKey.outcome, savedKey.key)}
      </SettingNote>
    ) : (
      <KeyUntested cred={savedKey.key} onTested={(key) => setSavedKey({ ...savedKey, key })} />
    )
  ) : (
    keyNote && (
      <SettingNote icon="check" live>
        {keyNote}
      </SettingNote>
    )
  );
  const saveKey = () => {
    if (draft.provider === CUSTOM_PROVIDER) return;
    setRefused(null);
    const provider = providerLabel(draft.provider);
    add.mutate(
      { provider: draft.provider, label: provider, apiKey: draft.apiKey.trim() },
      {
        onError: (error) => {
          setRefused(keyRefusal(t, error));
          if (!keyRefusal(t, error)) toast.show(errorText(t, error), "error");
        },
        onSuccess: async (key) => {
          // The right hand asked for a key ("Usar uma chave de API"): the workspace's AI from now on, and the person's
          // own DM goes back to it.
          let moved = false;
          if (hand) {
            moved = await rightHandOnKey(api, org.id, hand, key, models.data?.models ?? []).then(
              () => true,
              (error) => {
                toast.show(errorText(t, error), "error");
                return false;
              },
            );
            void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
            void qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, hand.id) });
          }
          const note =
            key.check === "unchecked"
              ? t("connectAi.key.savedUnchecked", { provider })
              : moved && hand
                ? thinksWithLine(t, "workspace", hand.name, key.label)
                : undefined;
          // With no saved key's own line (the right hand's), the note says the key was already there.
          setKeyNote(hand && key.reused ? [t("settings.keyResaved"), note].filter(Boolean).join(" ") : note);
          if (!hand) await settleKey(key);
          setKeySaved(true);
          done();
        },
      },
    );
  };

  // Someone else's agent, or no agent of theirs among those: who connects a plan instead.
  const owner = one?.ownerUserId ? dir.memberById.get(one.ownerUserId)?.name : undefined;
  const locked = theirs
    ? noAiLockedLine(t, one.name, owner)
    : named && agents.length === 0
      ? t("noAi.lockedAdmins")
      : undefined;
  // Over a draft a Settings page opens in a new tab: the draft behind this dialog stays.
  const toSettings = (section: "usage") => {
    if (request.forNewAgent || request.overDraft) {
      window.open(`/org/${org.id}/settings/${section}`, "_blank", "noopener");
      return;
    }
    onClose();
    void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section } });
  };
  const toComputers = settingUp ? undefined : onPairComputer;
  const keySelect = mayAddKey && !keySaved && (
    <ProviderKeySelect
      value={draft.provider}
      disabled={add.isPending}
      onChange={(provider) => setDraft((d) => ({ ...d, provider }))}
    />
  );
  const panel =
    choice === "key" ? (
      <KeyPanel
        draft={draft}
        onDraft={setDraft}
        locked={!mayAddKey}
        saved={keySaved}
        savedNote={savedLine || undefined}
        {...(keyAgent ? { forLine: t("connectAi.key.forAgent", { agent: keyAgent.name }) } : {})}
        refused={refused}
        saving={add.isPending}
        onSave={saveKey}
        endpoint={
          <EndpointForm
            orgId={org.id}
            onDone={async (key) => {
              await settleKey(key);
              setKeySaved(true);
              done();
            }}
          />
        }
      />
    ) : bare ? (
      <PlanWithoutAgent
        key={choice}
        choice={choice}
        gates={bareGates}
        mayAddKey={mayAddKey}
        onKey={() => setPicked("key")}
        onComputer={toComputers}
        onDone={() => {
          void qc.invalidateQueries({ queryKey: keys.aiAccounts(org.id) });
          done();
        }}
      />
    ) : (
      <PlanPanel
        key={`${choice}:${round}`}
        choice={choice}
        gates={gates}
        justReady={request.ready}
        agents={planAgents}
        all={all}
        target={target}
        onTarget={(next) => {
          setPickedTarget(next);
          setHeldReader(undefined);
        }}
        onStart={() => {
          setPickedTarget(target);
          setHeldReader(reader);
        }}
        locked={locked}
        {...(login?.choice === choice ? { login } : {})}
        {...(use && planOfAccount(use) === choice ? { use } : {})}
        plain={band || team}
        actionsAt={footAt}
        onStage={setPlanStage}
        onKey={() => {
          setPicked("key");
          setLogin(null);
        }}
        onComputer={toComputers}
        {...(team
          ? {
              // Any agent may be passed over, the last too; the end then says why it stayed without an AI.
              onSkip: (id: string, reason: string | null) => setWhy((w) => ({ ...w, [id]: reason })),
            }
          : {})}
        onDone={(ids, account) => {
          // Every agent of the round passed over: the end says nobody woke, with no dawn and nothing answered.
          if (ids.length === 0) return setNobody(true);
          // The panel stays on whom it was for, saying it's done.
          setPickedTarget(target);
          setLinked((l) => ({ ...l, ...Object.fromEntries(ids.map((id) => [id, choice])) }));
          if (account) setThinksWith(account);
          done();
        }}
      />
    );
  const freeDone = bare && choice !== "key" && freePlanAccount(bareGates.accounts, choice);
  // That plan's next step is an agent that thinks with it, for whoever may make one (never over one being made).
  const makeWith = freeDone && !request.forNewAgent && !settingUp && makesAgents(org) ? freeDone : undefined;
  const doneFooter = (
    <DialogFooter>
      <Button variant={makeWith ? "default" : "primary"} onClick={onClose}>
        {t("connectAi.done")}
      </Button>
      {makeWith && (
        <Button
          variant="primary"
          onClick={() => {
            onClose();
            const detail: NewAgentRequest = { accountId: makeWith.id };
            window.dispatchEvent(new CustomEvent(NEW_AGENT_EVENT, { detail }));
          }}
        >
          {t("connectAi.makeAgent")}
        </Button>
      )}
    </DialogFooter>
  );
  // What the person already has is read for the agent whose computer the panel reads (the team's first).
  const askedAgent = agents.find((a) => a.id === (team ? reader : asked?.id)) ?? { id: "", name: "" };
  const have = useExistingAi({
    gates,
    agent: askedAgent,
    credentials: credentials.data ?? [],
    withOwn: true,
    onUsed: (id, next) => {
      setLinked((l) => ({ ...l, [id]: next.choice }));
      setUsed(next);
      done(next.choice);
    },
  });
  if (team) {
    // For the whole team (ADR 0160, addendum): which AI under one line saying for whom, whom of them, then the plan's
    // steps (one login per agent in turn where it can't share one sign-in there), and who woke.
    const ready = loaded;
    const dims = (c: PlanChoice) => agents.length > 0 && gateDims(gateOf(c));
    // Only what thinks for all of them at once: the person's own accounts there, signed in, shared with all their agents.
    const rows = (have.rows ?? []).filter(
      (r) =>
        r.kind === "account" &&
        r.act === "use" &&
        r.choice.login.shared === true &&
        r.choice.login.mine &&
        r.choice.login.status === "active",
    );
    const choosing = draftPick !== null;
    const pickDraft = draftPick ?? [];
    const picking = ready && !chosen && rows.length > 0 && !adding && !choosing;
    const selected = picking ? rows.find((r) => haveId(r) === (haveSel ?? bestHave(rows, dims))) : undefined;
    const account = selected?.kind === "account" ? selected.choice.login : undefined;
    const pick = (next: AiChoice, a?: MachineAccount) => {
      setPicked(next);
      setLogin(null);
      setUse(a);
      setChosen(true);
      if (next !== choice) setHeldReader(undefined);
    };
    const listing = picking && allOpen;
    const rowsOf = (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const a = dir.agentById.get(id);
        return a ? [a] : [];
      });
    const faces = (ids: readonly string[]) =>
      rowsOf(ids).map((a) => ({ id: a.id, name: a.name, appearance: lookOf(a), initials: dir.agentInitials(a.id) }));
    const nameOf = (id: string | undefined) => (id ? (dir.agentById.get(id)?.name ?? "") : "");
    // The whole team, across "Connect Lia" rounds. An agent woke once a plan was connected for it here or the AI
    // status says it thinks; the right hand only by the status (read again as a round ends), since a plan's steps
    // never sign in for it.
    const everyone = whole ?? forTeam;
    const awoke = (id: string) => !asleep(id) || (!handOf(id) && linked[id] !== undefined);
    const woke = everyone.filter(awoke);
    const stayed = everyone.filter((id) => !awoke(id));
    // Those a round may go again for, and the right hand left without an AI, which has its own Connect.
    const left = stayed.filter((id) => !handOf(id));
    const handLeft = stayed.find(handOf);
    const thinking = woke.filter((id) => !handOf(id));
    // Done with a plan: who woke, who didn't and why, and whom they answer; or nobody, every agent passed over. A key's
    // own panel says it is saved.
    const finished = choice !== "key" && (nobody || (connected && woke.length > 0));
    // On a plan's steps: an end (nobody woke too) has no way back to them, and no trail still walking.
    const stepping = chosen && !connected && !finished;
    // A personal workspace has no team (ADR 0159): its agents, in its own words.
    const personal = isPersonal(org);
    // What they think with: the account signed in, else the plan's name.
    // "o seu {{plan}}": the name its owner gave it, else the plan's.
    const plan = choice === "key" ? "" : thinksWith?.named === true ? thinksWith.label : planLabel(t, choice);
    const screen = !ready
      ? "loading"
      : choosing
        ? "agents"
        : finished
          ? "done"
          : chosen
            ? "steps"
            : listing
              ? "all"
              : adding && rows.length > 0
                ? "other"
                : "pick";
    const title =
      screen === "agents"
        ? t("connectAi.team.pickTitle")
        : finished
          ? woke.length === 0
            ? t("connectAi.team.wokeNone")
            : stayed.length === 0 && everyone.length > 1
              ? t(personal ? "connectAi.team.wokeAllPersonal" : "connectAi.team.wokeAll")
              : t("connectAi.team.woke", { count: woke.length })
          : chosen
            ? panelTitle(t, choice, planStage)
            : listing
              ? t("connectAi.chat.allTitle")
              : adding && rows.length > 0
                ? t("connectAi.chat.other")
                : t(personal ? "connectAi.team.titlePersonal" : "connectAi.team.title");
    const back = choosing || stepping || listing || (adding && rows.length > 0 && !chosen);
    // The sky shows whom it is for: the list as it is being ticked, then those who woke.
    const cast = rowsOf(
      choosing ? teamIds.filter((id) => pickDraft.includes(id)) : finished && woke.length > 0 ? woke : forTeam,
    );
    const drawn = sceneTeam(
      cast,
      cast.find((a) => isRightHand(a)),
    );
    const mark = chosen ? choice : account ? planOfAccount(account) : undefined;
    // A plan that will ask for one login per agent on their computer says so on its card (ADR 0059 §2).
    const computer = accounts.data?.computers.find((m) => m.machineId === machineOf(planAgents[0]?.id ?? ""));
    const perAgent = (c: PlanChoice) =>
      planAgents.length >= 2 && !isPlanId(c) && signsInPerAgent(c) && !signsInOnce(c, computer);
    const applyPick = () => {
      const kept = teamIds.filter((id) => pickDraft.includes(id));
      // The right hand alone is one agent alone: its own Connect, as anywhere else.
      const [first] = kept;
      if (first !== undefined && kept.every(handOf)) return connect?.open({ agentId: first });
      setTeamPick(kept);
      setDraftPick(null);
      setHaveSel(undefined);
      setPickedTarget(undefined);
      setHeldReader(undefined);
    };
    // Those a round left without an AI: the same plan's steps again, for them alone. The right hand left alone without
    // one opens its own Connect instead.
    const again = () => {
      if (left.length === 0) {
        if (handLeft) connect?.open({ agentId: handLeft });
        return;
      }
      setWhole(everyone);
      setTeamPick(left);
      setNobody(false);
      setConnected(false);
      setChosen(true);
      setUse(undefined);
      setLogin(null);
      setPickedTarget(undefined);
      setHeldReader(undefined);
      setRound((n) => n + 1);
    };
    const note = (text: string) => (
      <span className="ac-iconline">
        <Icon name="info" />
        <span>{text}</span>
      </span>
    );
    const shown = rowsOf(forTeam);
    return (
      <BandDialog
        title={title}
        screen={screen}
        onClose={onClose}
        onBack={
          back
            ? () => {
                if (choosing) setDraftPick(null);
                else if (chosen && planStage?.back) planStage.back();
                else if (chosen) {
                  setChosen(false);
                  setLogin(null);
                  setUse(undefined);
                } else if (listing) setAllOpen(false);
                else setAdding(false);
              }
            : leave
        }
        scene={{
          agents: drawn,
          lead: cast.find((a) => isRightHand(a))?.id,
          awake: connected || (finished && woke.length > 0),
          day,
          more: cast.length - drawn.length,
          mark,
          trail: connected ? "done" : stepping ? "walk" : undefined,
        }}
        actsRef={stepping ? setFootAt : undefined}
        footer={
          choosing ? (
            <DialogFooter note={note(t("connectAi.team.marked", { n: pickDraft.length, total: teamIds.length }))}>
              <Button variant="primary" disabled={pickDraft.length === 0} onClick={applyPick}>
                {t("connectAi.team.useThese", { count: pickDraft.length })}
              </Button>
            </DialogFooter>
          ) : finished ? (
            <DialogFooter>
              {(left.length > 0 || handLeft) && (
                <Button onClick={again}>
                  {left.length === 0 || left.length === 1
                    ? t("connectAi.team.again", agentGrammar(nameOf(left[0] ?? handLeft)))
                    : t("connectAi.team.againMany", { n: left.length })}
                </Button>
              )}
              <Button variant="primary" onClick={onClose}>
                {t("connectAi.done")}
              </Button>
            </DialogFooter>
          ) : connected ? (
            <DialogFooter>
              <Button variant="primary" onClick={onClose}>
                {t("connectAi.done")}
              </Button>
            </DialogFooter>
          ) : picking && selected && account ? (
            <DialogFooter>
              <Button variant="primary" onClick={() => pick(planOfAccount(account), account)}>
                {t("connectAi.use", { label: accountInLine(t, account) })}
              </Button>
            </DialogFooter>
          ) : (
            !chosen && (
              <DialogFooter note={note(t("arrival.connect.without"))}>
                <Button variant="ghost" onClick={onClose}>
                  {t("arrival.connect.later")}
                </Button>
              </DialogFooter>
            )
          )
        }
      >
        {!ready ? (
          <Spinner />
        ) : choosing ? (
          // Long names whole, wrapping on their row; the list scrolls inside the dialog. Named as its title asks (whom
          // it is for), not as the agents a plan already serves.
          // biome-ignore lint/a11y/useSemanticElements: a list of checkboxes, not a native fieldset
          <div className="arrival-picks" role="group" aria-label={t("connectAi.team.pickTitle")}>
            {rowsOf(teamIds).map((a) => {
              const on = pickDraft.includes(a.id);
              return (
                <label key={a.id} htmlFor={`${dom}-${a.id}`} className="arrival-pick ac-iconline" data-checked={on}>
                  <Checkbox
                    id={`${dom}-${a.id}`}
                    checked={on}
                    onCheckedChange={(next) =>
                      setDraftPick((d) => (d === null ? d : next ? [...d, a.id] : d.filter((id) => id !== a.id)))
                    }
                  />
                  <AgentAvatar name={a.name} initials={dir.agentInitials(a.id)} appearance={lookOf(a)} size="sm" />
                  <span className="arrival-pick__name">{a.name}</span>
                </label>
              );
            })}
          </div>
        ) : finished ? (
          <div className="ai-turn" role="status">
            {thinking.length > 0 && (
              <p className="ai-turn__title">
                {thinking.length === 1
                  ? t("connectAi.team.thinksOne", { ...agentGrammar(nameOf(thinking[0])), plan })
                  : t("connectAi.team.thinksAll", { plan })}
              </p>
            )}
            {left.length > 0 && (
              <span className="ai-turn__help">
                {left.length === 1
                  ? t("connectAi.team.stayed", agentGrammar(nameOf(left[0])))
                  : t("connectAi.team.stayedMany", {
                      names: namesText(t, left.map(nameOf), NAMES_TEAM),
                    })}
              </span>
            )}
            {/* Each one's own reason, as its login said it when it was passed over. */}
            {left.flatMap((id) => {
              const reason = why[id];
              return reason
                ? [
                    <span key={id} className="ai-turn__help">
                      {t("connectAi.team.why", { name: nameOf(id), why: reason })}
                    </span>,
                  ]
                : [];
            })}
            {handLeft && (
              <span className="ai-turn__help">{t("connectAi.team.stayedHand", agentGrammar(nameOf(handLeft)))}</span>
            )}
            {everyone.length > 1 && (
              <FaceStrip agents={faces(everyone)} stateOf={(a) => (awoke(a.id) ? "done" : "failed")} />
            )}
            {/* Whom they answer, on the plan just connected (its seat's own words): the team's right hand serves each
                person alone. A plan only: `finished` is never true for a key, which has no subscription to answer on. */}
            <PlanAudience
              agents={faces(thinking)}
              brain={kindOf(choice)}
              plan={thinksWith?.plan ?? null}
              coding={planOf(choice)}
            />
          </div>
        ) : chosen ? (
          <div className="arrival-main__steps">
            {choice === "key" && keySelect}
            {panel}
          </div>
        ) : (
          <div className="arrival-main__pick">
            {!listing && (
              <div className="arrival-forline">
                <AvatarStack>
                  {shown.slice(0, 5).map((a) => (
                    <AgentAvatar
                      key={a.id}
                      name={a.name}
                      initials={dir.agentInitials(a.id)}
                      appearance={lookOf(a)}
                      size="xs"
                    />
                  ))}
                </AvatarStack>
                <b>
                  {forTeam.length === teamIds.length
                    ? t("connectAi.team.asleep", { count: teamIds.length })
                    : t("connectAi.team.asleepSome", { n: forTeam.length, total: teamIds.length })}
                </b>
                {teamIds.length >= 2 && (
                  <button type="button" className="ac-link arrival-forline__pick" onClick={() => setDraftPick(forTeam)}>
                    {t("connectAi.team.choose")}
                  </button>
                )}
              </div>
            )}
            {picking ? (
              <>
                <ConnectHave
                  rows={rows}
                  agentName={askedAgent.name}
                  value={selected ? haveId(selected) : undefined}
                  onChange={setHaveSel}
                  dims={dims}
                  all={listing}
                  onAll={() => setAllOpen(true)}
                />
                {!listing && (
                  <button
                    type="button"
                    className="arrival-have__link arrival-have__link--other"
                    onClick={() => setAdding(true)}
                  >
                    <Icon name="plus" size={16} />
                    <span>{t("connectAi.chat.other")}</span>
                    <Icon name="chevronRight" size={16} />
                  </button>
                )}
              </>
            ) : (
              <ConnectChoices mayAddKey={mayAddKey} dims={dims} perAgent={perAgent} onPick={(next) => pick(next)} />
            )}
          </div>
        )}
      </BandDialog>
    );
  }
  if (band && asked) {
    const ready = loaded;
    const stepping = chosen && !connected;
    const dims = (c: PlanChoice) => (agents.length > 0 || bare) && gateDims(gateOf(c));
    // For every agent, only what thinks for all of its owner's agents there; for this one, everything it may use.
    const rows = (have.rows ?? []).filter(
      (r) => !wide || (r.kind === "account" && r.act === "use" && r.choice.login.shared === true),
    );
    const picking = ready && !chosen && !used && rows.length > 0 && !adding;
    const selected = picking ? rows.find((r) => haveId(r) === (haveSel ?? bestHave(rows, dims))) : undefined;
    const account = selected?.kind === "account" ? selected.choice.login : undefined;
    const pick = (next: AiChoice, picked?: MachineAccount) => {
      setPicked(next);
      setLogin(null);
      setUse(picked);
      setChosen(true);
      // Whom it is for stays as it was chosen, whatever connecting changes.
      setScope(wide ? "all" : "one");
      if (next !== choice) setHeldReader(undefined);
    };
    const confirm = () => {
      if (!selected) return;
      setScope(wide ? "all" : "one");
      if (selected.kind === "key") return void have.pickKey(selected.key);
      const a = selected.choice.login;
      if (wide) return pick(planOfAccount(a), a);
      if (selected.act === "use" || selected.act === "move") return void have.pickAccount(a, selected.act === "move");
      // One more sign-in of that account, for this agent: its plan's steps.
      setLogin({
        choice: planOfAccount(a),
        from: a.id,
        email: a.email,
        ...(selected.act === "again" ? { again: a.id } : {}),
      });
      setPicked(planOfAccount(a));
      setPickedTarget(asked.id);
      setChosen(true);
    };
    const listing = picking && allOpen;
    const title = chosen
      ? panelTitle(t, choice, planStage, wide ? undefined : asked.name)
      : listing
        ? t("connectAi.chat.allTitle")
        : adding && rows.length > 0
          ? t("connectAi.chat.other")
          : wide
            ? t("arrival.connect.title")
            : t("connectAi.titleFor", agentGrammar(asked.name));
    const mark = chosen ? choice : account ? planOfAccount(account) : selected?.kind === "key" ? "key" : undefined;
    // Someone else's plan: its owner hears of it and may take it back.
    const lends = account !== undefined && !account.mine && account.ownerId !== asked.ownerUserId;
    const back = stepping || listing || (adding && rows.length > 0 && !chosen && !used);
    const screen = !ready
      ? "loading"
      : used && !chosen
        ? "used"
        : chosen
          ? "steps"
          : listing
            ? "all"
            : adding && rows.length > 0
              ? "other"
              : "pick";
    return (
      <BandDialog
        title={title}
        screen={screen}
        onClose={onClose}
        onBack={
          back
            ? () => {
                if (chosen && planStage?.back) planStage.back();
                else if (chosen) {
                  setChosen(false);
                  setLogin(null);
                  setUse(undefined);
                } else if (listing) setAllOpen(false);
                else setAdding(false);
              }
            : leave
        }
        scene={{
          agents: wide
            ? sceneTeam(
                mine.filter((a) => chat.set.includes(a.id)),
                asked,
              )
            : [asked],
          lead: asked.id,
          awake: connected,
          day,
          mark,
          trail: connected ? "done" : chosen ? "walk" : undefined,
        }}
        // A plan's own actions, when it has any: the footer shows only while it holds them.
        actsRef={stepping ? setFootAt : undefined}
        footer={
          connected || (chosen && freeDone) ? (
            doneFooter
          ) : picking && selected ? (
            <DialogFooter
              note={
                lends
                  ? footNote("mail", t("connectAi.chat.told", { name: account?.ownerName?.split(" ")[0] ?? "" }))
                  : undefined
              }
            >
              <Button variant="primary" loading={have.busy} disabled={have.busy} onClick={confirm}>
                {t("connectAi.use", {
                  label: account ? accountInLine(t, account) : selected.kind === "key" ? selected.key.label : "",
                })}
              </Button>
            </DialogFooter>
          ) : (
            !chosen && (
              <DialogFooter note={footNote("info", t("arrival.connect.without"))}>
                <Button variant="ghost" onClick={onClose}>
                  {t("arrival.connect.later")}
                </Button>
              </DialogFooter>
            )
          )
        }
      >
        {!ready ? (
          <Spinner />
        ) : used && !chosen ? (
          <ExistingThinks agent={askedAgent} used={used} />
        ) : chosen ? (
          <div className="arrival-main__steps">
            {choice === "key" && keySelect}
            {panel}
          </div>
        ) : (
          <div className="arrival-main__pick">
            {several &&
              !listing &&
              (() => {
                // Whom it is for, as two cards with their faces: everyone who can't think, or this agent alone. The
                // sky above follows the pick.
                const everyone = chat.set.flatMap((id) => {
                  const a = dir.agentById.get(id);
                  return a ? [a] : [];
                });
                const face = (a: (typeof everyone)[number]) => (
                  <AgentAvatar
                    key={a.id}
                    name={a.name}
                    initials={dir.agentInitials(a.id)}
                    appearance={lookOf(a)}
                    size="sm"
                  />
                );
                const choose = (next: "all" | "one") => {
                  setScope(next);
                  setHaveSel(undefined);
                };
                return (
                  // biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset
                  <div className="arrival-for" role="group" aria-label={t("connectAi.agentAria")}>
                    <AudienceCard
                      pressed={wide}
                      onClick={() => choose("all")}
                      faces={<AvatarStack>{everyone.slice(0, 4).map(face)}</AvatarStack>}
                      title={t("connectAi.all")}
                      tip={rosterText(t, everyone)}
                    />
                    <AudienceCard
                      pressed={!wide}
                      onClick={() => choose("one")}
                      faces={face(asked)}
                      title={asked.name}
                      tip={asked.role || undefined}
                    />
                  </div>
                );
              })()}
            {picking ? (
              <>
                <ConnectHave
                  rows={rows}
                  agentName={asked.name}
                  value={selected ? haveId(selected) : undefined}
                  onChange={setHaveSel}
                  dims={dims}
                  all={listing}
                  onAll={() => setAllOpen(true)}
                  disabled={have.busy}
                />
                {have.refused && <KeyRefused refusal={have.refused} />}
                {!listing && (
                  <button
                    type="button"
                    className="arrival-have__link arrival-have__link--other"
                    onClick={() => setAdding(true)}
                  >
                    <Icon name="plus" size={16} />
                    <span>{t("connectAi.chat.other")}</span>
                    <Icon name="chevronRight" size={16} />
                  </button>
                )}
              </>
            ) : (
              <ConnectChoices mayAddKey={mayAddKey} dims={dims} onPick={(next) => pick(next)} />
            )}
          </div>
        )}
      </BandDialog>
    );
  }
  if (stage) {
    const ready = !(dir.loading || status.isPending);
    const lead = rightHandOf(dir.agents);
    const stepping = chosen && !connected;
    const without = (
      <span className="ac-iconline">
        <Icon name="info" />
        <span>{t("arrival.connect.without")}</span>
      </span>
    );
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={chosen ? stepTitle(t, choice) : t("arrival.connect.title")}
        closeLabel={t("common.close")}
        width={820}
        bare
        className="arrival arrival-connect"
      >
        <div className="arrival-stage">
          <TeamScene
            shape="tall"
            quiet={0.22}
            agents={sceneTeam(dir.agents, lead)}
            lead={lead?.id}
            asleep={!connected}
            day={day}
            expression={connected ? "happy" : undefined}
          >
            {chosen && (
              <>
                <span className="team-scene__trail" data-state={connected ? "done" : "walk"}>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <i key={n} style={{ "--n": n } as CSSProperties} />
                  ))}
                </span>
                <span className="team-scene__mark">
                  {choice === "key" ? <Icon name="key" /> : <ProviderLogo id={planMark(choice)} size="tile" />}
                </span>
              </>
            )}
          </TeamScene>
          <div className="arrival-stage__cap">
            <b>{t(connected ? "arrival.stage.morning" : "arrival.stage.ready")}</b>
            <span>{t(connected ? "arrival.stage.awake" : "arrival.stage.wake")}</span>
          </div>
        </div>
        <div className="arrival-main">
          {/* The kit's dialog head (Dialog.tsx), in the column beside the stage. */}
          <div className="ac-dialog__head">
            {stepping && (
              <span className="ac-dialog__lead">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="chevronLeft"
                  aria-label={t("common.back")}
                  onClick={() => {
                    setChosen(false);
                    setLogin(null);
                  }}
                />
              </span>
            )}
            <div className="ac-actline">
              <span className="ac-dialog__title" aria-hidden="true">
                {chosen ? stepTitle(t, choice) : t("arrival.connect.title")}
              </span>
            </div>
            <span className="ac-dialog__close ac-acts">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="close"
                className="ac-btn--glyph"
                aria-label={t("common.close")}
                onClick={onClose}
              />
            </span>
          </div>
          {!chosen && <p className="ac-dialog__desc">{t("arrival.connect.text")}</p>}
          <DialogBody>
            {!ready ? (
              <Spinner />
            ) : chosen ? (
              <div className="arrival-main__steps">
                {choice === "key" && keySelect}
                {panel}
              </div>
            ) : (
              <ConnectChoices
                mayAddKey={mayAddKey}
                dims={(c) => (agents.length > 0 || bare) && gateDims(gateOf(c))}
                onPick={(next) => {
                  setPicked(next);
                  setLogin(null);
                  setChosen(true);
                  if (next !== choice) setHeldReader(undefined);
                }}
              />
            )}
          </DialogBody>
          {connected || (chosen && freeDone)
            ? doneFooter
            : !chosen && (
                <DialogFooter note={without}>
                  <Button variant="ghost" onClick={onClose}>
                    {t("arrival.connect.later")}
                  </Button>
                </DialogFooter>
              )}
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        one && (theirs || target === one.id)
          ? t("connectAi.titleFor", agentGrammar(one.name))
          : t("connectAi.title.any")
      }
      closeLabel={t("common.close")}
      width={600}
    >
      <DialogBody>
        <ConnectScene
          agents={dir.agents}
          connected={connected}
          waiting={Boolean(hold)}
          lit={isScenePlan(picked) ? picked : null}
        />
        {/* A link opens this before the agents and their AI load, and what it opens on follows them. */}
        {hold ? (
          // Every way in lands here, a card's or a key pasted in the composer: nothing connects before the plan.
          <PlanHold hold={hold} />
        ) : dir.loading || status.isPending ? (
          <Spinner />
        ) : used && forAgent ? (
          <ExistingThinks agent={forAgent} used={used} />
        ) : (
          <AiPicker
            choice={login ? null : choice}
            // Kept while a row's sign-in is open: its panel, under that row, says when it's done.
            have={(held) =>
              forAgent &&
              (login || listsExisting(dir.agentById.get(forAgent.id), noAi(forAgent.id))) && (
                <ExistingRows
                  gates={gates}
                  agent={forAgent}
                  credentials={credentials.data ?? []}
                  signIn={login}
                  panel={held}
                  onSignIn={(next) => {
                    setLogin(next);
                    setPicked(next.choice);
                    setPickedTarget(forAgent.id);
                    setHeldReader(undefined);
                  }}
                  {...(settingUp ? {} : { onManageKeys: () => toSettings("usage") })}
                  onUsed={(id, next) => {
                    setLinked((l) => ({ ...l, [id]: next.choice }));
                    setUsed(next);
                    done(next.choice);
                  }}
                />
              )
            }
            onPick={(next) => {
              setPicked(next);
              setLogin(null);
              if (next === choice) return;
              setHeldReader(undefined);
              // Another plan moves on to whoever still has no AI once this one's agents think with a plan from here.
              if (next !== "key" && Object.keys(linked).length > 0)
                setPickedTarget(defaultTarget({ agents: planAgents, hasAi, set: setOf(next) }));
            }}
            dims={(c) => (agents.length > 0 || bare) && gateDims(gateOf(c))}
            busy={add.isPending}
            keySelect={keySelect}
            panel={panel}
          />
        )}
      </DialogBody>
      {(connected || freeDone) && doneFooter}
    </Dialog>
  );
}
