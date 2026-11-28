import { and, desc, eq, isNull, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { audienceSql } from "./audience";
import { fallbackChoice, keptAutoChoice } from "./auto-model";
import { brainOf } from "./brain-settings";
import { brainSessionId } from "./brains/claude-code";
import { dmAgents } from "./dms";
import { type EngineDeps, warmAtClaim } from "./executor";
import { isRightHand, withPersonalBrain } from "./right-hand";
import type { AgentRun } from "./runs";
import { previousRunHere } from "./tool-loading";

const { agents, channels, messages } = schema;

/** A conversation warms its agent's CLI at most once this often, however often its typing frames come. */
export const TYPING_WARM_EVERY_MS = 2 * 60_000;

// ponytail: per process; a person's socket sits on one replica, so the same typing reaches one throttle.
const warmedAt = new Map<string, number>();

type TypingWhere = { orgId: string; channelId: string; threadId: string | null; userId: string };

/**
 * Who answers what the person is typing there, when one agent obviously does: the agent of a DM with one, or in a
 * thread the last agent that replied in it. The frame carries no text, so a mention can't be known before the send.
 * Only an agent this person may talk to in that channel (`audienceSql`), not archived nor held by the operator.
 */
async function typingReplier(deps: EngineDeps, where: TypingWhere): Promise<string | null> {
  const { db } = deps;
  const [channel] = await db
    .select({ kind: channels.kind })
    .from(channels)
    .where(and(eq(channels.orgId, where.orgId), eq(channels.id, where.channelId)));
  let agentId: string | null = null;
  if (channel?.kind === "dm") {
    const inDm = await dmAgents(db, where.orgId, where.channelId);
    agentId = inDm.length === 1 ? (inDm[0]?.id ?? null) : null;
  } else if (channel?.kind === "channel" && where.threadId) {
    const [last] = await db
      .select({ agentId: messages.authorAgentId })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, where.orgId),
          eq(messages.channelId, where.channelId),
          eq(messages.threadId, where.threadId),
          eq(messages.authorType, "agent"),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    agentId = last?.agentId ?? null;
  }
  if (!agentId) return null;
  const [ok] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, where.orgId),
        eq(agents.id, agentId),
        isNull(agents.archivedAt),
        isNull(agents.operatorHoldAt),
        sql`${audienceSql("agents", sql`${where.userId}::text`, { channelId: sql`${where.channelId}::uuid` })}`,
      ),
    );
  return ok ? agentId : null;
}

/**
 * A person types (`user.typing` from an app's socket, never a connected app's message, `meta.via`) where an agent
 * thinking with Claude Code will answer: its computer starts the CLI the next turn uses, as `warmAtClaim` would, so
 * it is open when the message is sent. Only for a session the conversation already has: a new conversation's turn
 * names its session after its own run, unknown before the send, and the runner's ready process serves it. A computer
 * in standby is woken, as the message's run would wake it. The runner starts nothing without room in memory, never
 * closes a busy process for it, and an unused one closes on its idle timer.
 */
export async function warmWhileTyping(deps: EngineDeps, where: TypingWhere, now = Date.now()) {
  if (!deps.brains?.claude_code) return;
  const key = `${where.orgId}:${where.channelId}:${where.threadId ?? ""}`;
  const last = warmedAt.get(key);
  if (last !== undefined && now - last < TYPING_WARM_EVERY_MS) return;
  if (warmedAt.size > 10_000) for (const [k, at] of warmedAt) if (now - at >= TYPING_WARM_EVERY_MS) warmedAt.delete(k);
  warmedAt.set(key, now);
  const agentId = await typingReplier(deps, where);
  const stored = agentId ? await getAgentCached(deps.db, where.orgId, agentId) : null;
  // The right hand thinks for the person who will send the message: their own AI, as their run's would.
  const agent = stored && isRightHand(stored) ? (await withPersonalBrain(deps.db, stored, where.userId)).agent : stored;
  if (!agent || brainOf(agent.brain) !== "claude_code") return;
  // The run the message will start, as far as its session and its kept choices go: nothing of it is written.
  const id = crypto.randomUUID();
  const run = {
    id,
    orgId: where.orgId,
    agentId: agent.id,
    channelId: where.channelId,
    threadRootId: where.threadId ?? id,
    triggerMessageId: id,
    replyInThread: where.threadId !== null,
    background: false,
    brain: null,
  } as unknown as AgentRun;
  const guess = previousRunHere(deps.db, run)
    .catch(() => null)
    .then((previous) => keptAutoChoice(fallbackChoice("none"), previous));
  const conversation = where.threadId ?? where.channelId;
  // What `resolveBrain` names a session it found none to pick up for: this run's own, which the real one won't get.
  const ownId = brainSessionId(agent.id, `${conversation}:${run.id}`, "claude_code");
  await warmAtClaim(
    deps,
    agent,
    run,
    conversation,
    null,
    where.userId,
    guess,
    null,
    async (plan) => {
      const machineId = plan.session?.machineId;
      if (plan.unavailable?.code === "machine_offline" && machineId) {
        const status = await deps.machines?.status(machineId).catch(() => null);
        if (status?.standby) {
          await deps.machines?.wake?.(machineId, "run");
          // Awake soon: a later frame warms its CLI.
          warmedAt.delete(key);
        }
        return false;
      }
      return Boolean(plan.session && plan.session.id !== ownId);
    },
    where.userId,
  );
}
