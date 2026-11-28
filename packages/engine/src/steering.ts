import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { runBrainOf } from "./brains/select";
import { cancelRun, interruptRun } from "./cancel";
import { frontOfLine } from "./computer-queue";
import { publishChannelEvent } from "./events";
import { type Judge, type SteerHandling, steerJudgment } from "./judge";
import { deliverLive } from "./live-steer";
import type { Message } from "./messages";
import { missionOfThread } from "./missions";
import { enqueue } from "./outbox";
import { holdsMessages } from "./run-hold";
import { handOnMessages, markTriage, queueAfterRun, releaseFromRun } from "./run-inbox";
import { type AgentRun, addRunStep, computerWaitOf, outageParkedOf, replyThreadOf, runAtWork } from "./runs";
import { sayNowApplies } from "./say-now";
import type { Talker } from "./talker";
import { onMessageWhileWaiting, type WaitMessageOutcome } from "./waits";

const { agentRuns, channels, messages } = schema;

/**
 * Routes a message that went into an agent's task but was for someone else (`steerHandling` `elsewhere`, ADR 0112
 * addendum of 2026-11-19): the router decides who answers it, as for any message nobody mentioned (`jobs.ts`).
 */
export const ROUTE_RELEASED_JOB = "message.route_released";

/**
 * What happens to a person's message that went into an agent's task in
 * progress (one active run per agent and conversation). The message is
 * already queued on the run (`pending_message_ids`); this decides how soon and
 * how it is read, in order:
 *
 * 1. "Parar e mandar" (`now`): the model call stops and the loop reads it.
 * 2. The triage (the judge, `steerHandling`, ADR 0112 addendum), after the send: a plain "stop" cancels the task; a
 *    correction that makes going on a waste cuts the model call for it (a computer brain gets it live and urgent, or
 *    is stopped and started again from it); a separate request waits for the task's end (`queueAfterRun`) and gets a
 *    run of its own; a quick question gets the fast reply at once; anything else, or a judge that isn't sure, is read
 *    at the next pause. In a channel others share, a message that doesn't @mention the agent may be for someone else
 *    (`sharedConversation`): one that is leaves the task unread (`releaseFromRun`) and goes to the router, which may
 *    give it to nobody (ADR 0112 addendum of 2026-11-19). A run that has only talked so far (no tool called, `runAtWork`) has no task to finish first:
 *    a quick question or another request is read with its next step too, and the run answers all of it in one message
 *    (ADR 0112 addendum of 2026-11-19).
 * 3. Live delivery (`live-steer.ts`): a computer brain mid-turn gets it at its
 *    next tool boundary instead of at the end of the turn (with a judge, once the triage said how).
 * 4. A run waiting (`waits.ts`): browser help, another agent's answer. The
 *    message may end the wait ("pronto, loguei") or wake the run (the wait
 *    stays open; its result comes later as a notice). Parked waiting for its
 *    computer: look again now. Waiting on something the message can't move
 *    (a secret, a mission's decision, a question for someone else;
 *    `holdsMessages`): the message leaves it for a run of its own; an approval
 *    never takes it at all.
 * 5. The fast reply (`talker.ts`): when the run can't answer soon (waiting, or
 *    deep in a long turn), or the triage says a quick question or a separate request, the agent's conversation layer
 *    may answer in a second or two, or pass. A correction or an addition the triage was sure of is the agent's own to
 *    answer, in one more line on the way (`say_now`, ADR 0207 addendum of 2026-11-24), where people read the
 *    conversation as it goes: nothing speaks for it then.
 *
 * What the triage said is kept on the run's trail (a `context` step with `steerTriage`, `noteTriage`).
 *
 * Nothing here ever grants anything.
 */
export interface SteeringDeps {
  db: Database;
  pubsub: PubSub;
  /** Tells a plain "stop" from a correction (none = never a stop). */
  judge?: Judge;
  /** The conversation layer (none = no fast replies). */
  talker?: Talker;
}

