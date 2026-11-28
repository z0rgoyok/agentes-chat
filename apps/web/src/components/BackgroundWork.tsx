import { type Issue, type Message, useChannels, type WorkView } from "@agenteschat/client";
import { ownsAgentAs } from "@agenteschat/client/lib/agent-owner";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { upperFirst } from "@agenteschat/client/lib/format";
import { heldBack } from "@agenteschat/client/lib/issues";
import {
  handedLine,
  workIsOver,
  workLine,
  workPlanProgress,
  workWaitsOnPerson,
} from "@agenteschat/client/lib/long-work";
import { can } from "@agenteschat/client/lib/permissions";
import { type AgentColor, agentGradient, PixelSpinner, WorkLine, WorkLineAction, WorkPlan } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useChannelActions } from "@/components/channel-actions";
import { useNow } from "@/components/missions/MissionBits";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/** The line of a long work (ADR 0121) and its actions, the same under the anchor and on the card. */
function useWorkLine(work: WorkView, inUpdatesThread = false) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const live = work.status === "live" || work.status === "queued";
  // A live work's minutes move every half minute.
  const now = new Date(useNow(live, 30_000));
  const agent = dir.agentById.get(work.agentId);
  // As `mayStopRun` decides (who asked, the agent's owner, who manages it); the server has the last word, said in a
  // toast.
  const canStop =
    managesAgent(agent) ||
    (!!agent && ownsAgentAs(agent, me.user.id, dir.rolesOf(me.user.id))) ||
    work.requestedByUserId === me.user.id;
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(org.id, runId),
    onError: () => toast.show(t("work.stopFailed"), "error"),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["org", org.id, "channel", work.channelId] }),
  });
  const context = {
    locale: i18n.language,
    now,
    meId: me.user.id,
    agentName: agent?.name ?? t("channel.unknownAgent"),
    nameOf: (id: string) => dir.memberById.get(id)?.name ?? null,
    agentNameOf: (id: string) => dir.anyAgent(id)?.name,
    canStop,
    inUpdatesThread,
  };
  const view = workLine(t, work, context);
  return { view, handed: () => handedLine(t, work, context), agent, stop, t };
}

/** The delegate in the hand-off's words: its face, then its name in ink (an `.ac-who`, as "helping Ada" draws it). */
function HandedWho({ agentId, talk, children }: { agentId: string; talk?: string; children?: ReactNode }) {
  const name = typeof children === "string" ? children : "";
  return (
    <span className="ac-who handed-line__who" data-handoff={talk}>
      <AgentAvatar agentId={agentId} name={name} state="idle" size="xs" />
      <b>{children}</b>
    </span>
  );
}

/** The line's mark, by its tone: the agent's pixel orbit while it works, a check once done, a wait's small square. */
function HandedMark({ tone, color }: { tone: string; color?: AgentColor }) {
  if (tone === "working") return <PixelSpinner size={14} color={color} />;
  if (tone === "done")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  if (tone === "failed")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M6 2.5v4.2M6 9.2v.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  return <span className="handed-line__dot" />;
}

/**
 * Under the reply of the agent that handed work over, a quiet line on the reply's text (no plate, so no edge to miss
 * the bubble's): "Handed to [Atlas] Atlas · [Working] step 3 of 5 · 2 min · See · Stop". The state is a badge
 * in the delegate's colour while it works, amber while it waits, green once done; See (the two agents' talk, as the
 * bar's) and Stop while it isn't over, See result once done. Its updates and report are the delegate's own messages
 * right below. `data-handoff` lets the bar above the composer leave it out while it is on screen.
 */
