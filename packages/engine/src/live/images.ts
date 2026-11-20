import { and, type Executor, eq, inArray, schema } from "@agenteschat/db";
import type { PeerUser } from "@agenteschat/live/awareness";
import { addShape, deleteShapes, fillPending, placeBoxes, readShapes, updateShape } from "@agenteschat/live/canvas";
import {
  aspectRatio,
  bytesToBase64,
  IMAGE_ASPECTS,
  type ImageAspect,
  type ImageReference,
  imageModelInfo,
  isImageBlocked,
  MAX_IMAGE_PROMPT_CHARS,
  MAX_IMAGE_REFERENCES,
  nearestAspect,
  ProviderError,
  providerCause,
  type ToolImage,
  typicalImageCostNanoUsd,
} from "@agenteschat/providers";
import type * as Y from "yjs";
import { type ArtifactActor, type ArtifactDeps, createFileArtifact, requireLiveFile } from "../artifacts";
import { accountablePerson, runAuthorityById, UUID } from "../authority";
import { MODEL_IMAGE_BYTES } from "../avatars";
import {
  BudgetExceededError,
  MissingCredentialError,
  NotFoundError,
  PersonLimitError,
  ValidationError,
} from "../errors";
import type { ModelGateway } from "../gateway";
import { pictureSize } from "../image-size";
import { enqueue, type JobHandlers } from "../outbox";
import { replyThreadOf } from "../runs";
import { originFor } from "./access";
import { getAsset, type LiveAsset, putAsset, readPictureFile } from "./assets";
import type { LiveDocs } from "./docs";
import { rasterPicture } from "./svg";

/**
 * Pictures made with the workspace's image AI (ADR 0197), on a canvas or in a conversation.
 *
 * On a canvas, a request first places a frame titled with the prompt and one placeholder per picture, so everyone in
 * the canvas sees what is coming and who asked; the `live.image` job calls the Model Gateway, stores each picture as an
 * asset of the canvas and turns each placeholder into its picture (same id, same place), with its prompt, model, who
 * asked and the pictures it started from. A failure leaves the placeholders saying why (`ImageFailure`), with Try
 * again (`retryImages`). Agents wait for theirs (`generateForAgent`).
 *
 * In a conversation, an agent asked for pictures gets them as image files on its reply (`generateInChat`): made
 * through the gateway while it waits, each saved as a Drive file where its run posts, so people see them in the chat
 * and can put one on a canvas later (`create_canvas` with `images`).
 */

const { liveImageRequests, artifacts, agentRuns } = schema;

export const LIVE_IMAGE_JOB = "live.image";
/** Attempts of one request's job: a provider that is down or limiting gets two more chances, then it fails. */
const JOB_ATTEMPTS = 3;
/** The most one provider call may take before the request fails (`provider`). */
export const IMAGE_CALL_TIMEOUT_MS = 180_000;
/** The most an agent waits for its pictures (ADR 0197): two minutes. */
export const AGENT_IMAGE_WAIT_MS = 120_000;
/** A placeholder's longest side on the canvas, in world units. */
const PLACEHOLDER_SIDE = 384;
/** The frame around a request is titled with its prompt, this long at most. */
const FRAME_NAME_CHARS = 60;

export type ImageRequestStatus = "queued" | "running" | "done" | "failed";
/**
 * Why pictures weren't made, as the placeholders say it: no key for the model's provider, the agent's budget or the
 * person's limit, the provider refused the prompt, the provider failed, or the canvas or the workspace's storage is
 * full.
 */
export type ImageFailure = "no_key" | "budget" | "limit" | "blocked" | "provider" | "too_many";