export interface SteeredInput {
  orgId: string;
  userId: string;
  channelId: string;
  message: Message;
  /** The runs it was queued on. */
  runIds: string[];
  /** "Parar e mandar". */
  now: boolean;
}

export async function afterSteered(deps: SteeringDeps, input: SteeredInput) {
  const { orgId, userId, channelId, message, now } = input;
  const runs = await deps.db.select().from(agentRuns).where(inArray(agentRuns.id, input.runIds));
  for (const runId of input.runIds) {
    const active = runs.find((r) => r.id === runId);
    if (!active) continue;
    const threadId = replyThreadOf(active);
    /** Parked waiting for its computer brain, its plan or its budget (`waitingForBrain`). */
    const parked =
      active.status === "waiting_input"
        ? ((active.transcript as { waitingForBrain?: { waitId?: string; code?: string; source?: string } } | null)
            ?.waitingForBrain ?? null)
        : null;
    // Long work paused near a limit is no wait a message moves (`holdsMessages`): it isn't woken for it.
    const brainWait = parked?.code === "usage_pause" ? null : parked;
    // A conversation's catch-up on its plan or budget takes the message and stays in its place in line: a look now
    // would only ask the plan again, early and out of order.
    const usageWait = brainWait?.code === "plan_limit" || brainWait?.code === "budget";
    const computerWait = computerWaitOf(active);
    // Parked on its computer's own refusal (`outage.machineId`): a message tries it again now, as a wait for that
    // computer does, and its receipt reads the outage.
    const ownPark =
      active.status === "waiting_input" &&
      Boolean((active.transcript as { outage?: { machineId?: string } } | null)?.outage?.machineId);
    // Gone from its inbox already, the app heard where it went (`agent.run.read`, `agent.run.redispatched`):
    // a late "steered" would move the receipt back onto this run.
    if (active.pendingMessageIds.includes(message.id)) {
      await publishChannelEvent(deps.pubsub, {
        type: "agent.run.steered",
        channelId,
        threadId,
        runId,
        agentId: active.agentId,
        messageId: message.id,
        ...(now ? { now: true as const } : {}),
        // Into a run waiting for its computer: the message shows that wait, as a reload would.
        ...(computerWait
          ? { computer: computerWait }
          : active.status === "waiting_input" && brainWait?.code === "work_queue"
            ? { computer: "line" as const }
            : {}),
        ...(outageParkedOf(active) ? { outage: true as const } : {}),
        // On its plan or budget (long work paused near one too, by its `source`), as a reload says (`usageWaitSql`).
        ...(parked?.code === "plan_limit" || parked?.code === "budget" || parked?.code === "usage_pause"
          ? { usage: parked.code === "budget" || parked.source === "budget" ? ("budget" as const) : ("plan" as const) }
          : {}),
      });
    }
    let live = false;
    // Its model call stops and the loop reads the message at once (a running tool finishes first).
    // A computer brain (Claude Code, Codex) can't drop its turn halfway: one whose turn takes messages
    // gets it live and urgent (Claude Code reads it now or at its next tool boundary; Codex's app-server
    // stops the turn and starts the next one with it: `live-steer.ts`); else
    // the task stops for real, and stopping it starts it again from this message
    // (`restartAfterStopAndSend`). Who may not stop it just leaves the message for its next step.
    // The brain this run thinks with (its own, which may differ from the agent's current one). A model-brain run
    // reads its inbox at every step: asking it live would only hold the send while its executor is still starting.
    const computer =
      active.status === "running" &&
      (await getAgentCached(deps.db, orgId, active.agentId).then((a) => !!a && runBrainOf(active, a) !== "model"));
    // The task stops for the message to be read. A plain "stop" sent this way is a stop, not a message to start again
    // from, so with a judge the task is stopped only once it has said which (`judgeSteer`).
    // The judge may take a moment, and the run moves on meanwhile. One that read the message (its next step, or its
    // turn took it) has nothing to stop for, and one that paused or parked would lose a wait nobody asked to cancel.
    const stopToSend = async () => {
      const [fresh] = await deps.db
        .select({ status: agentRuns.status, pending: agentRuns.pendingMessageIds })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId));
      if (fresh?.status !== "running" || !fresh.pending.includes(message.id)) return;
      await cancelRun(deps, userId, orgId, runId, { sendMessageId: message.id }).catch(() => undefined);
    };
    let toSend: (() => Promise<unknown>) | undefined;
    // With a judge, a computer brain mid-turn gets the message once the triage said how (`judgeSteer`), a moment
    // after the send: urgent for a correction, never a separate request left for after the task.
    const handAfterTriage = Boolean(deps.judge) && !now && computer;
    if (now && active.status === "running") {
      if (computer) {
        live = await deliverLive(deps, active, { messageId: message.id, urgent: true }).catch(() => false);
        if (!live && deps.judge) toSend = stopToSend;
        else if (!live) await stopToSend();
      } else await interruptRun(deps.pubsub, runId, message.id);
    } else if (computer) {
      if (!handAfterTriage)
        live = await deliverLive(deps, active, { messageId: message.id, urgent: false }).catch(() => false);
    }
    // Parked waiting for its computer: look again now. Back (or never really away): the run resumes and reads this
    // message with the rest; still away: it parks again quietly (one answer later).
    else if (active.status === "waiting_input" && (active.waitingMachineId || brainWait || ownPark) && !usageWait) {
      const wait = brainWait?.waitId;
      if (brainWait?.code === "busy") await frontOfLine(deps.db, active, message.id).catch(() => undefined);
      else
        await enqueue(deps.db, {
          orgId,
          kind: "agent_run.execute",
          payload: { runId, ...(wait ? { wait } : {}) },
          dedupeKey: `agent_run.execute:${runId}:steer:${message.id}`,
          maxAttempts: 4,
        }).catch(() => undefined);
    }
    // What it does to a wait, then the fast reply: after the response (the judge may take a moment), in order.
    const waiting =
      !active.waitingMachineId &&
      !brainWait &&
      !ownPark &&
      (active.status === "waiting_input" || active.status === "waiting_approval");
    // Waiting on something the message can't move (a secret, a mission's decision, a question for someone else; an
    // approval never takes it): the agent doesn't keep it waiting behind that, it answers in a run of its own. Gone from the
    // inbox already (the run handed it on as it paused, or read it first): the run that has it answers, so
    // nothing here speaks for this one either.
    const holds = waiting && (await holdsMessages(deps.db, active, userId));
    // In a channel others share, the triage first says whether it is for this agent at all: a run of its own for a
    // line to someone else would answer it.
    const shared = deps.judge ? await sharedConversation(deps.db, input, active).catch(() => null) : null;
    const handOn = () => handOnMessages(deps.db, deps.pubsub, active, [message.id]).catch(() => null);
    if (holds && !shared) await handOn();
    // At work (it called a tool), or only talking so far: a run that only talks answers the person itself in a moment,
    // in one message with what they add, so nothing speaks for it meanwhile (ADR 0112 addendum of 2026-11-19).
    const talking = active.status === "running" && !computerWaitOf(active) && !(await runAtWork(deps.db, runId));
    const talks = !holds && (waiting || (deps.talker && !now && !talking));
    const followUp = async (handling: SteerHandling | null, ownLine = false) => {
      let waited: WaitMessageOutcome | null = null;
      if (waiting) {
        waited = await onMessageWhileWaiting(deps, active, message).catch(() => null);
        if (waited) {
          await publishChannelEvent(deps.pubsub, {
            type: "agent.run.wait_message",
            channelId,
            threadId,
            runId,
            agentId: active.agentId,
            messageId: message.id,
            waitKind: waited.waitKind,
            outcome: waited.outcome,
          });
        }
      }
      if (deps.talker && !now) await deps.talker.consider({ run: active, message, live, waited, handling, ownLine });
    };
    const judge = deps.judge;
    if (!judge) {
      if (talks) trackStopCheck(followUp(null));
      continue;
    }
    // Where it may be for someone else, the run waits for the triage a moment before reading it (`awaitTriage`).
    if (shared) await markTriage(deps.db, message, true).catch(() => undefined);
    // How the agent takes it, never in the way of the send: judged after the response (the app hears a stop then),
    // then what that does to the task, then its wait and the fast reply.
    trackStopCheck(
      (async () => {
        let judged: SteerHandling;
        let sure = false;
        try {
          ({ handling: judged, sure } = await judgeSteer(deps, judge, input, active, threadId, shared));
          // Not for this agent: out of its task while unread, and the router decides who answers (maybe nobody). Read
          // already (its next step took it first), it stays read, as any message the run read.
          if (judged === "elsewhere") {
            await noteTriage(deps.db, active, message.id, judged, sure, false);
            if (await releaseFromRun(deps.db, active, message).catch(() => false))
              await released(deps, active, message, threadId);
            return;
          }
        } finally {
          // Settled (and out of the inbox when it wasn't for the agent): the run's step reads on.
          if (shared) await markTriage(deps.db, message, false).catch(() => undefined);
        }
        if (judged === "stop") return noteTriage(deps.db, active, message.id, judged, sure, false);
        // Held for the triage: for this agent after all, so a run of its own answers it.
        if (holds && shared) await handOn();
        // Only a task has an after: while the run only talks, a quick question or another request is part of the
        // conversation it is answering, read with its next step like anything else it adds.
        const handling = talking && (judged === "answer" || judged === "queue") ? "add" : judged;
        // A correction or an addition the triage was sure of: the agent may say one more line on the way as it takes
        // it in, where people read the conversation as it goes (`say_now` reads this step).
        const ownLine =
          sure &&
          (handling === "interrupt" || handling === "add") &&
          active.status === "running" &&
          (await sayNowApplies(deps.db, active).catch(() => false));
        await noteTriage(deps.db, active, message.id, handling, sure, ownLine);
        if (now) await toSend?.();
        else if (active.status === "running") {
          // A separate request: out of what the task reads, a run of its own once it ends.
          const queued = handling === "queue" && (await queueAfterRun(deps.db, runId, message.id).catch(() => false));
          if (handAfterTriage && !queued) {
            const urgent = handling === "interrupt";
            live = await deliverLive(deps, active, { messageId: message.id, urgent }).catch(() => false);
            // A correction its turn can't take now: the task stops and starts again from it, as "Parar e mandar" does.
            if (urgent && !live) await stopToSend();
          } else if (!computer && handling === "interrupt") await interruptRun(deps.pubsub, runId, message.id);
        }
        if (talks) await followUp(handling, ownLine);
      })(),
    );
  }
}

