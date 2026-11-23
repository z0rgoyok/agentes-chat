import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { readShapes, type ShapeView } from "@agenteschat/live/canvas";
import { PROVIDER_IDS, ProviderError } from "@agenteschat/providers";
import { createFakeProvider, type FakeImageReply } from "@agenteschat/providers/testing";
import {
  createCredential,
  createFileArtifact,
  createModelGateway,
  drainOutbox,
  generateForAgent,
  generateInChat,
  getAsset,
  imageModelsFor,
  type JobHandlers,
  LIVE_IMAGE_JOB,
  type LiveDocs,
  type LiveImageDeps,
  liveImageJobHandlers,
  requestImages,
  retryImages,
  revokeCredential,
  runImageRequest,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { liveDocsFor, makeLiveFile, personActor } from "./live-fixtures";

/** Nano Banana 2.1 at 1K, per picture (the workspace's default image model with a Gemini key). */
const BANANA = 33_600_000;

let f: Fixture;
let docs: LiveDocs;
let deps: LiveImageDeps;
let handlers: JobHandlers;
/** What the fake provider answers next (each test may script it); absent: every picture asked for. */
let script: ((call: number) => FakeImageReply | Error) | null;
let provider: ReturnType<typeof createFakeProvider>;
let geminiKey: string;

beforeEach(async () => {
  f = await setup();
  docs = liveDocsFor(f, "a");
  script = null;
  provider = createFakeProvider(undefined, { image: (_request, call) => script?.(call) ?? {} });
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, provider])),
    platformCredentials: { resolve: async () => null },
  });
  geminiKey = (
    await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "gemini",
      label: "pictures",
      apiKey: "AQ.gemini-test-key-1234",
    })
  ).id;
  deps = { artifacts: f.artifactDeps, live: docs, gateway };
  handlers = { ...f.handlers, ...liveImageJobHandlers({ artifacts: f.artifactDeps, live: docs, gateway }) };
});
afterEach(async () => {
  await docs.stop();
  await f.close();
});

const owner = () => personActor(f.owner.id);

async function shapesOf(fileId: string): Promise<ShapeView[]> {
  const { doc } = await docs.read(f.org.id, fileId);
  try {
    return readShapes(doc, { text: false });
  } finally {
    doc.destroy();
  }
}

const requestRow = async (id: string) => {
  const [row] = await f.db.select().from(schema.liveImageRequests).where(eq(schema.liveImageRequests.id, id));
  return row;
};