export interface LiveImageDeps {
  artifacts: ArtifactDeps;
  live: LiveDocs;
  gateway: ModelGateway;
  /** Wakes this process's workers after a job was queued (sooner than their next poll). */
  wake?: () => void;
  now?: () => Date;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/** An image model a workspace can use now, as the canvas's menu lists it (the default first). */
export interface ImageModelOption {
  id: string;
  label: string;
  provider: string;
  aspects: ImageAspect[];
  maxCount: number;
  refs: boolean;
  /** What a typical picture costs, in USD: only for whoever may see usage. */
  pricePerImage?: number;
}

export interface ImageRequestInput {
  prompt: string;
  /** 1 to the model's most (four); default 1. */
  count?: number;
  /** Default square; a model that doesn't take it gets its nearest. */
  aspect?: ImageAspect;
  /** An id of `availableImageModels`; default the workspace's first. */
  model?: string | null;
  /** The canvas's pictures to start from: shape ids (or the canvas's asset ids). */
  references?: string[];
  /** Where on the canvas (world units) the new pictures go; else where there's room. */
  at?: { x: number; y: number } | null;
}

/** A request as the apps and tools see it: its placeholders are on the canvas already. */
export interface ImageRequestView {
  requestId: string;
  artifactId: string;
  status: ImageRequestStatus;
  /** The placeholders' shape ids (the pictures take the same ids). */
  shapeIds: string[];
  /** The frame they were placed in, titled with the prompt. */
  frameId: string | null;
  model: string;
  prompt: string;
  count: number;
  aspect: ImageAspect;
  error: ImageFailure | null;
  /** The pictures made so far, as assets of the canvas. */
  assetIds: string[];
  costNanoUsd: number;
}

type RequestRow = typeof liveImageRequests.$inferSelect;

const FAILURES: readonly ImageFailure[] = ["no_key", "budget", "limit", "blocked", "provider", "too_many"];
const failureOf = (value: string | null): ImageFailure | null =>
  FAILURES.includes(value as ImageFailure) ? (value as ImageFailure) : null;

function viewOf(row: RequestRow): ImageRequestView {
  return {
    requestId: row.id,
    artifactId: row.artifactId,
    status: (["queued", "running", "done", "failed"] as const).includes(row.status as ImageRequestStatus)
      ? (row.status as ImageRequestStatus)
      : "queued",
    shapeIds: row.shapeIds,
    frameId: row.frameId,
    model: row.model,
    prompt: row.prompt,
    count: row.count,
    aspect: IMAGE_ASPECTS.includes(row.aspect as ImageAspect) ? (row.aspect as ImageAspect) : "1:1",
    error: failureOf(row.error),
    assetIds: row.assetIds,
    costNanoUsd: row.costNanoUsd,
  };
}

const peerOf = (actor: ArtifactActor): PeerUser =>
  actor.type === "person" ? { kind: "person", id: actor.userId } : { kind: "agent", id: actor.agentId };

const authorOf = (actor: ArtifactActor) =>
  actor.type === "person"
    ? { type: "person" as const, id: actor.userId }
    : { type: "agent" as const, id: actor.agentId };

const runOf = (actor: ArtifactActor) => {
  const run = actor.type === "agent" ? actor.runId : null;
  return run && UUID.test(run) ? run : null;
};

/** A placeholder's box for an aspect: `PLACEHOLDER_SIDE` on its longest side. */
function boxOf(aspect: ImageAspect) {
  const ratio = aspectRatio(aspect);
  return ratio >= 1
    ? { w: PLACEHOLDER_SIDE, h: Math.round(PLACEHOLDER_SIDE / ratio) }
    : { w: Math.round(PLACEHOLDER_SIDE * ratio), h: PLACEHOLDER_SIDE };
}

/** The frame's name: the prompt on one line, cut to `FRAME_NAME_CHARS`. */
function frameName(prompt: string) {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > FRAME_NAME_CHARS ? `${line.slice(0, FRAME_NAME_CHARS - 1).trimEnd()}…` : line;
}

/**
 * The image models a workspace can use now (`ModelGateway.availableImageModels`: a key for their provider), the
 * default first, with what a typical picture costs for those who may see usage (`prices`).
 */
export async function imageModelsFor(
  deps: Pick<LiveImageDeps, "gateway">,
  orgId: string,
  options: { prices?: boolean } = {},
): Promise<ImageModelOption[]> {
  const ids = await deps.gateway.availableImageModels(orgId);
  return ids.flatMap((id) => {
    const info = imageModelInfo(id);
    if (!info) return [];
    const price = options.prices ? typicalImageCostNanoUsd(id) : null;
    return [
      {
        id,
        label: info.label,
        provider: info.provider,
        aspects: [...info.aspects],
        maxCount: info.maxCount,
        refs: info.refs,
        ...(price !== null ? { pricePerImage: price / 1e9 } : {}),
      },
    ];
  });
}

/** The model a request uses: the one asked when the workspace can use it, else its default; none: no key at all. */
async function modelFor(deps: Pick<LiveImageDeps, "gateway">, orgId: string, asked?: string | null) {
  const available = await deps.gateway.availableImageModels(orgId);
  if (available.length === 0) {
    throw new ValidationError(
      "No image AI is connected: add an OpenAI, Gemini or OpenRouter key in the workspace settings",
      "images.no_model",
    );
  }
  const model = asked ?? available[0];
  if (!model || !available.includes(model)) {
    throw new ValidationError(`The image model ${asked} isn't available in this workspace`, "images.model_unavailable");
  }
  const info = imageModelInfo(model);
  if (!info) throw new ValidationError(`The image model ${model} isn't available`, "images.model_unavailable");
  return { model, info };
}

/** A canvas the actor may change, or why not. */
async function writableCanvas(deps: LiveImageDeps, actor: ArtifactActor, orgId: string, fileId: string) {
  const access = await requireLiveFile(deps.artifacts, actor, orgId, fileId, { write: true });
  if (access.kind !== "canvas") throw new ValidationError("Images are made on a canvas", "images.not_canvas");
  return access;
}

/** The canvas's pictures a request starts from: image shapes (or the canvas's asset ids), as asset ids. */
async function referenceAssets(
  deps: LiveImageDeps,
  orgId: string,
  fileId: string,
  refs: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(refs)];
  if (wanted.length === 0) return [];
  if (wanted.length > MAX_IMAGE_REFERENCES) {
    throw new ValidationError(`At most ${MAX_IMAGE_REFERENCES} pictures to start from`, "images.reference");
  }
  const { doc } = await deps.live.read(orgId, fileId);
  let byShape: Map<string, string>;
  try {
    byShape = new Map(
      readShapes(doc, { text: false }).flatMap((s) => (s.type === "image" && s.asset ? [[s.id, s.asset]] : [])),
    );
  } finally {
    doc.destroy();
  }
  const assetIds = wanted.filter((ref) => UUID.test(ref) && !byShape.has(ref));
  const known = assetIds.length
    ? new Set(
        (
          await deps.artifacts.db
            .select({ id: schema.liveAssets.id })
            .from(schema.liveAssets)
            .where(
              and(
                eq(schema.liveAssets.orgId, orgId),
                eq(schema.liveAssets.artifactId, fileId),
                inArray(schema.liveAssets.id, assetIds),
              ),
            )
        ).map((r) => r.id),
      )
    : new Set<string>();
  return wanted.map((ref) => {
    const asset = byShape.get(ref) ?? (known.has(ref) ? ref : null);
    if (!asset) throw new ValidationError("Start only from pictures on this canvas", "images.reference");
    return asset;
  });
}

