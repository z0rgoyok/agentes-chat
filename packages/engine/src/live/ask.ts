import type { PubSub } from "@agenteschat/adapters";
import { and, eq, isNull, schema } from "@agenteschat/db";
import { type ArtifactDeps, liveFileAccess } from "../artifacts";
import { openDm } from "../dms";
import { NotFoundError, ValidationError } from "../errors";
import type { Judge } from "../judge";
import { MAX_MESSAGE_LENGTH, postPersonMessage } from "../messages";
import type { Talker } from "../talker";
import { admitFileAgents, cleanSelection, ensureFileConversation, type LiveAskSelection } from "./conversation";

/**
 * "Ask an agent" from inside a live file (ADR 0196 §6, ADR 0199): the person's own message to the agent, carrying
 * what they had selected (`meta.liveRef`), posted in the file's own conversation, where the agent works on the file
 * while everyone in it watches. Kept for older apps: the apps now write in the file's conversation themselves.
 */

export { cleanSelection, type LiveAskSelection };

export type LiveAskDeps = ArtifactDeps & { pubsub: PubSub; judge?: Judge; talker?: Talker };

const { agents, channelMembers } = schema;

/**
 * Sends the person's message to the agent about a live file they read, and returns it. Where it goes: the file's own
 * conversation (made on first use), naming the agent, when the agent may work on the file there (`admitFileAgents`);
 * else their DM with the agent, carrying the file (a file in a conversation the agent isn't in). Refused as "not found"
 * for a file the person doesn't read (or that isn't a live file) and an agent that isn't there; who may talk to the
 * agent and post is the post's own check.
 */
export async function askAgentAbout(
  deps: LiveAskDeps,
  userId: string,
  orgId: string,
  fileId: string,
  input: { agentId: string; text: string; selection?: LiveAskSelection },
): Promise<{ id: string; channelId: string; threadId: string | null }> {
  const text = input.text.trim();
  if (!text) throw new ValidationError("Say what the agent should do");
  if (text.length > MAX_MESSAGE_LENGTH) throw new ValidationError("That is too long to send");
  const access = await liveFileAccess(deps, { type: "person", userId }, orgId, fileId);
  if (!access || access.artifact.deletedAt) throw new NotFoundError("Artifact not found", "artifact.not_found");
  const [agent] = await deps.db
    .select({ id: agents.id, handle: agents.handle })
    .from(agents)
    .where(
      and(eq(agents.orgId, orgId), eq(agents.id, input.agentId), isNull(agents.archivedAt), isNull(agents.deletedAt)),
    );
  if (!agent) throw new NotFoundError("Agent not found");
  const file = access.artifact;
  const selection = cleanSelection(input.selection);
  const liveRef = { artifactId: file.id, kind: access.kind, title: file.title, ...(selection ? { selection } : {}) };
  const conversation = await ensureFileConversation(deps.db, file.id);
  await admitFileAgents(deps.db, orgId, conversation.channelId, { handles: [agent.handle] });
  const [member] = await deps.db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, conversation.channelId), eq(channelMembers.agentId, agent.id)));
  if (member) {
    const sent = await postPersonMessage(deps, userId, orgId, conversation.channelId, {
      body: `@${agent.handle} ${text}`,
      threadId: conversation.rootId,
      meta: { liveRef },
    });
    return { id: sent.id, channelId: sent.channelId, threadId: sent.threadId ?? null };
  }
  const dm = await openDm(deps.db, userId, orgId, { agentId: agent.id }, { pubsub: deps.pubsub });
  const sent = await postPersonMessage(deps, userId, orgId, dm.id, {
    body: text,
    meta: { liveRef, artifacts: [{ id: file.id, version: file.currentVersion, title: file.title }] },
  });
  return { id: sent.id, channelId: sent.channelId, threadId: sent.threadId ?? null };
}