describe("a person's request on a canvas", () => {
  test("a frame named with the prompt and its placeholders land at once; the job turns each into its picture", async () => {
    const canvas = await makeLiveFile(f, "canvas", { title: "Moodboard" });
    const view = await requestImages(deps, owner(), f.org.id, canvas.id, {
      prompt: "a lighthouse at dusk",
      count: 2,
      aspect: "16:9",
      at: { x: 1000, y: 1000 },
    });
    expect(view).toMatchObject({ status: "queued", model: "gemini-nano-banana-2.1", count: 2, aspect: "16:9" });
    expect(view.shapeIds).toHaveLength(2);
    const placed = await shapesOf(canvas.id);
    const frame = placed.find((s) => s.id === view.frameId);
    expect(frame).toMatchObject({ type: "frame", name: "a lighthouse at dusk" });
    const pending = placed.filter((s) => s.type === "pending");
    expect(pending.map((s) => s.id).sort()).toEqual([...view.shapeIds].sort());
    for (const p of pending) {
      expect(p).toMatchObject({
        parent: view.frameId,
        request: view.requestId,
        status: "queued",
        prompt: "a lighthouse at dusk",
        by: { kind: "person", id: f.owner.id },
        w: 384,
        h: 216,
      });
    }
    // Inside the frame, never on top of each other.
    const [a, b] = pending;
    if (!a || !b || !frame) throw new Error("missing shapes");
    expect(a.x + a.w <= b.x || b.x + b.w <= a.x).toBe(true);
    for (const p of pending) {
      expect(p.x).toBeGreaterThanOrEqual(frame.x);
      expect(p.x + p.w).toBeLessThanOrEqual(frame.x + frame.w);
    }

    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, LIVE_IMAGE_JOB));
    expect(job?.payload).toEqual({ requestId: view.requestId });
    await drainOutbox(f.db, handlers);

    const done = await requestRow(view.requestId);
    expect(done).toMatchObject({ status: "done", error: null, costNanoUsd: 2 * BANANA });
    expect(done?.assetIds).toHaveLength(2);
    const after = await shapesOf(canvas.id);
    const images = after.filter((s) => s.type === "image");
    expect(images.map((s) => s.id).sort()).toEqual([...view.shapeIds].sort());
    expect(after.some((s) => s.type === "pending")).toBe(false);
    for (const image of images) {
      expect(image).toMatchObject({
        parent: view.frameId,
        nw: 96,
        nh: 54,
        w: 384,
        h: 216,
        gen: {
          prompt: "a lighthouse at dusk",
          model: "gemini-nano-banana-2.1",
          by: { kind: "person", id: f.owner.id },
          request: view.requestId,
        },
      });
      expect(done?.assetIds).toContain(image.asset);
    }
    // Stored as the canvas's assets (made, by the person), readable by whoever reads it.
    const assets = await f.db.select().from(schema.liveAssets).where(eq(schema.liveAssets.artifactId, canvas.id));
    expect(assets.map((a) => a.source)).toEqual(["generated", "generated"]);
    expect(assets.every((a) => a.createdById === f.owner.id && a.contentType === "image/png")).toBe(true);
    const file = await getAsset(f.artifactDeps, owner(), f.org.id, canvas.id, assets[0]?.id ?? "");
    expect(file?.contentType).toBe("image/png");
    // Billed to the person: no agent, kind image, on the workspace's Gemini key.
    const [usage] = await f.db
      .select()
      .from(schema.usageRecords)
      .where(and(eq(schema.usageRecords.orgId, f.org.id), eq(schema.usageRecords.kind, "image")));
    expect(usage).toMatchObject({ agentId: null, personId: f.owner.id, costNanoUsd: 2 * BANANA });
    expect(provider.imageCalls[0]?.apiKey).toBe("AQ.gemini-test-key-1234");
  });

  test("pictures it starts from go to the provider; one not on the canvas is refused", async () => {
    const canvas = await makeLiveFile(f, "canvas", { title: "Moodboard" });
    const first = await requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "a red fox" });
    await runImageRequest(deps, f.org.id, first.requestId);
    const fox = first.shapeIds[0] ?? "";
    const variation = await requestImages(deps, owner(), f.org.id, canvas.id, {
      prompt: "the same fox, in snow",
      references: [fox],
    });
    const assetId = (await requestRow(first.requestId))?.assetIds[0] ?? "";
    expect((await requestRow(variation.requestId))?.references).toEqual([assetId]);
    await runImageRequest(deps, f.org.id, variation.requestId);
    const sent = provider.imageCalls.at(-1)?.request;
    expect(sent?.references).toHaveLength(1);
    expect(sent?.references?.[0]?.mediaType).toBe("image/png");
    const made = (await shapesOf(canvas.id)).find((s) => s.id === variation.shapeIds[0]);
    expect(made?.gen?.from).toEqual([assetId]);
    await expect(
      requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "x", references: ["nope"] }),
    ).rejects.toMatchObject({ code: "images.reference" });
  });

  test("refused before anything lands: not a canvas, no image model, a model the workspace can't use", async () => {
    const sheet = await makeLiveFile(f, "spreadsheet");
    await expect(requestImages(deps, owner(), f.org.id, sheet.id, { prompt: "x" })).rejects.toMatchObject({
      code: "images.not_canvas",
    });
    const canvas = await makeLiveFile(f, "canvas");
    await expect(
      requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "x", model: "gpt-image-2" }),
    ).rejects.toMatchObject({ code: "images.model_unavailable" });
    await revokeCredential(f.db, f.owner.id, f.org.id, geminiKey);
    await expect(requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "x" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await shapesOf(canvas.id)).toEqual([]);
    expect(await imageModelsFor(deps, f.org.id)).toEqual([]);
  });

  test("an aspect the model doesn't take becomes its nearest; the count stays within the model's", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    const view = await requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "x", count: 9, aspect: "9:16" });
    expect(view.count).toBe(4);
    expect(view.aspect).toBe("9:16");
  });
});

