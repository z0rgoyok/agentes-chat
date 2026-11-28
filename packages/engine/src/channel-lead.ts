import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { threadIsConfidential } from "./confidential";
import { deliverNotice, publishDelivery } from "./delivery";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { getMessage } from "./messages";
import { outOfOfficeIds } from "./out-of-office";
import { continuableEnd, PERSON_LIMIT } from "./runs";
import { standingErrorDetail } from "./standing";
import { runStretchOf } from "./stretch";

const { agentRuns, agentWorks, agents, channelMembers, channels } = schema;

/**
 * Work a person asked of an agent ended in a channel that has a responsible agent (`channels.lead_agent_id`, ADR 0095,
 * addendum of 2026-11-23): that agent is given the turn when the judge reads a step for it in the result (a check
 * before the next stage of the channel's job, a result another agent's part needs, a failure nobody picked up). Job
 * `channel.lead_turn`, queued by `endWork` once per ending, off the ending run's path. Never for handed work (the
 * agent that handed it hears it, `reportHandOffs`), the lead's own work, an end the people can resume with Continuar,
 * a failure nobody may pick up (a person's monthly limit, an archived agent, a workspace or agent on hold), a lead
 * that answers only when mentioned, is out of office, archived or held, a confidential thread, nor with no judge or
 * when it fails: nobody waits on this turn, so a doubt wakes nobody. As a `channel_work` notice only the lead reads,
 * in the ending run's stretch, in a run that may pass.
 */
export async function tellChannelLead(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge | null },
  orgId: string,
  input: { workId: string; runId: string },
) {
  const { db, judge } = deps;
  if (!judge) return null;
  const [work] = await db
    .select()
    .from(agentWorks)
    .where(and(eq(agentWorks.orgId, orgId), eq(agentWorks.id, input.workId)));
  // Ended (a Continuar since has it going again), with its result posted, and not handed by another agent.
  if (!work?.finishedAt || !work.resultMessageId || work.consultationId) return null;
  if (work.status !== "done" && work.status !== "failed") return null;
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, input.runId), eq(agentRuns.workId, work.id)));
  if (!run) return null;
  const error = run.error ?? "";
  if (error === PERSON_LIMIT || error === "agent_archived" || standingErrorDetail(error)) return null;
  const reply = run.replyMessageId ? await getMessage(db, orgId, run.replyMessageId) : null;
  if (continuableEnd(run, reply)) return null;
  const [channel] = await db
    .select({ name: channels.name, topic: channels.topic, leadAgentId: channels.leadAgentId })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.id, work.channelId),
        eq(channels.kind, "channel"),
        isNull(channels.archivedAt),
      ),
    );
  const leadId = channel?.leadAgentId;
  if (!channel || !leadId || leadId === work.agentId) return null;
  // A lead that answers only when mentioned takes nothing it wasn't called for, as in the router.
  const [lead] = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(channelMembers, and(eq(channelMembers.agentId, agents.id), eq(channelMembers.channelId, work.channelId)))
    .where(
      and(
        eq(agents.orgId, orgId),
        eq(agents.id, leadId),
        eq(channelMembers.autoReply, true),
        isNull(agents.archivedAt),
        isNull(agents.operatorHoldAt),
      ),
    );
  if (!lead) return null;
  // Out of office (ADR 0084 §12): it would park until the reset and say so under the report.
  if ((await outOfOfficeIds(db, orgId, [leadId]).catch(() => new Set<string>())).has(leadId)) return null;
  const [[worker], result] = await Promise.all([
    db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, work.agentId)),
    getMessage(db, orgId, work.resultMessageId),
  ]);
  const said = result?.body.trim() ?? "";
  if (!worker || !result || !said) return null;
  // What a confidential thread says stays with the run that thinks with it (ADR 0190).
  if (result.threadId && (await threadIsConfidential(db, orgId, result.threadId))) return null;
  const goesOn = await leadGoesOn(judge, {
    orgId,
    // The judgment reads the ending run's report: its usage goes with that run.
    agentId: work.agentId,
    runId: run.id,
    channel: `#${channel.name}${channel.topic ? `: ${cutText(channel.topic, 300)}` : ""}`,
    work: cutText(work.title, 500),
    by: `@${worker.handle}`,
    result: cutText(said, 2000),
    failed: work.status === "failed",
  }).catch(() => false);
  if (!goesOn) return null;
  const delivered = await db.transaction((tx) =>
    deliverNotice(tx, {
      orgId,
      agentId: leadId,
      channelId: work.channelId,
      // Where the report is: the lead's turn answers under it.
      threadId: result.threadId,
      hop: run.hop,
      stretchId: runStretchOf(run),
      // Nobody reads the body: the lead reads `meta.notice`. No handles and no question: never a line anyone said.
      body: "Work another agent ended here, for the channel's responsible agent.",
      // The report keeps its trust level when it relayed what its run read outside (ADR 0117).
      readOutside: result.meta.readOutside === true,
      notice: {
        kind: "channel_work",
        text: cutText(said, 8000),
        from: `@${worker.handle}`,
        refs: { workId: work.id, runId: run.id, title: cutText(work.title, 200), status: work.status },
      },
    }),
  );
  await publishDelivery(deps.pubsub, delivered).catch(() => {});
  return delivered;
}

/** The judgment behind `tellChannelLead`. */
export async function leadGoesOn(
  judge: Judge,
  input: {
    orgId: string;
    agentId: string;
    runId: string;
    channel: string;
    work: string;
    by: string;
    result: string;
    failed: boolean;
  },
) {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "channel_lead_next",
    state: {
      channel: input.channel,
      work: input.work,
      by: input.by,
      result: input.result,
      failed: input.failed,
    },
    questions: {
      goesOn: {
        type: "noul",
        instructions:
          "In `channel`, one AI agent is responsible for the job the channel exists for: it keeps the job moving between the other agents and the people. A person asked another agent (`by`) for `work`, and it just ended: that agent posted `result` to the people itself (`failed`: it could not finish). Does the responsible agent have a step to take now because of this result?",
        criteria: {
          true: "The result needs a check by the agents before the next stage of the channel's job, or another agent's part needs it and nobody was told, or it failed or is partial and nobody picked it up.",
          false:
            "The result already answers the person who asked and nothing follows from it; or it asks the people (someone, the team, a person it names) for an ok, a decision or an answer: that is theirs; or the next step is already with someone.",
        },
      },
    },
  });
  return (answers.goesOn?.noul ?? 0) >= 0.5;
}
