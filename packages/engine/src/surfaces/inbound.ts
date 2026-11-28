import { audioExtensionOf, type RateLimiter, retryInSeconds } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { type ArtifactDeps, createFileArtifact, deleteArtifact } from "../artifacts";
import { sha256 } from "../crypto";
import { markChannelRead, openPersonAgentDm } from "../dms";
import { ConflictError, NotFoundError, TooManyError, ValidationError } from "../errors";
import { surfaceWordsMeta } from "../message-origin";
import { fileIdsOf, MAX_MESSAGE_ATTACHMENTS, postPersonMessage, sentWithClientId } from "../messages";
import { getMembership } from "../organizations";
import { personLocale } from "../requester";
import { lodiFor } from "../right-hand-proactive";
import { acceptVoiceClip, type VoiceDeps } from "../voice";
import { surfaceAllowed, surfaceOn } from "./config";
import { activeLink, takeSurfaceCap } from "./links";

/**
 * A linked sender's message from the outside chat surface (ADR 0187), posted as that person in their DM with the
 * workspace's right hand, so its run starts as for any DM message.
 */

const { voiceClips, surfaceLinks, users } = schema;

/** A voice note's bytes may not outgrow its stated length by more than this: a bigger one is a file in disguise. */
export const VOICE_BYTES_PER_SECOND = 8192;
export const SURFACE_VOICE_MAX_BYTES = 16 * 1024 * 1024;

const PER_MINUTE = { limit: 20, windowMs: 60_000 };
const PER_DAY = { limit: 300, windowMs: 86_400_000 };

/** The surface's own message id as a `clientId`: a resend of the same message finds the one already posted. */
export const surfaceClientId = (surfaceId: string, inboundId: string) =>
  `s:${sha256(`${surfaceId}:${inboundId}`).slice(0, 40)}`;

/** Voice-note refusals that still let the recording through as a plain file. */
const VOICE_AS_FILE_CODES = new Set([
  "voice.unavailable",
  "voice.plan",
  "voice.too_large",
  "voice.bad_duration",
  "voice.limit",
  "voice.bad_type",
]);
export interface SurfacePost {
  externalId: string;
  inboundId: string;
  text?: string | null;
  /** Marked as forwarded from another chat: someone else's words, read as quoted text. */
  forwarded?: boolean;
  /** One of our message ids the sender quoted; dropped when it isn't in their DM. */
  replyTo?: string | null;
  files: { name: string; type: string; bytes: Uint8Array }[];
  voice?: { type: string; bytes: Uint8Array; durationMs: number } | null;
}

export type SurfacePosted = {
  /** `queued`: a voice note, posted by its job when its words are ready. */
  status: "posted" | "duplicate" | "queued";
  messageId: string | null;
  voiceAsFile: boolean;
  orgId: string;
  orgName: string;
  locale: string;
};

export type SurfaceInboundDeps = Parameters<typeof postPersonMessage>[0] & {
  artifacts: ArtifactDeps;
  voice: VoiceDeps | null;
  rateLimiter: RateLimiter;
  warn?: (message: string, data: Record<string, unknown>) => void;
};

async function takeLimit(rateLimiter: RateLimiter, key: string, rule: typeof PER_MINUTE, window: "minute" | "day") {
  const taken = await rateLimiter.consume(key, rule);
  if (!taken.allowed) {
    throw new TooManyError("Too many messages from this person", "surface.rate_limited", {
      retryIn: retryInSeconds(taken.resetAt),
      window,
    });
  }
}