/**
 * Places a request on the canvas in one change: a frame named with the prompt (around `at`, else where there's room),
 * and a placeholder per picture inside it, each saying the request, its place, the prompt and who asked.
 */
function placeRequest(
  doc: Y.Doc,
  input: { count: number; aspect: ImageAspect; prompt: string; at?: { x: number; y: number } | null },
  request: { id: string; by: PeerUser },
  origin: unknown,
) {
  const { w, h } = boxOf(input.aspect);
  const near = input.at && Number.isFinite(input.at.x) && Number.isFinite(input.at.y) ? input.at : undefined;
  const name = frameName(input.prompt);
  const placed = placeBoxes(doc, { count: input.count, w, h, gap: 32, ...(near ? { near } : {}), frame: { name } });
  const box = placed.frame ?? { x: 0, y: 0, w, h };
  const frameId = addShape(doc, { type: "frame", name, x: box.x, y: box.y, w: box.w, h: box.h }, origin);
  const shapeIds = placed.boxes.map((b, index) =>
    addShape(
      doc,
      {
        type: "pending",
        parent: frameId,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        request: request.id,
        index,
        status: "queued",
        prompt: input.prompt,
        by: request.by,
      },
      origin,
    ),
  );
  return { frameId, shapeIds };
}

async function queueJob(db: Executor, orgId: string, requestId: string, attempt: string) {
  await enqueue(db, {
    orgId,
    kind: LIVE_IMAGE_JOB,
    payload: { requestId },
    dedupeKey: `${LIVE_IMAGE_JOB}:${requestId}:${attempt}`,
    maxAttempts: JOB_ATTEMPTS,
  });
}

/**
 * Asks for pictures on a canvas the actor may change: the frame and its placeholders land at once, the request is
 * recorded and its job queued, and the request comes back as the apps and tools see it. Refused before anything lands
 * when the workspace has no image model (`images.no_model`), the model asked isn't one it can use
 * (`images.model_unavailable`), the file isn't a canvas (`images.not_canvas`) or a reference isn't one of its pictures
 * (`images.reference`).
 */
export async function requestImages(
  deps: LiveImageDeps,
  actor: ArtifactActor,
  orgId: string,
  canvasId: string,
  input: ImageRequestInput,
): Promise<ImageRequestView> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new ValidationError("Say what the pictures should show");
  if (prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    throw new ValidationError(`The prompt is over ${MAX_IMAGE_PROMPT_CHARS} characters`);
  }
  const { model, info } = await modelFor(deps, orgId, input.model);
  const asked = Number.isFinite(input.count) ? Math.floor(input.count as number) : 1;
  const count = Math.min(info.maxCount, Math.max(1, asked));
  const aspect = nearestAspect(info, input.aspect && IMAGE_ASPECTS.includes(input.aspect) ? input.aspect : "1:1");
  const fileId = (await writableCanvas(deps, actor, orgId, canvasId)).artifact.id;
  const references = await referenceAssets(deps, orgId, fileId, input.references ?? []);
  if (references.length > 0 && !info.refs) {
    throw new ValidationError(`${info.label} takes no pictures to start from`, "images.reference");
  }
  const requestId = Bun.randomUUIDv7();
  const by = peerOf(actor);
  const origin = originFor(authorOf(actor), runOf(actor));
  const { result: placed } = await deps.live.edit(orgId, fileId, origin, (doc) =>
    placeRequest(doc, { count, aspect, prompt, at: input.at }, { id: requestId, by }, origin),
  );
  let row: RequestRow | undefined;
  try {
    row = await deps.artifacts.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(liveImageRequests)
        .values({
          id: requestId,
          orgId,
          artifactId: fileId,
          requestedByType: actor.type,
          requestedById: by.id,
          runId: runOf(actor),
          prompt,
          model,
          count: placed.shapeIds.length,
          aspect,
          references,
          shapeIds: placed.shapeIds,
          frameId: placed.frameId,
          status: "queued",
        })
        .returning();
      await queueJob(tx, orgId, requestId, "first");
      return inserted;
    });
  } catch (error) {
    // Nothing will come to them: the placeholders go rather than wait forever.
    await deps.live
      .edit(orgId, fileId, origin, (doc) => deleteShapes(doc, [placed.frameId], origin))
      .catch(() => undefined);
    throw error;
  }
  if (!row) throw new Error("image request insert returned nothing");
  deps.wake?.();
  return viewOf(row);
}