describe("when pictures aren't made", () => {
  test("the key removed meanwhile: placeholders say no_key; Try again once a key is back makes them", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    const view = await requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "a fox", count: 2 });
    await revokeCredential(f.db, f.owner.id, f.org.id, geminiKey);
    await runImageRequest(deps, f.org.id, view.requestId);
    expect(await requestRow(view.requestId)).toMatchObject({ status: "failed", error: "no_key" });
    const failed = (await shapesOf(canvas.id)).filter((s) => s.type === "pending");
    expect(failed.map((s) => [s.status, s.error])).toEqual([
      ["failed", "no_key"],
      ["failed", "no_key"],
    ]);

    await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "gemini",
      label: "again",
      apiKey: "AQ.gemini-second-key-5678",
    });
    const again = await retryImages(deps, owner(), f.org.id, canvas.id, view.requestId);
    expect(again.status).toBe("queued");
    expect(again.shapeIds.sort()).toEqual([...view.shapeIds].sort());
    expect((await shapesOf(canvas.id)).filter((s) => s.status === "queued")).toHaveLength(2);
    await drainOutbox(f.db, handlers);
    expect(await requestRow(view.requestId)).toMatchObject({ status: "done", error: null });
    expect((await shapesOf(canvas.id)).filter((s) => s.type === "image")).toHaveLength(2);
    // A request that made everything comes back as it is.
    const same = await retryImages(deps, owner(), f.org.id, canvas.id, view.requestId);
    expect(same.status).toBe("done");
  });

  test("a prompt the provider refuses says blocked; a call that stops midway keeps what it made", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    script = () => new ProviderError("the provider refused to make this image: unsafe", false, 400);
    const refused = await requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "something" });
    await runImageRequest(deps, f.org.id, refused.requestId);
    expect(await requestRow(refused.requestId)).toMatchObject({ status: "failed", error: "blocked" });

    script = () => ({ count: 1, error: new ProviderError("rate limited by provider", true, 429) });
    const half = await requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "two foxes", count: 2 });
    await runImageRequest(deps, f.org.id, half.requestId);
    const row = await requestRow(half.requestId);
    expect(row).toMatchObject({ status: "done", error: "provider", costNanoUsd: BANANA });
    expect(row?.assetIds).toHaveLength(1);
    const shapes = (await shapesOf(canvas.id)).filter((s) => half.shapeIds.includes(s.id));
    expect(shapes.map((s) => s.type).sort()).toEqual(["image", "pending"]);
    expect(shapes.find((s) => s.type === "pending")).toMatchObject({ status: "failed", error: "provider" });
  });

  test("a provider that is down: tried again by the outbox, then failed on its last attempt", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    script = () => new ProviderError("provider error", true, 503);
    const view = await requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "a fox" });
    await expect(runImageRequest(deps, f.org.id, view.requestId)).rejects.toBeInstanceOf(ProviderError);
    expect(await requestRow(view.requestId)).toMatchObject({ status: "running" });
    expect((await shapesOf(canvas.id))[1]).toMatchObject({ type: "pending", status: "running" });
    await runImageRequest(deps, f.org.id, view.requestId, { finalAttempt: true });
    expect(await requestRow(view.requestId)).toMatchObject({ status: "failed", error: "provider" });
    // Nothing was billed.
    const rows = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.kind, "image"));
    expect(rows).toHaveLength(0);
  });

  test("placeholders deleted meanwhile: nothing is made", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    const view = await requestImages(deps, owner(), f.org.id, canvas.id, { prompt: "a fox" });
    await docs.edit(f.org.id, canvas.id, { kind: "local" }, (doc) => {
      const shapes = doc.getMap("shapes");
      for (const id of view.shapeIds) shapes.delete(id);
    });
    await runImageRequest(deps, f.org.id, view.requestId);
    expect(await requestRow(view.requestId)).toMatchObject({ status: "failed" });
    expect(provider.imageCalls).toHaveLength(0);
  });
});

describe("an agent's pictures on a canvas", () => {
  test("on the canvas named: placed, made by a worker, back to the model", async () => {
    const canvas = await makeLiveFile(f, "canvas", { title: "Moodboard" });
    const ctx = { orgId: f.org.id, agentId: f.agent.id, channelId: f.general.id, threadId: null };
    const working = generateForAgent(deps, ctx, { prompt: "a lighthouse", canvas: canvas.id, timeoutMs: 20_000 });
    let requestId = "";
    // The request lands, then a worker makes it (here: the drain).
    for (let i = 0; i < 500 && !requestId; i++) {
      const [row] = await f.db.select().from(schema.liveImageRequests);
      if (row) requestId = row.id;
      else await Bun.sleep(10);
    }
    await drainOutbox(f.db, handlers);
    const out = await working;
    expect(out.timedOut).toBe(false);
    expect(out.request).toMatchObject({ requestId, status: "done", artifactId: canvas.id });
    expect(out.artifact).toMatchObject({ id: canvas.id, title: "Moodboard" });
    expect(out.images).toHaveLength(1);
    const [image] = (await shapesOf(canvas.id)).filter((s) => s.type === "image");
    expect(image?.gen?.by).toEqual({ kind: "agent", id: f.agent.id });
    expect(image?.by).toEqual({ kind: "agent", id: f.agent.id });
  });

  test("the wait runs out: the request comes back still pending, and the pictures still come later", async () => {
    const canvas = await makeLiveFile(f, "canvas");
    const ctx = { orgId: f.org.id, agentId: f.agent.id, channelId: f.general.id, threadId: null };
    const out = await generateForAgent(deps, ctx, { prompt: "a lighthouse", canvas: canvas.id, timeoutMs: 50 });
    expect(out.timedOut).toBe(true);
    expect(out.images).toEqual([]);
    expect(out.request.status).toBe("queued");
    await drainOutbox(f.db, handlers);
    expect(await requestRow(out.request.requestId)).toMatchObject({ status: "done" });
  });
});