/**
 * How the agent takes the message (`steerHandling`), judged after the send: a plain "stop", in any language, cancels
 * the task here; every other way is the caller's to act on. A judge that fails or isn't sure says `add`: the message is
 * read at the next pause, as before.
 */
async function judgeSteer(
  deps: SteeringDeps,
  judge: Judge,
  input: SteeredInput,
  run: AgentRun,
  threadId: string | null,
  shared: { fromAsker: boolean } | null,
): Promise<{ handling: SteerHandling; sure: boolean }> {
  const agentName = (await getAgentCached(deps.db, input.orgId, run.agentId))?.name ?? "the agent";
  const judged = await steerJudgment(judge, {
    orgId: input.orgId,
    text: input.message.body,
    agentName,
    task: await taskOf(deps.db, run).catch(() => null),
    agentId: run.agentId,
    runId: run.id,
    ...(shared ? { shared } : {}),
  }).catch(() => ({ handling: "add" as const, sure: false }));
  if (judged.handling !== "stop") return judged;
  await publishChannelEvent(deps.pubsub, {
    type: "agent.run.steered",
    channelId: input.channelId,
    threadId,
    runId: run.id,
    agentId: run.agentId,
    messageId: input.message.id,
    stop: true,
  });
  // The "stop" itself is not handed on to a new run when the task's unread messages are.
  await cancelRun(deps, input.userId, input.orgId, run.id, { stopMessageId: input.message.id });
  return judged;
}

