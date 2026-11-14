import type { Agent, AgentStyle } from "@agenteschat/client";
import {
  useAiStatus,
  useComputerSetup,
  useMessages,
  useRightHandWave,
  useSetAgentStyle,
  useTeamAnswered,
} from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, noAiCardOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import {
  introCards,
  introLeadKey,
  isRightHand,
  offersTeamSetup,
  welcomeOpen,
} from "@agenteschat/client/lib/right-hand";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { AgentSticker, Button, Message, MessageText, WAVE_SECONDS } from "@agenteschat/ui";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { MESSAGE_STICKER } from "@/chat/ChatMedia";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi } from "@/components/ConnectAi";
import { useChannelActions } from "@/components/channel-actions";
import { FirstRunCard, useFirstRun } from "@/components/FirstRun";
import { useOrg } from "@/components/org-context";
import { AuthorStatus } from "@/components/Presence";
import { ProfileTrigger } from "@/components/ProfileCard";
import { RequestCard, RequestChoices, RequestKeys, RequestNote } from "@/components/RequestCard";
import { TextAction } from "@/components/UsagePauseCard";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

/**
 * The top of the right hand's DM (ADR 0137), drawn by the app and never stored, so it costs nothing and works before
 * any AI is connected: its greeting, then, for the workspace's owners, the first-run checklist (ADR 0155 §6), whose
 * rows hold the whole setup. Anyone else gets one card at a time (`introCards`): Connect AI while there is none, then
 * how agents talk to them (ADR 0147); the owner gets that question once the checklist is complete and the team answered
 * them once, so it never stands beside the first task. With no card left, a line to build the team with it, at any
 * time; a personal workspace's words speak of one person's agents (ADR 0159). Someone it greeted when they joined
 * gets Connect AI alone until they answer (`welcomeOpen`): its stored greeting right below asks the one question. On
 * the person's first visit, its waving sticker under the greeting, drawn as a sticker message is and decorative (the
 * greeting already says hello). Its face and name open the profile card, as on any message.
 */
export function RightHandIntro({ agent, channelId }: { agent: Agent; channelId: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const actions = useChannelActions();
  const wave = useRightHandWave(org.id, agent.id);
  const team = dir.agents.filter((a) => !isRightHand(a));
  const held = usePlanHold() !== null;
  const setup = useComputerSetup(org.id);
  const checklist = useFirstRun(agent).state;
  // A hold is known with the edition: until then no card, so Connect doesn't flash before the checklist.
  const noAi = aiStateOf(status.data, agent.id) === "no_ai";
  const aiKnown = Boolean(status.data) && !setup.isPending;
  const createsAgents = can(org, "create_agents");
  const messages = useMessages(org.id, channelId).data;
  // Its stored greeting of someone who joined asks what they look after: until they answer, nothing else here asks.
  const welcomed = welcomeOpen(messages, org.role === "owner");
  const cards = introCards({
    noAi: noAi && aiKnown,
    aiKnown,
    askStyle: org.agentStyle === null,
    held,
    noAiCard: messages?.some((m) => noAiCardOf(m.meta)),
    checklist,
    answered: useTeamAnswered(org.id, team),
    welcomed,
  });
  // Picked here: its card stays where it was, answered, instead of leaving the moment the workspace has a style.
  const [styled, setStyled] = useState<AgentStyle | null>(null);
  const profile = { actor: { type: "agent", id: agent.id }, label: t("profile.of", { name: agent.name }) } as const;
  return (
    <Message
      agent
      avatar={
        <ProfileTrigger {...profile} decorative>
          <AgentAvatar agentId={agent.id} name={agent.name} presence />
        </ProfileTrigger>
      }
      author={
        <>
          <ProfileTrigger {...profile} className="profile-trigger--name">
            {agent.name}
          </ProfileTrigger>
          <AuthorStatus actor={profile.actor} />
        </>
      }
      time={<time dateTime={agent.createdAt}>{formatTime(i18n.language, agent.createdAt)}</time>}
    >
      <MessageText>
        {/* The wrapper a typed message's Markdown has (MessageBody): without it, a paragraph keeps the browser's margins. */}
        <div className="md md--message">
          <p>
            <b>{t(modeKey(org, "rightHand.intro.greeting"), agentGrammar(agent.name))}</b>
          </p>
          <p>{t(modeKey(org, introLeadKey(held, team.length > 0)))}</p>
        </div>
      </MessageText>
      {wave && (
        <AgentSticker
          appearance={lookOf(agent)}
          mood="wave"
          playFor={WAVE_SECONDS}
          size={MESSAGE_STICKER}
          className="ac-msg-media"
        />
      )}
      {cards.includes("connect") && connect && (
        <RequestNote
          agent={agent}
          title={t(modeKey(org, "rightHand.intro.connect.title"))}
          hint={t(modeKey(org, "rightHand.intro.connect.hint"))}
          actions={
            <Button size="sm" variant="primary" onClick={() => connect.open({ agentId: agent.id })}>
              {t("rightHand.intro.connect.action")}
            </Button>
          }
        >
          {t("rightHand.intro.connect.text")}
        </RequestNote>
      )}
      <FirstRunCard agent={agent} channelId={channelId} />
      {(cards.includes("style") || styled) && <StyleCard agent={agent} picked={styled} onPicked={setStyled} />}
      {offersTeamSetup({
        noAi,
        aiKnown,
        createsAgents,
        hasTeam: team.length > 0,
        cards,
        held,
        checklist,
        welcomed,
      }) && (
        <p className="rh-intro__again small muted">
          {t(modeKey(org, "rightHand.intro.again.question"))}{" "}
          <TextAction onClick={() => actions?.resend(t(modeKey(org, "rightHand.intro.again.message")))}>
            {t(modeKey(org, "rightHand.intro.again.action"))}
          </TextAction>
        </p>
      )}
    </Message>
  );
}

const STYLES = ["simple", "technical"] as const satisfies readonly AgentStyle[];

/**
 * "Como prefere que eu fale com você?": two answers, saved for every agent here. Once the person picks (`picked`), the
 * same card says what they answered where the answers were.
 */
function StyleCard({
  agent,
  picked,
  onPicked,
}: {
  agent: Agent;
  picked: AgentStyle | null;
  onPicked: (style: AgentStyle) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSetAgentStyle(org.id);
  const question = t("rightHand.intro.style.question");
  const pick = (style: AgentStyle) =>
    save.mutate(style, {
      onSuccess: () => onPicked(style),
      onError: () => toast.show(t("settings.account.activityFailed"), "error"),
    });
  return (
    <RequestCard
      id={`right-hand-style-${agent.id}`}
      kind="question"
      agent={agent}
      label={question}
      mine={false}
      lead={question}
      what={question}
      locked={save.isPending}
      answer={
        picked
          ? {
              done: true,
              text: (
                <Trans
                  i18nKey="question.answeredByYou"
                  values={{ answer: t(`rightHand.intro.style.${picked}`) }}
                  components={{ b: <b /> }}
                />
              ),
            }
          : undefined
      }
      body={
        !picked && (
          <>
            <p>{t("rightHand.intro.style.text")}</p>
            <RequestChoices
              choices={STYLES.map((style) => ({
                label: t(`rightHand.intro.style.${style}`),
                busy: save.isPending && save.variables === style,
              }))}
              onPick={(i) => {
                const style = STYLES[i];
                if (style) pick(style);
              }}
              disabled={save.isPending}
            />
          </>
        )
      }
      actions={<RequestKeys count={STYLES.length} />}
    />
  );
}