/** Order and answers: the bridge contract's `POST /messages`. */
export async function postFromSurface(deps: SurfaceInboundDeps, input: SurfacePost): Promise<SurfacePosted> {
  const { db } = deps;
  const surface = surfaceOn();
  const link = surface ? await activeLink(db, input.externalId) : null;
  if (!surface || !link) throw new NotFoundError("This sender is not linked", "surface.unlinked");
  const { userId } = link;
  // Taken off the list of who may use it while it is tried: the link stays, but no longer carries messages.
  const [person] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!person || !surfaceAllowed(person.email))
    throw new NotFoundError("This sender is not linked", "surface.unlinked");
  const orgId = link.orgId;
  const membership = orgId ? await getMembership(db, userId, orgId) : null;
  if (!orgId || !membership) throw new ConflictError("The person is not in this workspace", "surface.no_workspace");
  const clientId = surfaceClientId(surface.id, input.inboundId);
  const answer = async (status: SurfacePosted["status"], messageId: string | null, voiceAsFile = false) => ({
    status,
    messageId,
    voiceAsFile,
    orgId,
    orgName: membership.orgName,
    locale: await personLocale(db, userId),
  });

  const sent = await sentWithClientId(db, orgId, userId, clientId);
  if (sent) return answer("duplicate", sent.id);
  if (input.voice) {
    const [clip] = await db
      .select({ messageId: voiceClips.messageId, status: voiceClips.status })
      .from(voiceClips)
      .where(and(eq(voiceClips.orgId, orgId), eq(voiceClips.userId, userId), eq(voiceClips.clientId, clientId)));
    // A dropped clip was handled too: the right hand told the person, so a resend must not queue it again.
    if (clip) return answer(clip.messageId || clip.status === "dropped" ? "duplicate" : "queued", clip.messageId);
  }

  const lodi = await lodiFor(db, orgId, userId);
  if (!lodi)
    throw new ConflictError("The assistant of this workspace can't talk to this person", "surface.no_assistant");
  if (input.files.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new ValidationError(`At most ${MAX_MESSAGE_ATTACHMENTS} files per message`, "message.too_many_attachments");
  }
  await takeLimit(deps.rateLimiter, `surface:post:${userId}`, PER_MINUTE, "minute");
  await takeLimit(deps.rateLimiter, `surface:post-day:${userId}`, PER_DAY, "day");
  await takeSurfaceCap({ db, rateLimiter: deps.rateLimiter, warn: deps.warn }, "posts");

  const dm = await openPersonAgentDm(db, orgId, userId, lodi.id);
  const actor = { type: "person" as const, userId };
  const attachments: string[] = [];
  for (const file of input.files) {
    const stored = await createFileArtifact(deps.artifacts, actor, orgId, {
      title: file.name,
      name: file.name,
      bytes: file.bytes,
      contentType: file.type,
      channelId: dm.id,
    });
    attachments.push(stored.id);
  }
  const via = {
    kind: "surface",
    surface: surface.id,
    linkId: link.id,
    ...(input.forwarded ? { forwarded: true } : {}),
  };
  // Files this call stored that no message will show: a refused post, or a resend that lost the race to the first.
  const discard = (keep: string[] = []) =>
    Promise.all(
      attachments
        .filter((id) => !keep.includes(id))
        .map((id) => deleteArtifact(deps.artifacts, userId, orgId, id).catch(() => null)),
    );
  const seen = () => db.update(surfaceLinks).set({ lastSeenAt: new Date() }).where(eq(surfaceLinks.id, link.id));

  let voiceAsFile = false;
  if (input.voice) {
    const { voice } = input;
    const fits =
      voice.bytes.length <= SURFACE_VOICE_MAX_BYTES &&
      voice.bytes.length <= VOICE_BYTES_PER_SECOND * Math.ceil(voice.durationMs / 1000);
    // No engine on the server: a voice message would reach the agent as a note it can't hear, so the file goes.
    if (fits && deps.voice && deps.voice.engines().length > 0) {
      try {
        await acceptVoiceClip(deps.voice, userId, orgId, dm.id, {
          audio: voice.bytes,
          contentType: voice.type,
          durationMs: voice.durationMs,
          peaks: [],
          clientId,
          text: input.text ?? null,
          attachments,
          replyTo: await replyInDm(db, orgId, dm.id, input.replyTo),
          via,
        });
        await seen();
        return answer("queued", null);
      } catch (error) {
        if (!(error instanceof ValidationError && VOICE_AS_FILE_CODES.has(error.code))) {
          await discard();
          throw error;
        }
      }
    }
    const name = `voice.${audioExtensionOf(voice.type) ?? "audio"}`;
    const stored = await createFileArtifact(deps.artifacts, actor, orgId, {
      title: name,
      name,
      bytes: voice.bytes,
      contentType: voice.type,
      channelId: dm.id,
    });
    attachments.push(stored.id);
    voiceAsFile = true;
  }

  const message = await postPersonMessage(
    { db, pubsub: deps.pubsub, judge: deps.judge, talker: deps.talker, gifs: deps.gifs },
    userId,
    orgId,
    dm.id,
    {
      body: input.text ?? "",
      attachments,
      replyTo: await replyInDm(db, orgId, dm.id, input.replyTo),
      clientId,
      origin: "surface",
      meta: { via, ...surfaceWordsMeta(via) },
    },
  ).catch(async (error: unknown) => {
    await discard();
    throw error;
  });
  await discard(fileIdsOf(message.meta));
  await markChannelRead(db, userId, orgId, dm.id, new Date(message.createdAt), deps.pubsub);
  await seen();
  return answer("posted", message.id, voiceAsFile);
}

/** The quoted message when it is in this DM; anything else is dropped rather than refusing the whole message. */
async function replyInDm(db: Database, orgId: string, channelId: string, replyTo: string | null | undefined) {
  if (!replyTo) return null;
  const { messages } = schema;
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.id, replyTo),
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
      ),
    );
  return row?.id ?? null;
}