/**
 * The triage of one message on the run's trail: how the agent takes it (`reason`), whether the judge chose that way
 * itself (`sure`), and whether the agent may say a line of its own as it takes it in (`line`, read by `say_now`).
 * Best effort: a trail that can't take the step changes nothing of how the message is read.
 */
async function noteTriage(
  db: Database,
  run: AgentRun,
  messageId: string,
  handling: SteerHandling,
  sure: boolean,
  line: boolean,
) {
  await addRunStep(db, run, "context", { steerTriage: { messageId, sure, line }, reason: handling }).catch(() => {});
}

/**
 * Where a message may be for someone else (ADR 0112 addendum of 2026-11-19): a channel others share (not a DM, a task's
 * conversation or a mission's thread), a message that neither @mentions the agent nor quotes it, not sent with "Parar e
 * mandar" (that is for the task). Null elsewhere. `fromAsker`: written by the person who asked for the task.
 */
async function sharedConversation(
  db: Database,
  input: SteeredInput,
  run: AgentRun,
): Promise<{ fromAsker: boolean } | null> {
  const { message } = input;
  if (input.now || message.authorType !== "person" || message.mentionedAgentIds.includes(run.agentId)) return null;
  const quoted = (message.meta.replyTo as { author?: { type?: string; id?: string } } | undefined)?.author;
  if (quoted?.type === "agent" && quoted.id === run.agentId) return null;
  const [channel] = await db
    .select({ kind: channels.kind })
    .from(channels)
    .where(and(eq(channels.orgId, input.orgId), eq(channels.id, input.channelId)));
  if (channel?.kind !== "channel") return null;
  if (await missionOfThread(db, input.orgId, run.threadRootId)) return null;
  const [trigger] = await db
    .select({ authorUserId: messages.authorUserId })
    .from(messages)
    .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)))
    .limit(1);
  return { fromAsker: trigger?.authorUserId === input.userId };
}