describe("an agent's pictures in a conversation", () => {
  const ctx = () => ({ orgId: f.org.id, agentId: f.agent.id, channelId: f.general.id, threadId: null });

  test("each a picture file where its run posts, back to the model, billed to the agent; no canvas made", async () => {
    const out = await generateInChat(deps, ctx(), { prompt: "A lighthouse at dusk!", count: 2, aspect: "16:9" });
    expect(out).toMatchObject({ model: "gemini-nano-banana-2.1", count: 2, failure: null, costNanoUsd: 2 * BANANA });
    expect(out.files).toHaveLength(2);
    expect(out.images).toHaveLength(2);
    expect(out.images[0]?.mediaType).toBe("image/png");
    const rows = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.orgId, f.org.id));
    expect(rows.some((r) => r.kind === "canvas")).toBe(false);
    for (const [i, made] of out.files.entries()) {
      const row = rows.find((r) => r.id === made.id);
      expect(row).toMatchObject({ kind: "file", channelId: f.general.id, threadId: null, createdByType: "agent" });
      expect(made).toMatchObject({ title: `A lighthouse at dusk! ${i + 1}`, version: 1, width: 96, height: 54 });
      const [version] = await f.db
        .select()
        .from(schema.artifactVersions)
        .where(eq(schema.artifactVersions.artifactId, made.id));
      expect(version).toMatchObject({ contentType: "image/png", fileName: `a-lighthouse-at-dusk-${i + 1}.png` });
    }
    expect(await f.db.select().from(schema.liveImageRequests)).toHaveLength(0);
    const [usage] = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.kind, "image"));
    expect(usage).toMatchObject({ agentId: f.agent.id, costNanoUsd: 2 * BANANA });
  });

  test("variations start from a picture in the conversation; a file that isn't a picture is refused", async () => {
    const [first] = (await generateInChat(deps, ctx(), { prompt: "a red fox" })).files;
    if (!first) throw new Error("no picture");
    const out = await generateInChat(deps, ctx(), { prompt: "the same fox, in snow", references: [first.id] });
    expect(out.files).toHaveLength(1);
    const sent = provider.imageCalls.at(-1)?.request;
    expect(sent?.references).toHaveLength(1);
    expect(sent?.references?.[0]?.mediaType).toBe("image/png");
    const notes = await createFileArtifact(f.artifactDeps, owner(), f.org.id, {
      title: "notes",
      name: "notes.txt",
      bytes: new TextEncoder().encode("plain words"),
      channelId: f.general.id,
    });
    await expect(generateInChat(deps, ctx(), { prompt: "x", references: [notes.id] })).rejects.toMatchObject({
      code: "images.reference",
    });
  });

  test("what wasn't made says why: refused, stopped midway, a provider down twice", async () => {
    script = () => new ProviderError("the provider refused to make this image: unsafe", false, 400);
    const refused = await generateInChat(deps, ctx(), { prompt: "something" });
    expect(refused).toMatchObject({ files: [], images: [], failure: "blocked" });

    script = () => ({ count: 1, error: new ProviderError("rate limited by provider", true, 429) });
    const half = await generateInChat(deps, ctx(), { prompt: "two foxes", count: 2 });
    expect(half.files).toHaveLength(1);
    expect(half.failure).toBe("provider");

    let calls = 0;
    script = () => {
      calls++;
      return new ProviderError("provider error", true, 503);
    };
    const down = await generateInChat(deps, ctx(), { prompt: "a fox" });
    expect(down).toMatchObject({ files: [], failure: "provider" });
    expect(calls).toBe(2);

    await revokeCredential(f.db, f.owner.id, f.org.id, geminiKey);
    await expect(generateInChat(deps, ctx(), { prompt: "a fox" })).rejects.toBeInstanceOf(ValidationError);
  });
});