/**
 * Try again (ADR 0197): the request's failed placeholders wait again (or new ones are placed when they were all
 * deleted), its job is queued anew, and the request is now the actor's (their budget or limit, their name on the
 * pictures). A request still waiting or running, or one that made every picture, comes back as it is.
 */
export async function retryImages(
  deps: LiveImageDeps,
  actor: ArtifactActor,
  orgId: string,
  canvasId: string,
  requestId: string,
): Promise<ImageRequestView> {
  await writableCanvas(deps, actor, orgId, canvasId);
  const { db } = deps.artifacts;
  const [row] = UUID.test(requestId)
    ? await db
        .select()
        .from(liveImageRequests)
        .where(
          and(
            eq(liveImageRequests.id, requestId),
            eq(liveImageRequests.orgId, orgId),
            eq(liveImageRequests.artifactId, canvasId),
          ),
        )
    : [];
  if (!row) throw new NotFoundError("Image request not found");
  if (row.status === "queued" || row.status === "running") return viewOf(row);
  const { model } = await modelFor(deps, orgId, row.model).catch(async (error: unknown) => {
    // The model it used is gone (its key removed): the workspace's default makes them now.
    if (error instanceof ValidationError && error.code === "images.model_unavailable") return modelFor(deps, orgId);
    throw error;
  });
  const by = peerOf(actor);
  const origin = originFor(authorOf(actor), runOf(actor));
  const { result: again } = await deps.live.edit(orgId, canvasId, origin, (doc) => {
    const failed = readShapes(doc, { text: false }).filter(
      (s) => s.type === "pending" && s.request === requestId && s.status === "failed",
    );
    for (const s of failed) updateShape(doc, s.id, { status: "queued", error: null, by }, origin);
    if (failed.length > 0) return { shapeIds: failed.map((s) => s.id), frameId: row.frameId };
    if (row.status === "done" && !row.error) return null;
    const missing = Math.max(1, row.count - row.assetIds.length);
    const aspect = IMAGE_ASPECTS.includes(row.aspect as ImageAspect) ? (row.aspect as ImageAspect) : "1:1";
    return placeRequest(doc, { count: missing, aspect, prompt: row.prompt }, { id: requestId, by }, origin);
  });
  if (!again) return viewOf(row);
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(liveImageRequests)
      .set({
        status: "queued",
        error: null,
        model,
        requestedByType: actor.type,
        requestedById: by.id,
        runId: runOf(actor),
        shapeIds: again.shapeIds,
        frameId: again.frameId,
        count: again.shapeIds.length,
        finishedAt: null,
      })
      .where(and(eq(liveImageRequests.id, requestId), eq(liveImageRequests.orgId, orgId)))
      .returning();
    await queueJob(tx, orgId, requestId, `retry:${Date.now()}`);
    return rows;
  });
  if (!updated) throw new NotFoundError("Image request not found");
  deps.wake?.();
  return viewOf(updated);
}

/** A request as it stands now; null when it isn't one of this workspace's. */
export async function imageRequestOf(db: Executor, orgId: string, requestId: string) {
  if (!UUID.test(requestId)) return null;
  const [row] = await db
    .select()
    .from(liveImageRequests)
    .where(and(eq(liveImageRequests.id, requestId), eq(liveImageRequests.orgId, orgId)));
  return row ? viewOf(row) : null;
}

/**
 * Waits for a request to end (done or failed), reading it every `pollMs`, at most `timeoutMs` or until `signal`
 * aborts: the request as it stands then (any process's job may make it).
 */
export async function waitForImageRequest(
  db: Executor,
  orgId: string,
  requestId: string,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<ImageRequestView | null> {
  const until = Date.now() + (options.timeoutMs ?? AGENT_IMAGE_WAIT_MS);
  const poll = options.pollMs ?? 750;
  for (;;) {
    const view = await imageRequestOf(db, orgId, requestId);
    if (!view || view.status === "done" || view.status === "failed") return view;
    if (Date.now() >= until || options.signal?.aborted) return view;
    await Bun.sleep(Math.max(1, Math.min(poll, until - Date.now())));
  }
}

/** What a failure means to the placeholders (`ImageFailure`). */
export function imageFailureOf(error: unknown): ImageFailure {
  if (error instanceof MissingCredentialError) return "no_key";
  if (error instanceof BudgetExceededError) return "budget";
  if (error instanceof PersonLimitError) return "limit";
  if (isImageBlocked(error)) return "blocked";
  if (error instanceof ProviderError) return providerCause(error) === "invalid_key" ? "no_key" : "provider";
  if (error instanceof ValidationError) {
    if (error.code === "images.model_unavailable" || error.code === "images.no_model") return "no_key";
    if (error.code === "live.too_large" || error.code.startsWith("storage.") || error.code.startsWith("limits."))
      return "too_many";
  }
  if (error instanceof Error && error.name === "LiveEditError") return "too_many";
  return "provider";
}

/** Reads a stored picture's bytes. */
async function bytesOf(file: NonNullable<Awaited<ReturnType<typeof getAsset>>>): Promise<Uint8Array> {
  return "bytes" in file ? file.bytes : new Uint8Array(await new Response(file.stream).arrayBuffer());
}

/**
 * Who a request acts as in its job: the person who asked, or the agent in its run's conversation (its run left out
 * once it no longer exists, so nothing points at it).
 */
async function actorOfRequest(db: Executor, row: RequestRow, channelOfFile: string | null): Promise<ArtifactActor> {
  if (row.requestedByType === "person") return { type: "person", userId: row.requestedById ?? "" };
  let channelId = channelOfFile;
  let threadId: string | null = null;
  let runId: string | null = null;
  if (row.runId) {
    const [run] = await db
      .select({
        channelId: agentRuns.channelId,
        threadRootId: agentRuns.threadRootId,
        triggerMessageId: agentRuns.triggerMessageId,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, row.runId), eq(agentRuns.orgId, row.orgId)));
    if (run?.channelId) {
      channelId = run.channelId;
      threadId = replyThreadOf(run);
      runId = row.runId;
    }
  }
  return { type: "agent", agentId: row.requestedById ?? "", channelId: channelId ?? "", threadId, runId };
}

