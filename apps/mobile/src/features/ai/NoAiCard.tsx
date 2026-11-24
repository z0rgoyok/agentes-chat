import { type Message, useAiStatus, useApi, useMessages, useThreadMessages } from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import type { BillingHold } from "@agenteschat/client/lib/billing";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  aiStateOf,
  keptCardState,
  mayConnectAi,
  type NoAiCard as NoAiCardMeta,
  noAiCardOf,
  noAiLineKey,
  planLineFix,
  planLineKey,
  planLinePasses,
  planOfKind,
  type StandIn,
  signInAgainPlan,
  standInKey,
} from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { paysHere } from "@/lib/store";
import { useOrg } from "@/providers/org";
import { Button, EventPill, EventPillAction, EventPillText, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { AskButtons, AskDone, AskFoot, AskNote, AskWaiting } from "../chat/asks";
import { openTeamTemplates } from "../right-hand/TeamTemplates";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";
import { ownsIn } from "../shared/owner";
import { usePlanHold } from "./parts";

type Answer = "pending" | "answering" | "still_missing";

/**
 * Opens "Conectar uma IA" (the web's `connect.open`): `from`, the message answered once the agent has an AI;
 * `intent`, the step it asked for; `provider`, the key's maker it named; `agentId`, the agent to connect; `plan`, the
 * plan's page it opens on (Sign in again: the agent's own); `email`, one more login of the account with this email
 * (one other agents use), Claude's hint; `again`, with `plan`, one of the person's logins signed in again on that
 * plan's page (a new key for a coding plan's), `email` then its own.
 */
export const openConnectAi = (
  request: {
    from?: string;
    intent?: string;
    provider?: string;
    agentId?: string;
    plan?: string;
    email?: string;
    /** "1": from the create-agent step, for the agent being made (a plan signs in for the agents I create). */
    forNew?: string;
    again?: string;
  } = {},
) => {
  const query = Object.entries(request)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join("&");
  router.push((query ? `/connect-ai?${query}` : "/connect-ai") as never);
};

/**
 * The right hand answered with another AI than its plan (ADR 0137 §7, amended 2026-11-15), as the web's: a quiet pill
 * saying with what and why, and "Change", which opens its settings (each person's own AI, and the workspace's).
 */
function StandInLine({ standIn }: { standIn: StandIn }) {
  const { t } = useTranslation();
  return (
    <EventPill
      mark="info"
      actions={
        <EventPillAction
          label={t("chat.standIn.change")}
          onPress={() => router.push("/settings/right-hand" as never)}
        />
      }
    >
      {t(standInKey(standIn.why), { via: standIn.via, plan: standIn.plan })}
    </EventPill>
  );
}

/**
 * The web's no-AI request under an agent's "I have no AI" reply (`meta.noAi`), as a waiting pill: Connect (tinted, for
 * who may connect) opens the key sheet; anyone else reads who can. Once the agent has an AI, a decided request's pill
 * with "Answer now" has it answer what it couldn't (who asked, its owner or an admin).
 */
export function NoAiCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const meId = useMeId();
  const hold = usePlanHold(orgId, org);
  const failed = useFailed();
  const card = noAiCardOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  if (card.standIn) return <StandInLine standIn={card.standIn} />;
  // Any card on a billing hold is the wall: a Connect or a key from before it leads nowhere until the plan.
  if (card.held || hold) return <KeptCard message={m} card={card} hold={hold} />;
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const again = signInAgainPlan(card, agent);
  // The computer's own sign-in isn't there: Conectar opens on an account of that CLI's plan.
  const plan = card.own ? planOfKind(card.own) : again;
  const state = aiStateOf(status.data, card.agentId);
  const ready = state !== undefined && state !== "no_ai" && answer !== "still_missing";
  // Who asked, its owner (or one who holds the role that answers for it, ADR 0085, addendum of 2026-11-21) or an admin.
  const mayAnswer = card.forUserId === meId || ownsIn(dir.memberById, meId, agent) || managesAgent(agent);
  const answering = answer === "answering";
  // The team's right hand on a plan that can't think now (ADR 0137 §7): one plain line, and the way to an API key.
  const planLine = card.planLine && !(planLinePasses(card.planLine) && state === "ready") ? card.planLine : null;
  const mayConnect = mayConnectAi(agent, meId, org);
  const fix = planLine ? planLineFix(planLine, agent, meId, org) : null;
  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  const locked = (
    <EventPillText>
      <Text variant="footnote" tone="muted">
        {!planLine && owner ? t("noAi.locked", { name, owner }) : t("noAi.lockedAdmins")}
      </Text>
    </EventPillText>
  );
  const title = answering
    ? t("noAi.card.answering", { name })
    : planLine
      ? t(planLineKey(planLine, card.why), {
          name,
          model: card.model,
          why: card.why,
          owner: card.owner,
          plan: card.plan,
        })
      : ready
        ? t("noAi.card.connected", { name })
        : answer === "still_missing"
          ? t("noAi.card.stillMissing", { name })
          : t(noAiLineKey(card), { ...agentGrammar(name), computer: card.computer });
  const answerNow = async () => {
    setAnswer("pending");
    try {
      await api.chat.answerNow(orgId, m.id);
      setAnswer("answering");
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Still no AI: the pill says so. Anything else failed: the toast says why, and "Answer now" is back.
      if (code !== "ai.still_missing") failed(error);
      setAnswer(code === "ai.still_missing" ? "still_missing" : null);
    }
  };
  // Its agent has an AI now (or is answering): a decided request, one pill with "Answer now" in it.
  if (answering || (!planLine && (ready || answer === "pending")))
    return (
      <AskDone
        done
        words={title}
        actions={
          !answering && mayAnswer ? (
            <EventPillAction
              key="answer"
              label={t("noAi.card.answerNow")}
              loading={answer === "pending"}
              onPress={() => void answerNow()}
            />
          ) : null
        }
      />
    );
  // Still waiting for an AI: the waiting pill, Connect (or the plan's fix) tinted for who may press it.
  const action = planLine ? (
    fix ? (
      <EventPillAction
        key="connect"
        primary
        label={t(fix === "connectMine" ? "rightHand.settings.connectMine" : "noAi.rightHand.useKey")}
        onPress={() =>
          openConnectAi({
            from: m.id,
            agentId: card.agentId,
            ...(fix === "connectMine" ? {} : { intent: "api_key" }),
          })
        }
      />
    ) : null
  ) : mayConnect ? (
    <EventPillAction
      key="connect"
      primary
      label={t(again ? "agentPage.work.brain.signInAgain" : "noAi.action")}
      onPress={() =>
        openConnectAi({
          from: m.id,
          intent: card.intent,
          provider: card.provider,
          agentId: card.agentId,
          ...(plan ? { plan } : {}),
        })
      }
    />
  ) : null;
  return (
    <AskWaiting forMe={action !== null} mark="bolt" words={title} actions={action} below={action ? null : locked} />
  );
}