export function HandedWorkLine({ work }: { work: WorkView }) {
  const { i18n } = useTranslation();
  const actions = useChannelActions();
  const { handed, agent, stop, t } = useWorkLine(work, true);
  const h = handed();
  const name = agent?.name ?? t("channel.unknownAgent");
  const talk = work.handedBy?.consultationId;
  const seeTalk = talk && !workIsOver(work) && actions?.openConsultation ? actions.openConsultation : undefined;
  // The report's copy is posted in the thread the work was handed from (`homeThreadId`), never a row of the timeline:
  // a jump there finds no such row. That thread opens at it, as the phone's line does.
  const seeResult = (messageId: string) => {
    if (work.homeThreadId && actions?.openThread) actions.openThread(work.homeThreadId, messageId);
    else actions?.jumpTo?.(messageId);
  };
  const color = agent ? colorOf(agent) : undefined;
  const links = [
    h.result && (
      <WorkLineAction key="result" onClick={() => seeResult(h.result?.messageId as string)}>
        {h.result.label}
      </WorkLineAction>
    ),
    seeTalk && talk && (
      <WorkLineAction key="see" onClick={() => seeTalk(talk)}>
        {t("run.strip.see")}
      </WorkLineAction>
    ),
    h.stop && (
      <WorkLineAction key="stop" danger disabled={stop.isPending} onClick={() => stop.mutate(h.stop?.runId as string)}>
        {t("work.stop")}
      </WorkLineAction>
    ),
  ].filter(Boolean);
  return (
    <div
      className="handed-line"
      data-tone={h.tone}
      role="status"
      style={color ? ({ "--work-tone": agentGradient(color)[1] } as CSSProperties) : undefined}
    >
      <span className="handed-line__mark" aria-hidden="true">
        <HandedMark tone={h.tone} color={color} />
      </span>
      <p className="handed-line__text">
        <Trans
          i18nKey="work.handed.lead"
          values={{ name }}
          components={[<HandedWho key="who" agentId={work.agentId} talk={talk} />]}
        />
        <span className="handed-line__keep">
          {" · "}
          <span className="handed-line__state">{upperFirst(h.state, i18n.language)}</span>
          {h.facts.length > 0 && (
            <>
              {" "}
              <span className="handed-line__facts">{h.facts.join(" · ")}</span>
            </>
          )}
        </span>
        {links.map((link) => (
          <span key={(link as { key: string }).key} className="handed-line__keep">
            {" · "}
            {link}
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * Under the agent's "Vou cuidar disso": how the work stands, its last update or what it asks, Tarefa #, Parar, Ver
 * resultado. Once its thread has replies, the thread's own line under it opens the thread (`threaded`): no second way
 * in, unless it waits on someone, who goes straight to the card in the panel. In a thread view (`inThread`) its
 * updates are the messages right under it: the line doesn't repeat the last one.
 */
export function MessageWorkLine({
  message,
  threaded,
  inThread,
}: {
  message: Message;
  threaded?: boolean;
  inThread?: boolean;
}) {
  const work = message.longWork;
  if (!work) return null;
  return <AnchorLine work={work} threaded={Boolean(threaded)} inThread={Boolean(inThread)} />;
}

function AnchorLine({ work, threaded, inThread }: { work: WorkView; threaded: boolean; inThread: boolean }) {
  const { org } = useOrg();
  const navigate = useNavigate();
  const actions = useChannelActions();
  const { view, stop, t } = useWorkLine(work, inThread);
  return (
    <WorkLine
      tone={view.tone}
      text={view.text}
      update={view.update}
      question={view.question?.text}
      actions={
        <>
          {view.threadId && (!threaded || workWaitsOnPerson(work)) && actions?.openThread && (
            <WorkLineAction
              onClick={() => actions.openThread?.(view.threadId as string, view.question?.messageId ?? undefined)}
            >
              {t("work.openThread")}
            </WorkLineAction>
          )}
          {view.task && (
            <WorkLineAction
              onClick={() =>
                void navigate({
                  to: "/org/$orgId/issues/$number",
                  params: { orgId: org.id, number: String(view.task?.number) },
                })
              }
            >
              {view.task.label}
            </WorkLineAction>
          )}
          {view.result && (
            <WorkLineAction onClick={() => actions?.jumpTo?.(view.result?.messageId as string)}>
              {view.result.label}
            </WorkLineAction>
          )}
          {view.stop && (
            <WorkLineAction danger disabled={stop.isPending} onClick={() => stop.mutate(view.stop?.runId as string)}>
              {t("work.stop")}
            </WorkLineAction>
          )}
        </>
      }
    />
  );
}

/** On a card that tracks background work: its line, the agent's plan, Abrir conversa, Parar, Mostrar para todos. */
export function IssueWorkBlock({ issue }: { issue: Issue }) {
  const work = issue.backgroundWork;
  if (!work) return null;
  return <CardBlock issue={issue} work={work} />;
}

function CardBlock({ issue, work }: { issue: Issue; work: WorkView }) {
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const channels = useChannels(org.id);
  const { view, stop, t } = useWorkLine(work);
  const progress = workPlanProgress(work);
  const share = useMutation({
    mutationFn: () => api.issues.share(org.id, issue.id),
    onSuccess: () => {
      toast.show(t("work.shared"));
      void qc.invalidateQueries({ queryKey: ["org", org.id, "issues"] });
    },
    onError: () => toast.show(t("work.shareFailed"), "error"),
  });
  // Only a card a DM or a private channel holds back, for who may show it (who asked, its creator, an admin).
  const held = heldBack(issue, channels.data);
  const mayShare =
    work.requestedByUserId === me.user.id ||
    (issue.createdBy.type === "person" && issue.createdBy.id === me.user.id) ||
    can(org, "manage_agents");
  const openConversation = () =>
    view.threadId
      ? void navigate({
          to: "/org/$orgId/threads/$threadId",
          params: { orgId: org.id, threadId: view.threadId },
          search: view.question?.messageId ? { m: view.question.messageId } : {},
        })
      : void navigate({
          to: "/org/$orgId/c/$channelId",
          params: { orgId: org.id, channelId: work.channelId },
          search: { m: work.anchorMessageId },
        });
  return (
    <div className="issue-work-block">
      <WorkLine
        tone={view.tone}
        text={view.text}
        update={view.update ? `${t("work.lastUpdate")}: ${view.update}` : null}
        question={view.question?.text}
        actions={
          <>
            <WorkLineAction onClick={openConversation}>{t("work.openThread")}</WorkLineAction>
            {view.stop && (
              <WorkLineAction danger disabled={stop.isPending} onClick={() => stop.mutate(view.stop?.runId as string)}>
                {t("work.stop")}
              </WorkLineAction>
            )}
            {held && mayShare && (
              <WorkLineAction disabled={share.isPending} onClick={() => share.mutate()}>
                {t("work.shareEveryone")}
              </WorkLineAction>
            )}
          </>
        }
      />
      {work.plan.length > 0 && (
        <WorkPlan
          label={t("work.plan")}
          progress={progress ? t("work.planProgress", progress) : undefined}
          items={work.plan.map((p) => ({ key: p.id, text: p.text, state: p.state }))}
        />
      )}
    </div>
  );
}