/**
 * The `live.image` job's work (ADR 0197), idempotent: the request's placeholders still waiting are made through the
 * gateway, stored as the canvas's assets and turned into their pictures; what wasn't made says why. A provider that
 * is down or limiting is tried again by the outbox (the placeholders keep "running") until the last attempt.
 */
export async function runImageRequest(
  deps: Omit<LiveImageDeps, "wake">,
  orgId: string,
  requestId: string,
  options: { finalAttempt?: boolean } = {},
): Promise<ImageRequestView | null> {
  const { db } = deps.artifacts;
  const now = deps.now ?? (() => new Date());
  const [row] = await db
    .select()
    .from(liveImageRequests)
    .where(and(eq(liveImageRequests.id, requestId), eq(liveImageRequests.orgId, orgId)));
  if (!row) return null;
  if (row.status === "done" || row.status === "failed") return viewOf(row);
  const fileId = row.artifactId;
  const [file] = await db
    .select({ channelId: artifacts.channelId, deletedAt: artifacts.deletedAt })
    .from(artifacts)
    .where(and(eq(artifacts.id, fileId), eq(artifacts.orgId, orgId)));
  const finish = async (values: Partial<RequestRow>) => {
    const [ended] = await db
      .update(liveImageRequests)
      .set({ ...values, finishedAt: now() })
      .where(and(eq(liveImageRequests.id, requestId), eq(liveImageRequests.orgId, orgId)))
      .returning();
    return ended ? viewOf(ended) : null;
  };
  if (!file || file.deletedAt) return finish({ status: "failed", error: "provider" });
  await db
    .update(liveImageRequests)
    .set({ status: "running" })
    .where(and(eq(liveImageRequests.id, requestId), inArray(liveImageRequests.status, ["queued", "running"])));

  const actor = await actorOfRequest(db, row, file.channelId);
  const runId = runOf(actor);
  const by = peerOf(actor);
  const origin = originFor(authorOf(actor), runId);
  // The placeholders still waiting (someone may have deleted some meanwhile).
  const read = await deps.live.read(orgId, fileId);
  let waiting: string[];
  try {
    const pending = new Set(
      readShapes(read.doc, { text: false }).flatMap((s) =>
        s.type === "pending" && s.request === requestId ? [s.id] : [],
      ),
    );
    waiting = row.shapeIds.filter((id) => pending.has(id));
  } finally {
    read.doc.destroy();
  }
  if (waiting.length === 0) return finish({ status: row.assetIds.length > 0 ? "done" : "failed", error: null });

  const marked = (status: "running" | "failed", ids: readonly string[], error?: ImageFailure) =>
    deps.live
      .edit(orgId, fileId, origin, (doc) => {
        const still = new Set(readShapes(doc, { text: false }).flatMap((s) => (s.type === "pending" ? [s.id] : [])));
        for (const id of ids) if (still.has(id)) updateShape(doc, id, { status, error: error ?? null }, origin);
      })
      .catch((e: unknown) => deps.log?.warn("image placeholders not updated", { requestId, error: String(e) }));
  await marked("running", waiting);

  const fail = async (failure: ImageFailure, ids: readonly string[]) => {
    await marked("failed", ids, failure);
    const made = row.assetIds.length > 0;
    return finish({ status: made ? "done" : "failed", error: failure });
  };

  // The pictures it starts from, as the requester reads them (one gone since is left out, and an SVG the server
  // can't draw as a PNG: image AIs take only those).
  const references: ImageReference[] = [];
  for (const assetId of row.references) {
    const stored = await getAsset(deps.artifacts, actor, orgId, fileId, assetId).catch(() => null);
    const picture = stored
      ? await rasterPicture({ bytes: await bytesOf(stored), contentType: stored.contentType })
      : null;
    if (picture) references.push({ mediaType: picture.contentType, data: bytesToBase64(picture.bytes) });
  }
  const personId =
    actor.type === "person" ? actor.userId : runId ? accountablePerson(await runAuthorityById(db, orgId, runId)) : null;
  const aspect = IMAGE_ASPECTS.includes(row.aspect as ImageAspect) ? (row.aspect as ImageAspect) : "1:1";
  let result: Awaited<ReturnType<ModelGateway["generateImages"]>>;
  try {
    result = await deps.gateway.generateImages({
      orgId,
      agentId: actor.type === "agent" ? actor.agentId : null,
      personId,
      runId,
      request: {
        model: row.model,
        prompt: row.prompt,
        count: waiting.length,
        aspect,
        size: "1K",
        ...(references.length ? { references } : {}),
      },
      signal: AbortSignal.timeout(IMAGE_CALL_TIMEOUT_MS),
    });
  } catch (error) {
    // A provider down or limiting: the outbox tries again later, the placeholders still "running".
    if (error instanceof ProviderError && error.retryable && !options.finalAttempt) throw error;
    deps.log?.warn("image request failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(imageFailureOf(error), waiting);
  }

  const stored: LiveAsset[] = [];
  let storeFailure: ImageFailure | null = null;
  for (const image of result.images.slice(0, waiting.length)) {
    try {
      stored.push(
        await putAsset(deps.artifacts, actor, orgId, fileId, {
          bytes: image.bytes,
          contentType: image.mediaType,
          source: "generated",
          runId,
        }),
      );
    } catch (error) {
      storeFailure = imageFailureOf(error);
      break;
    }
  }
  const failure: ImageFailure | null =
    stored.length < waiting.length
      ? (storeFailure ?? (result.error ? imageFailureOf(result.error) : "provider"))
      : null;
  const at = now().toISOString();
  const { w, h } = boxOf(aspect);
  await deps.live
    .edit(orgId, fileId, origin, (doc) => {
      waiting.forEach((shapeId, i) => {
        const asset = stored[i];
        if (asset) {
          fillPending(
            doc,
            shapeId,
            {
              asset: asset.id,
              nw: asset.width ?? w,
              nh: asset.height ?? h,
              gen: {
                prompt: row.prompt,
                model: row.model,
                by,
                at,
                request: requestId,
                ...(row.references.length ? { from: row.references } : {}),
              },
              alt: row.prompt,
            },
            origin,
          );
        } else if (failure) {
          const shape = readShapes(doc, { text: false }).find((s) => s.id === shapeId);
          if (shape?.type === "pending") updateShape(doc, shapeId, { status: "failed", error: failure }, origin);
        }
      });
    })
    .catch((error: unknown) => deps.log?.warn("image placeholders not filled", { requestId, error: String(error) }));
  const assetIds = [...row.assetIds, ...stored.map((a) => a.id)];
  return finish({
    status: assetIds.length > 0 ? "done" : "failed",
    error: failure,
    assetIds,
    costNanoUsd: row.costNanoUsd + result.costNanoUsd,
  });
}

/** The `live.image` job's handler (registered in `createJobHandlers`). */
export function liveImageJobHandlers(deps: {
  artifacts?: ArtifactDeps;
  live?: LiveDocs;
  gateway?: ModelGateway;
  log?: LiveImageDeps["log"];
}): JobHandlers {
  return {
    [LIVE_IMAGE_JOB]: async (job, ctx) => {
      const requestId = job.payload.requestId;
      if (!job.orgId || typeof requestId !== "string") return;
      const { artifacts: files, live, gateway } = deps;
      if (!files || !live || !gateway) throw new Error("Images are unavailable on this server");
      await runImageRequest({ artifacts: files, live, gateway, log: deps.log }, job.orgId, requestId, {
        finalAttempt: ctx.finalAttempt,
      });
    },
  };
}

/** What an agent's run asks with (a `ToolContext` fits): its workspace, itself, its run and conversation. */
export interface AgentImageContext {
  orgId: string;
  agentId: string;
  runId?: string | null;
  channelId: string;
  /** The run's thread root and trigger: its reply goes in a thread when they differ (`replyThreadOf`). */
  threadRootId?: string | null;
  triggerMessageId?: string | null;
  /** Or the reply's thread itself (null: the channel), which wins over the two above. */
  threadId?: string | null;
  signal?: AbortSignal;
}

/** The thread an agent's reply goes in: given, or its run's (`replyThreadOf`), or the thread root alone. */
function threadOfContext(ctx: AgentImageContext): string | null {
  if (ctx.threadId !== undefined) return ctx.threadId;
  if (ctx.threadRootId && ctx.triggerMessageId)
    return replyThreadOf({ threadRootId: ctx.threadRootId, triggerMessageId: ctx.triggerMessageId });
  return ctx.threadRootId ?? null;
}

export interface AgentImageInput {
  prompt: string;
  count?: number;
  aspect?: ImageAspect;
  model?: string | null;
  /** The canvas to put them on (a file id). */
  canvas: string;
  /** The canvas's pictures to start from (shape or asset ids). */
  references?: string[];
  /** At most `AGENT_IMAGE_WAIT_MS`. */
  timeoutMs?: number;
}

/** The agent behind a context, as the Drive's rules see it, in its reply's conversation. */
function agentActorOf(ctx: AgentImageContext): Extract<ArtifactActor, { type: "agent" }> {
  return {
    type: "agent",
    agentId: ctx.agentId,
    channelId: ctx.channelId,
    threadId: threadOfContext(ctx),
    runId: ctx.runId ?? null,
  };
}

/** Pictures for the model to look at, as many as fit what a model is shown (`MODEL_IMAGE_BYTES`). */
function forTheModel(pictures: readonly { bytes: Uint8Array; contentType: string }[]): ToolImage[] {
  const out: ToolImage[] = [];
  let bytes = 0;
  for (const p of pictures) {
    if (bytes + p.bytes.byteLength > MODEL_IMAGE_BYTES) continue;
    bytes += p.bytes.byteLength;
    out.push({ mediaType: p.contentType, data: bytesToBase64(p.bytes) });
  }
  return out;
}

/**
 * An agent's pictures on a canvas (the `generate_image` tool with a canvas, ADR 0197): asked like a person's
 * (`requestImages`), then waited for, at most two minutes. Returns the canvas as the reply's card (`artifact`), the
 * pictures made, base64, as long as they fit what a model is shown (`MODEL_IMAGE_BYTES`), the request as it stood, and
 * whether the wait ran out (the pictures still come to the canvas then).
 */
export async function generateForAgent(
  deps: LiveImageDeps,
  ctx: AgentImageContext,
  input: AgentImageInput,
): Promise<{
  artifact: { id: string; version: number; title: string };
  images: ToolImage[];
  request: ImageRequestView;
  timedOut: boolean;
}> {
  const actor = agentActorOf(ctx);
  const asked = await requestImages(deps, actor, ctx.orgId, input.canvas, {
    prompt: input.prompt,
    count: input.count,
    aspect: input.aspect,
    model: input.model,
    references: input.references,
  });
  const { db } = deps.artifacts;
  const ended = await waitForImageRequest(db, ctx.orgId, asked.requestId, {
    timeoutMs: Math.min(input.timeoutMs ?? AGENT_IMAGE_WAIT_MS, AGENT_IMAGE_WAIT_MS),
    signal: ctx.signal,
  });
  const request = ended ?? asked;
  const [file] = await db
    .select({ id: artifacts.id, title: artifacts.title, version: artifacts.currentVersion })
    .from(artifacts)
    .where(and(eq(artifacts.id, request.artifactId), eq(artifacts.orgId, ctx.orgId)));
  const pictures: { bytes: Uint8Array; contentType: string }[] = [];
  let bytes = 0;
  for (const assetId of request.assetIds) {
    const stored = await getAsset(deps.artifacts, actor, ctx.orgId, request.artifactId, assetId).catch(() => null);
    // Read only what can be shown: past that, the bytes would be read for nothing.
    if (!stored || bytes + stored.size > MODEL_IMAGE_BYTES) continue;
    bytes += stored.size;
    pictures.push({ bytes: await bytesOf(stored), contentType: stored.contentType });
  }
  return {
    artifact: { id: request.artifactId, version: file?.version ?? 1, title: file?.title ?? "" },
    images: forTheModel(pictures),
    request,
    timedOut: request.status === "queued" || request.status === "running",
  };
}

/** What an agent asks for in a conversation (`generateInChat`). */
export interface ChatImageInput {
  prompt: string;
  count?: number;
  aspect?: ImageAspect;
  model?: string | null;
  /** Pictures to start from: Drive files' ids (pictures posted in a conversation) the agent reads. */
  references?: string[];
}

/** A picture made in a conversation: a Drive file on the agent's reply (`meta.artifacts`). */
export interface ChatImageFile {
  id: string;
  version: number;
  title: string;
  width?: number;
  height?: number;
}

/** Pictures made in a conversation, as the tool tells the agent. */
export interface ChatImagesView {
  files: ChatImageFile[];
  /** The pictures for the model to look at (as many as fit `MODEL_IMAGE_BYTES`). */
  images: ToolImage[];
  model: string;
  /** How many were asked for; fewer were made when `failure` says why. */
  count: number;
  failure: ImageFailure | null;
  costNanoUsd: number;
}

/** Tries of one call in a conversation: a provider down or limiting gets one more, the agent waiting meanwhile. */
const CHAT_ATTEMPTS = 2;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** A picture file's name from its prompt: `a-lighthouse-at-dusk-2.png`. */
function pictureName(prompt: string, index: number, count: number, mediaType: string): string {
  const slug =
    prompt
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "image";
  return `${slug}${count > 1 ? `-${index + 1}` : ""}.${EXTENSIONS[mediaType] ?? "png"}`;
}

/**
 * An agent's pictures in its conversation (the `generate_image` tool with no canvas, ADR 0197): made through the
 * Model Gateway while the agent waits (budget, standing and usage as every image call), each saved as a picture file
 * where its run posts (`createFileArtifact`, so its reply carries them as pictures in the chat), and handed back to
 * the model to look at. `references` are pictures the agent reads (a picture posted in the conversation), for
 * variations and edits. What wasn't made says why (`failure`); refused before any call when the workspace has no
 * image model, the model asked isn't one it can use, or a picture to start from isn't one.
 */
export async function generateInChat(
  deps: LiveImageDeps,
  ctx: AgentImageContext,
  input: ChatImageInput,
): Promise<ChatImagesView> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new ValidationError("Say what the pictures should show");
  if (prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    throw new ValidationError(`The prompt is over ${MAX_IMAGE_PROMPT_CHARS} characters`);
  }
  const { model, info } = await modelFor(deps, ctx.orgId, input.model);
  const asked = Number.isFinite(input.count) ? Math.floor(input.count as number) : 1;
  const count = Math.min(info.maxCount, Math.max(1, asked));
  const aspect = nearestAspect(info, input.aspect && IMAGE_ASPECTS.includes(input.aspect) ? input.aspect : "1:1");
  const actor = agentActorOf(ctx);
  const { db } = deps.artifacts;

  const wanted = [...new Set(input.references ?? [])];
  if (wanted.length > MAX_IMAGE_REFERENCES) {
    throw new ValidationError(`At most ${MAX_IMAGE_REFERENCES} pictures to start from`, "images.reference");
  }
  if (wanted.length > 0 && !info.refs) {
    throw new ValidationError(`${info.label} takes no pictures to start from`, "images.reference");
  }
  const references: ImageReference[] = [];
  for (const id of wanted) {
    const picture = await readPictureFile(deps.artifacts, actor, ctx.orgId, id).catch((error: unknown) => {
      throw new ValidationError(
        `The picture ${id} can't be used to start from: ${error instanceof Error ? error.message : String(error)}`,
        "images.reference",
      );
    });
    references.push({ mediaType: picture.contentType, data: bytesToBase64(picture.bytes) });
  }

  const runId = runOf(actor);
  const personId = runId ? accountablePerson(await runAuthorityById(db, ctx.orgId, runId)) : null;
  const limit = AbortSignal.timeout(IMAGE_CALL_TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, limit]) : limit;
  const none = (failure: ImageFailure): ChatImagesView => ({
    files: [],
    images: [],
    model,
    count,
    failure,
    costNanoUsd: 0,
  });
  let result: Awaited<ReturnType<ModelGateway["generateImages"]>> | null = null;
  for (let attempt = 1; !result; attempt++) {
    try {
      result = await deps.gateway.generateImages({
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        personId,
        runId,
        request: { model, prompt, count, aspect, size: "1K", ...(references.length ? { references } : {}) },
        signal,
      });
    } catch (error) {
      if (error instanceof ProviderError && error.retryable && attempt < CHAT_ATTEMPTS && !signal.aborted) continue;
      deps.log?.warn("chat images failed", { error: error instanceof Error ? error.message : String(error) });
      return none(imageFailureOf(error));
    }
  }

  const files: ChatImageFile[] = [];
  const kept: { bytes: Uint8Array; contentType: string }[] = [];
  let failure: ImageFailure | null = null;
  const made = result.images.slice(0, count);
  const title = frameName(prompt);
  for (const [index, image] of made.entries()) {
    try {
      const file = await createFileArtifact(deps.artifacts, actor, ctx.orgId, {
        title: made.length > 1 ? `${title} ${index + 1}` : title,
        name: pictureName(prompt, index, made.length, image.mediaType),
        bytes: image.bytes,
        contentType: image.mediaType,
      });
      const content = file.content.kind === "file" ? file.content : null;
      files.push({ id: file.id, version: file.version, title: file.title, ...pictureSize(content ?? {}) });
      kept.push({ bytes: image.bytes, contentType: image.mediaType });
    } catch (error) {
      failure = imageFailureOf(error);
      break;
    }
  }
  if (!failure && files.length < count) failure = result.error ? imageFailureOf(result.error) : "provider";
  return { files, images: forTheModel(kept), model, count, failure, costNanoUsd: result.costNanoUsd };
}