/**
 * The web's wall (ADR 0079 §6): the agent kept the message for after the plan, as a note in words only, since paying
 * has no button or link here (`keptCardState`). Once an AI is there, opening the conversation starts the answer.
 */
function KeptCard({ message: m, card, hold }: { message: Message; card: NoAiCardMeta; hold: BillingHold | null }) {
  const { t } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const meId = useMeId();
  // A card in a thread is answered there.
  const channel = useMessages(orgId, m.channelId, !m.threadId).data;
  const thread = useThreadMessages(orgId, m.threadId ? m.channelId : undefined, m.threadId ?? "");
  const messages = m.threadId ? thread.data : channel;
  const started = useRef(false);
  const failed = useFailed();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const ai = aiStateOf(status.data, card.agentId);
  const state = keptCardState({ hold, paid: false, ready: ai !== undefined && ai !== "no_ai" });
  // Who asked, its owner (or one who holds the role that answers for it, ADR 0085, addendum of 2026-11-21) or an admin.
  const mayAnswer = card.forUserId === meId || ownsIn(dir.memberById, meId, agent) || managesAgent(agent);
  const replied = messages?.some(
    (x) => x.author.id === card.agentId && x.createdAt > m.createdAt && !noAiCardOf(x.meta),
  );
  /** `tapped`: the person pressed "Answer now", so a refusal says why; the start on opening fails quietly. */
  const start = (tapped: boolean) => {
    setAnswer("pending");
    api.chat.answerNow(orgId, m.id).then(
      () => setAnswer("answering"),
      (error: unknown) => {
        if (tapped) failed(error);
        setAnswer(null);
      },
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per card here
  useEffect(() => {
    if (state !== "answer" || !mayAnswer || replied !== false || started.current) return;
    started.current = true;
    start(false);
  }, [state, mayAnswer, replied]);
  const answering = !replied && answer !== null;
  // Not known yet: no moment of "Plano ativo" on a card an AI has long answered.
  if (state === "connect" && !status.data) return null;
  const code = hold ?? "payment";
  // With no team yet, the way to one needs no model.
  const noTeam = isRightHand(agent) && can(org, "create_agents") && dir.agents.every(isRightHand);
  if (state === "answer") {
    const title = t(answering ? "noAi.card.answering" : "noAi.card.connected", { name });
    return (
      <AskDone
        done
        words={title}
        actions={
          // The start refused: never a promise with nothing behind it.
          !answering && !replied && mayAnswer ? (
            <EventPillAction key="answer" label={t("noAi.card.answerNow")} onPress={() => start(true)} />
          ) : null
        }
      />
    );
  }
  if (state === "connect") {
    const mine = mayConnectAi(agent, meId, org);
    return (
      <AskNote
        agentId={card.agentId}
        title={t("noAi.kept.activeTitle")}
        text={mine ? t("noAi.kept.activeLine", { name }) : t("noAi.lockedAdmins")}
        foot={
          mine ? (
            <AskFoot>
              <AskButtons
                primary={
                  <Button
                    variant="primary"
                    size="card"
                    wide
                    label={t("noAi.action")}
                    onPress={() => openConnectAi({ from: m.id })}
                  />
                }
              />
            </AskFoot>
          ) : null
        }
      />
    );
  }
  // Paying has no button here: the sentence says where, or who can.
  return (
    <AskNote
      agentId={card.agentId}
      title={t("noAi.kept.title")}
      hint={t(code === "payment" ? "noAi.kept.plan" : "standing.billing.sub")}
      text={
        paysHere(can(org, "manage_billing"))
          ? t("common.joinSentences", { a: t(`noAi.kept.wait.${code}`), b: t("connectAi.billingWeb") })
          : t("noAi.kept.askAdmin")
      }
      foot={
        state === "held" && noTeam ? (
          <AskFoot>
            <AskButtons
              primary={
                <Button
                  variant="primary"
                  size="card"
                  wide
                  label={t(modeKey(org, "teamPlan.start.templates"))}
                  onPress={() => openTeamTemplates()}
                />
              }
            />
          </AskFoot>
        ) : null
      }
    />
  );
}