/**
 * The message left the agent's task (`releaseFromRun`): the app hears the agent saw it and won't answer it, and the
 * router decides who does.
 */
async function released(deps: SteeringDeps, run: AgentRun, message: Message, threadId: string | null) {
  await publishChannelEvent(deps.pubsub, {
    type: "agent.run.released",
    channelId: message.channelId,
    threadId,
    agentId: run.agentId,
    runId: run.id,
    messageId: message.id,
  });
  await enqueue(deps.db, {
    orgId: message.orgId,
    kind: ROUTE_RELEASED_JOB,
    payload: { messageId: message.id, agentId: run.agentId },
    dedupeKey: `${ROUTE_RELEASED_JOB}:${message.id}`,
  });
}

/** What the run works on, as its judges read it: its request, grown with what the person added, else its trigger. */
async function taskOf(db: Database, run: AgentRun): Promise<string | null> {
  const request = (run.transcript as { request?: unknown } | null)?.request;
  if (typeof request === "string" && request.trim()) return request;
  const [trigger] = await db
    .select({ body: messages.body })
    .from(messages)
    .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)))
    .limit(1);
  return trigger?.body.trim() || null;
}

/** Checks still running after the post returned (stop judge, fast replies). */
const pendingChecks = new Set<Promise<unknown>>();

function trackStopCheck(check: Promise<unknown>) {
  const tracked = check.catch(() => undefined).finally(() => pendingChecks.delete(tracked));
  pendingChecks.add(tracked);
}

/** Resolves once every check started so far is done (and its cancel or reply): for tests and shutdown. */
export async function stopChecksSettled() {
  while (pendingChecks.size > 0) await Promise.all([...pendingChecks]);
}
