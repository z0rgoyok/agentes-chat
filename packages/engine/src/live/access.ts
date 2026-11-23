import { and, type Executor, eq, schema } from "@agenteschat/db";
import type { LiveOrigin } from "@agenteschat/live";
import type { ArtifactActor, ArtifactAuthor } from "../artifacts";
import { availabilityNow } from "../member-status";
import type { LiveChangeActor } from "./store";

/**
 * Who changes a live file, as the server records it (ADR 0196 §1, §6). Whether someone may open or change one is
 * `liveFileAccess` / `requireLiveFile` in `artifacts.ts`, next to every other rule of who reads a Drive file; here is
 * how a change's origin becomes the author stored with it, and whether a person's presence may be shown.
 */

/**
 * The author a change is stored with, from the origin it was made with: an agent (with its run); a person (a server
 * path acting for them, such as a restore); the server itself otherwise.
 */
export function changeActorOf(origin: LiveOrigin): LiveChangeActor {
  if (origin.kind === "agent" && origin.agentId) {
    return { type: "agent", id: origin.agentId, runId: origin.runId ?? null };
  }
  if (origin.userId) return { type: "person", id: origin.userId };
  return { type: "system", id: null };
}

/** The origin of a change the server makes for someone (a restore, a person's image request landing). */
export function originFor(author: ArtifactAuthor, runId?: string | null): LiveOrigin {
  return author.type === "agent"
    ? { kind: "agent", agentId: author.id, ...(runId ? { runId } : {}) }
    : { kind: "system", userId: author.id };
}

/** An agent's tool call as the origin of its changes (`agentOrigin` with its run). */
export function originOfActor(actor: ArtifactActor): LiveOrigin {
  return actor.type === "agent"
    ? { kind: "agent", agentId: actor.agentId, ...(actor.runId ? { runId: actor.runId } : {}) }
    : { kind: "system", userId: actor.userId };
}

/**
 * Whether a person hides their availability in this workspace (ADR 0084): their presence in a live file isn't shown
 * to anyone (their changes still are).
 */
export async function personHides(db: Executor, orgId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({
      availability: schema.organizationMembers.availability,
      statusUntil: schema.organizationMembers.statusUntil,
    })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, userId)));
  return row ? availabilityNow(row) === "hidden" : false;
}
