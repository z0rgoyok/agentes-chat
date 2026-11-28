import { SPEECH_PROVIDERS } from "@agenteschat/adapters";
import {
  acceptVoiceClip,
  isAgentesCloud,
  type LocalSpeech,
  MAX_MESSAGE_LENGTH,
  NotFoundError,
  pinnedOwner,
  requirePermission,
  type SpeechSettings,
  ValidationError,
  VOICE_MAX_BYTES,
  type VoiceDeps,
  voiceAllowed,
  voiceClipAudio,
  voiceNeedsPlan,
  voiceOn,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { storedResponse } from "../../http/byte-range";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Chat"];

/** Multipart overhead allowed on top of the recording. */
const MULTIPART_SLACK_BYTES = 64 * 1024;
const SENDS_PER_PERSON = { limit: 30, windowMs: 60_000 };
/** Limits checking keys through this server, so it can't test keys in bulk. */
const KEY_WRITES = { limit: 10, windowMs: 60_000 };

const ChannelParams = OrgParams.extend({ channelId: z.uuid() });
const ClipParams = OrgParams.extend({ clipId: z.uuid() });
// The count is the engine's to refuse (`message.too_many_attachments`), as for a typed message.
const AttachmentIds = z.array(z.uuid());

/**
 * Voice messages (ADR 0100): the app sends the finished recording and shows it at once; the message arrives over the
 * socket when its words are ready, or `voice.dropped` on the sender's topic when nothing was said.
 */
export function voiceRoutes(deps: AppDeps) {
  const { adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use(
    "/organizations/:orgId/channels/:channelId/voice",
    bodyLimit({
      maxSize: VOICE_MAX_BYTES + MULTIPART_SLACK_BYTES,
      onError: (c) => apiError(c, 413, "voice.too_large", "The recording is too large"),
    }),
  );
  const voice = (): VoiceDeps => {
    const v = deps.extras?.voice;
    if (!v) throw new NotFoundError();
    return v;
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/voice",
      tags,
      security,
      summary: "Send a voice message: the recording is kept and its message follows",
      description:
        "Answers once the recording is stored. The message comes over the socket with `clientId`; `voice.dropped` " +
        "on the person's topic means nothing was said. A resend with the same `clientId` writes nothing new.",
      request: {
        params: ChannelParams,
        body: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: z.object({
                file: z.any().openapi({ type: "string", format: "binary", description: "The recording." }),
                durationMs: z.coerce.number().int().positive(),
                peaks: z.string().max(10_000).optional().openapi({ description: "JSON array of the wave, 0 to 1." }),
                clientId: z.string().min(1).max(64),
                threadId: z.uuid().optional(),
                replyTo: z.uuid().optional(),
                language: z
                  .string()
                  .max(8)
                  .optional()
                  .openapi({ description: "The app's language (`pt`, `en`): a hint for engines that take one." }),
                // Only a bound on what is parsed: the limit people are told is the engine's (`message.too_long`).
                text: z
                  .string()
                  .max(MAX_MESSAGE_LENGTH * 10)
                  .optional()
                  .openapi({
                    description: `Typed beside the take, up to ${MAX_MESSAGE_LENGTH} characters: the message's \`body\` starts with it, then a blank line, then the words, and \`meta.voice.text\` holds it.`,
                  }),
                attachments: z.string().max(4000).optional().openapi({
                  description:
                    "JSON array of file (artifact) ids you uploaded or of this channel, as a typed message's `attachments`: stored as the message's `meta.artifacts`.",
                }),
              }),
            },
          },
        },
      },
      responses: {
        202: json(z.object({ clipId: z.uuid() }), "Stored; its words are on the way"),
        ...errors,
        409: errorResponse("Voice messages are off (`voice.unavailable`), or come with a plan (`voice.plan`)"),
        413: errorResponse("The recording is too large (`voice.too_large`)"),
        429: errorResponse("Too many (`voice_limit`, `rate_limited`)"),
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const form = c.req.valid("form");
      const user = c.get("user");
      if (!(await adapters.rateLimiter.consume(`voice:${user.id}`, SENDS_PER_PERSON)).allowed) {
        return apiError(c, 429, "rate_limited", "Slow down");
      }
      const file: unknown = form.file;
      if (!(file instanceof File)) throw new ValidationError("send the recording in the field file", "voice.bad_type");
      let ids: unknown = null;
      try {
        ids = JSON.parse(form.attachments ?? "[]");
      } catch {
        ids = null;
      }
      const attachments = AttachmentIds.safeParse(ids);
      if (!attachments.success) {
        throw new ValidationError("attachments is a JSON array of file ids", "message.attachment_not_found");
      }
      let peaks: unknown = [];
      try {
        peaks = JSON.parse(form.peaks ?? "[]");
      } catch {
        peaks = [];
      }
      try {
        const accepted = await acceptVoiceClip(voice(), user.id, orgId, channelId, {
          audio: new Uint8Array(await file.arrayBuffer()),
          contentType: file.type,
          durationMs: form.durationMs,
          peaks,
          clientId: form.clientId,
          threadId: form.threadId ?? null,
          replyTo: form.replyTo ?? null,
          language: form.language ?? null,
          text: form.text ?? null,
          attachments: attachments.data,
        });
        deps.wakeWorkers?.();
        return c.json(accepted, 202);
      } catch (error) {
        if (error instanceof ValidationError) {
          if (error.code === "voice.limit") return apiError(c, 429, "voice_limit", error.message);
          if (error.code === "voice.unavailable" || error.code === "voice.plan") {
            return apiError(c, 409, error.code, error.message);
          }
          if (error.code === "voice.too_large") return apiError(c, 413, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/voice/allowed",
      tags,
      security,
      summary: "Whether this person may start recording now",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            allowed: z.boolean(),
            reason: z.enum(["plan"]).optional().openapi({
              description: "`plan`: the workspace has no plan in force (a billing hold), and voice comes with one.",
            }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const userId = c.get("user").id;
      await requirePermission(deps.db, userId, orgId, "read");
      const v = deps.extras?.voice;
      if (!v || !(await voiceOn(v, orgId))) return c.json({ allowed: false }, 200);
      if (await voiceNeedsPlan(deps.db, orgId)) return c.json({ allowed: false, reason: "plan" as const }, 200);
      const allowed = await voiceAllowed(v, userId, orgId);
      // The app asks just before recording: a server of one's own that loads its model on demand starts now.
      if (allowed) for (const engine of v.engines()) engine.warm?.(orgId);
      return c.json({ allowed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/voice/{clipId}/audio",
      tags,
      security,
      summary: "A voice message's recording, for who can read its channel",
      request: { params: ClipParams },
      responses: {
        200: { description: "The audio" },
        206: { description: "Part of the audio" },
        302: { description: "A short-lived link to the audio" },
        410: errorResponse("Past its retention (`voice.expired`): the message stays, the audio is gone"),
        416: { description: "Range not satisfiable" },
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, clipId } = c.req.valid("param");
      const audio = await voiceClipAudio(voice(), c.get("user").id, orgId, clipId);
      if ("expired" in audio) return apiError(c, 410, "voice.expired", "This recording is no longer kept");
      if ("url" in audio) return c.redirect(audio.url, 302);
      return storedResponse(audio, c.req.header("range"), {
        "content-type": audio.contentType,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      });
    },
  );

  return app;
}

const KeyView = z
  .object({
    provider: z.enum(SPEECH_PROVIDERS).nullable(),
    hint: z.string().nullable().openapi({ description: "The key's last 4 characters, or the server's address." }),
    state: z.enum(["off", "ok", "invalid"]).openapi({
      description: "`invalid`: a saved key that doesn't open on this server (another `AGENTES_SECRET`).",
    }),
    envProviders: z.array(z.enum(SPEECH_PROVIDERS)).openapi({ description: "Engines set in the environment." }),
  })
  .openapi("SpeechKey");

const LocalStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("off") }),
  z.object({ state: z.literal("downloading"), doneBytes: z.number(), totalBytes: z.number() }),
  z.object({ state: z.literal("starting") }),
  z.object({ state: z.literal("ready") }),
  z.object({
    state: z.literal("failed"),
    reason: z.enum(["download", "disk", "start"]),
    detail: z.string().openapi({ description: "What stopped it, in the network's or the helper's own words." }),
  }),
]);

const LocalView = z
  .object({
    fit: z.enum(["fits", "memory", "disk", "platform"]).openapi({
      description:
        "`memory`: under 8 GB (a container's limit counts) or one CPU. `disk`: under `needDiskBytes` free. `platform`: no build for this computer, or no files folder to keep it in.",
    }),
    memoryBytes: z.number(),
    freeDiskBytes: z.number().nullable(),
    needDiskBytes: z.number(),
    sizeBytes: z.number().openapi({ description: "The whole download." }),
    status: LocalStatus,
  })
  .openapi("LocalSpeech");

const SaveKey = z.object({
  provider: z.enum(SPEECH_PROVIDERS),
  apiKey: z.string().trim().min(8).max(512).optional().openapi({
    description: "The provider's key, tried with a second of silence before it is stored. Never returned.",
  }),
  baseUrl: z.url().max(512).optional().openapi({ description: "`local`: a server speaking the OpenAI format." }),
  model: z.string().trim().max(100).optional().openapi({ description: "`local`: the model it loads." }),
});

const notFound = "404 for everyone but the installation's pinned owner (ADR 0073), and on agentes.chat itself.";

/** Who turns voice into text on this server (ADR 0100): only its pinned owner, and never on agentes.chat's servers. */
export function speechKeyRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/speech-key", requireSession(deps.auth));
  app.use("/speech-local", requireSession(deps.auth));

  const ownerOnly = async (userId: string): Promise<SpeechSettings> => {
    const speech = deps.extras?.speech;
    if (!speech || isAgentesCloud(config.PUBLIC_URL) || (await pinnedOwner(db)) !== userId) throw new NotFoundError();
    return speech;
  };
  const allowed = async (userId: string) =>
    (await deps.adapters.rateLimiter.consume(`speech-key:${userId}`, KEY_WRITES)).allowed;

  app.openapi(
    createRoute({
      method: "get",
      path: "/speech-key",
      tags: ["System"],
      summary: "The installation's speech provider",
      description: notFound,
      security,
      responses: { 200: json(KeyView), 401: errors[401], 404: errors[404] },
    }),
    async (c) => c.json(await (await ownerOnly(c.get("user").id)).view(), 200),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/speech-key",
      tags: ["System"],
      summary: "Pick a speech provider and add its key",
      description: `${notFound} A provider that refuses the key leaves nothing stored (422 \`speech_key_invalid\`).`,
      security,
      request: { body: body(SaveKey) },
      responses: {
        200: json(KeyView),
        ...errors,
        422: errorResponse("The key was refused, or the server can't be reached (`speech_key_invalid`)"),
        429: errorResponse("Too many tries (`rate_limited`)"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const speech = await ownerOnly(user.id);
      if (!(await allowed(user.id))) return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      try {
        return c.json(await speech.save(c.req.valid("json"), user.id), 200);
      } catch (error) {
        if (error instanceof ValidationError && error.code === "speech_key_invalid") {
          return apiError(c, 422, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/speech-key",
      tags: ["System"],
      summary: "Remove the speech provider",
      description: `${notFound} Without an engine in the environment, the microphone goes from every workspace.`,
      security,
      responses: { 200: json(KeyView), 401: errors[401], 404: errors[404] },
    }),
    async (c) => c.json(await (await ownerOnly(c.get("user").id)).remove(), 200),
  );

  const localOnly = async (userId: string): Promise<LocalSpeech> => {
    await ownerOnly(userId);
    const local = deps.extras?.speechLocal;
    if (!local) throw new NotFoundError();
    return local;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/speech-local",
      tags: ["System"],
      summary: "Speech to text on this server's own computer: whether it fits, and how its setup goes",
      description: `${notFound} Polled while it downloads (\`status.doneBytes\` of \`totalBytes\`).`,
      security,
      responses: { 200: json(LocalView), 401: errors[401], 404: errors[404] },
    }),
    async (c) => c.json(await (await localOnly(c.get("user").id)).view(), 200),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/speech-local",
      tags: ["System"],
      summary: "Download the speech model to this server's computer and turn it on (or go on with the download)",
      description: `${notFound} Answers at once; the download goes on in the background. Nothing starts when \`fit\` isn't \`fits\`.`,
      security,
      responses: { 200: json(LocalView), 401: errors[401], 404: errors[404] },
    }),
    async (c) => c.json(await (await localOnly(c.get("user").id)).install(), 200),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/speech-local",
      tags: ["System"],
      summary: "Stop the download or the speech model on this computer, and remove its files",
      description: notFound,
      security,
      responses: { 200: json(LocalView), 401: errors[401], 404: errors[404] },
    }),
    async (c) => c.json(await (await localOnly(c.get("user").id)).remove(), 200),
  );

  return app;
}