/** The deps bound once: what the routes, the tools and the jobs call. */
export interface LiveImages {
  models(orgId: string, options?: { prices?: boolean }): Promise<ImageModelOption[]>;
  request(actor: ArtifactActor, orgId: string, canvasId: string, input: ImageRequestInput): Promise<ImageRequestView>;
  retry(actor: ArtifactActor, orgId: string, canvasId: string, requestId: string): Promise<ImageRequestView>;
  get(orgId: string, requestId: string): Promise<ImageRequestView | null>;
  wait(
    orgId: string,
    requestId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ImageRequestView | null>;
  generateForAgent(ctx: AgentImageContext, input: AgentImageInput): ReturnType<typeof generateForAgent>;
  generateInChat(ctx: AgentImageContext, input: ChatImageInput): Promise<ChatImagesView>;
}

export function createLiveImages(deps: LiveImageDeps): LiveImages {
  return {
    models: (orgId, options) => imageModelsFor(deps, orgId, options),
    request: (actor, orgId, canvasId, input) => requestImages(deps, actor, orgId, canvasId, input),
    retry: (actor, orgId, canvasId, requestId) => retryImages(deps, actor, orgId, canvasId, requestId),
    get: (orgId, requestId) => imageRequestOf(deps.artifacts.db, orgId, requestId),
    wait: (orgId, requestId, options) => waitForImageRequest(deps.artifacts.db, orgId, requestId, options),
    generateForAgent: (ctx, input) => generateForAgent(deps, ctx, input),
    generateInChat: (ctx, input) => generateInChat(deps, ctx, input),
  };
}
