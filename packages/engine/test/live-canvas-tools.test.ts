import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { addShape, readShapes } from "@agenteschat/live/canvas";
import { fakeImagePng } from "@agenteschat/providers/testing";
import type * as Y from "yjs";
import {
  absorbToolData,
  createCredential,
  createFileArtifact,
  createLiveFileToolSource,
  createLiveImages,
  insertMessage,
  type LiveDocs,
  type ToolContext,
  type ToolOutput,
  type ToolSideEffects,
  type ToolSource,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { liveDocsFor, personActor } from "./live-fixtures";

/**
 * The canvas tools on the canvas's newer shapes (ADR 0196 §2, §6): forms, borders, lines and curved arrows, pen
 * strokes, a picture's crop, hiding, a canvas that starts with pictures from the conversation; and pictures made in a
 * conversation going on the agent's reply as picture files (ADR 0197).
 */

let f: Fixture;
let docs: LiveDocs;
let source: ToolSource | null = null;
const lazy: ToolSource = { name: "live-files", tools: async (ctx) => (source ? source.tools(ctx) : []) };

beforeEach(async () => {
  f = await setup({ toolSources: [lazy] });
  docs = liveDocsFor(f, "a");
  const images = createLiveImages({ artifacts: f.artifactDeps, live: docs, gateway: f.gateway });
  source = createLiveFileToolSource({ artifacts: f.artifactDeps, live: docs, images });
});
afterEach(async () => {
  source = null;
  await docs.stop();
  await f.close();
});

async function runFor(channelId = f.general.id) {
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "@dev do it",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

type Run = Awaited<ReturnType<typeof runFor>>;

const ctxOf = (run: Run): ToolContext => ({
  db: f.db,
  orgId: f.org.id,
  agentId: f.agent.id,
  runId: run.id,
  channelId: run.channelId,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
});

async function call(run: Run, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const r = await f.tools?.invoke(ctxOf(run), { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  return r.output;
}

async function ok(run: Run, name: string, input: Record<string, unknown>) {
  const out = await call(run, name, input);
  if (out.isError) throw new Error(`${name} failed: ${out.content}`);
  return out;
}

const artifactOf = (out: ToolOutput) => out.data?.artifact as { id: string; version: number; title: string };

async function shapesOf(fileId: string) {
  const { doc } = await docs.read(f.org.id, fileId);
  try {
    return readShapes(doc as Y.Doc, { text: false });
  } finally {
    doc.destroy();
  }
}

/** A picture someone posted in #general. */
const postPicture = (name: string, aspect: "1:1" | "16:9" = "1:1") =>
  createFileArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
    title: name,
    name,
    bytes: fakeImagePng(name, aspect),
    channelId: f.general.id,
  });

describe("edit_canvas and read_canvas: the newer shapes", () => {
  test("forms with borders, a curved arrow with two heads, a line, a pen stroke; read says it all", async () => {
    const run = await runFor();
    const board = artifactOf(await ok(run, "create_canvas", { title: "Flow" }));
    const out = await ok(run, "edit_canvas", {
      file: board.id,
      ops: [
        { op: "add_shape", ref: "a", kind: "star", text: "Start", stroke: "#e5484d", stroke_width: 4, x: 0, y: 0 },
        { op: "add_shape", ref: "b", kind: "triangle", fill: "none", x: 600, y: 0 },
        { op: "add_shape", ref: "c", radius: 16, fill: "#d5e7fb", x: 1200, y: 0 },
        { op: "connect", from: "a", to: "b", route: "curve", heads: "both", label: "then" },
        { op: "add_line", x1: 0, y1: 400, x2: 800, y2: 400, dashed: true },
        { op: "draw", points: [0, 0, 40, 30, 80, 0], x: 100, y: 600, stroke: "#0063d1", tool: "marker" },
      ],
    });
    expect(out.content).toContain("added a star");
    expect(out.content).toContain("added a line");
    expect(out.content).toContain("added a pen stroke");
    const shapes = await shapesOf(board.id);
    const star = shapes.find((s) => s.kind === "star");
    expect(star).toMatchObject({ stroke: "#e5484d", strokeWidth: 4, by: { kind: "agent", id: f.agent.id } });
    expect(shapes.find((s) => s.kind === "rect")).toMatchObject({ radius: 16, fill: "#d5e7fb" });
    const arrows = shapes.filter((s) => s.type === "arrow");
    expect(arrows.find((s) => s.label === "then")).toMatchObject({
      route: "curve",
      heads: { start: "arrow", end: "arrow" },
    });
    expect(arrows.find((s) => !s.label)).toMatchObject({
      from: { x: 0, y: 400 },
      to: { x: 800, y: 400 },
      dashed: true,
      heads: { start: "none", end: "none" },
    });
    expect(shapes.find((s) => s.type === "draw")).toMatchObject({
      x: 100,
      y: 600,
      w: 80,
      h: 30,
      tool: "marker",
      stroke: "#0063d1",
    });

    // A person draws on it too: the read names who made what, past what the agent made itself.
    await docs.edit(f.org.id, board.id, { kind: "system", userId: f.owner.id }, (doc) => {
      addShape(doc, { type: "draw", points: [0, 0, 10, 10], x: 900, y: 900 }, { kind: "system", userId: f.owner.id });
    });
    const read = await ok(run, "read_canvas", { file: board.id });
    expect(read.content).toMatch(/shape \[\w+\] .* star, border #e5484d 4 wide: Start/);
    expect(read.content).not.toContain("by Dev");
    expect(read.content).toMatch(/pen stroke \[\w+\] \(900,900 10×10\): 2 points, pen, by ana \(a person\)/);
    expect(read.content).toMatch(/shape \[\w+\] .* triangle, fill none/);
    expect(read.content).toMatch(/fill #d5e7fb, corners 16/);
    expect(read.content).toMatch(/arrow \[\w+\]: \[\w+\] → \[\w+\] "then" \(curve, heads at both ends\)/);
    expect(read.content).toMatch(/line \[\w+\]: \(0,400\) → \(800,400\) \(dashed\)/);
    expect(read.content).toMatch(/pen stroke \[\w+\] \(100,600 80×30\): 3 points, marker #0063d1/);
  });

  test("style changes each shape where its type has it, hides, crops; what applies to none is refused", async () => {
    const run = await runFor();
    const picture = await postPicture("bay.png", "16:9");
    const board = artifactOf(await ok(run, "create_canvas", { title: "Board", images: [picture.id] }));
    const [image] = await shapesOf(board.id);
    if (!image) throw new Error("no picture");
    await ok(run, "edit_canvas", {
      file: board.id,
      ops: [
        { op: "add_shape", ref: "s", x: 0, y: 1000 },
        { op: "add_note", ref: "n", text: "hi", x: 400, y: 1000 },
        { op: "style", shapes: ["s", "n"], fill: "#fdf0b0", color: "pink", stroke_width: 6 },
        { op: "style", shapes: [image.id], crop: { x: 0.25, y: 0, w: 0.5, h: 1 } },
        { op: "style", shapes: ["n"], hidden: true },
      ],
    });
    const shapes = await shapesOf(board.id);
    expect(shapes.find((s) => s.type === "shape")).toMatchObject({ fill: "#fdf0b0", strokeWidth: 6 });
    expect(shapes.find((s) => s.type === "note")).toMatchObject({ color: "pink", hidden: true });
    expect(shapes.find((s) => s.type === "image")?.crop).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    const read = await ok(run, "read_canvas", { file: board.id });
    expect(read.content).toContain("cropped to 50%×100% from (25%,0%)");
    expect(read.content).toMatch(/note \[\w+\] .* pink \(hidden\): hi/);

    const refused = await call(run, "edit_canvas", {
      file: board.id,
      ops: [{ op: "style", shapes: [image.id], route: "curve" }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("route doesn't apply to a image");
    const odd = await call(run, "edit_canvas", { file: board.id, ops: [{ op: "draw", points: [1, 2, 3] }] });
    expect(odd.isError).toBe(true);
    expect(odd.content).toContain("points come in pairs");
  });
});

describe("create_canvas with pictures from the conversation", () => {
  test("the pictures named, side by side in that order, copied into the canvas", async () => {
    const run = await runFor();
    const one = await postPicture("one.png");
    const two = await postPicture("two.png", "16:9");
    const out = await ok(run, "create_canvas", { title: "Picks", images: [one.id, two.id] });
    expect(out.content).toContain("with 2 pictures side by side");
    const board = artifactOf(out);
    const pictures = (await shapesOf(board.id)).filter((s) => s.type === "image");
    expect(pictures).toHaveLength(2);
    const [first, second] = [...pictures].sort((a, b) => a.x - b.x);
    expect(first).toMatchObject({ nw: 96, nh: 96, by: { kind: "agent", id: f.agent.id } });
    expect(second).toMatchObject({ nw: 96, nh: 54 });
    expect((first?.x ?? 0) + (first?.w ?? 0)).toBeLessThanOrEqual(second?.x ?? 0);
    const assets = await f.db.select().from(schema.liveAssets).where(eq(schema.liveAssets.artifactId, board.id));
    expect(assets.map((a) => a.id).sort()).toEqual(pictures.map((p) => p.asset ?? "").sort());
  });

  test("a file that isn't a picture refuses the call, and no canvas is made", async () => {
    const run = await runFor();
    const notes = await createFileArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
      title: "notes",
      name: "notes.txt",
      bytes: new TextEncoder().encode("plain words"),
      channelId: f.general.id,
    });
    const out = await call(run, "create_canvas", { title: "Picks", images: [notes.id] });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("can't be used");
    const canvases = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.kind, "canvas"));
    expect(canvases).toHaveLength(0);
  });
});

describe("generate_image in a conversation", () => {
  test("the pictures go on the reply as picture files, back to the model; no canvas", async () => {
    await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "gemini",
      label: "pictures",
      apiKey: "AQ.gemini-test-key-1234",
    });
    const run = await runFor();
    const out = await ok(run, "generate_image", { prompt: "a lighthouse at dusk", count: 2 });
    expect(out.content).toContain("Made 2 images");
    expect(out.content).toContain("on your reply as pictures");
    expect(out.images).toHaveLength(2);
    const files = out.data?.artifacts as { id: string; version: number; title: string; width?: number }[];
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ version: 1, width: 96, height: 96 });
    const canvases = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.kind, "canvas"));
    expect(canvases).toHaveLength(0);
    // The reply carries them, one card each (`meta.artifacts`).
    const effects: ToolSideEffects = {};
    absorbToolData(effects, out.data);
    expect(effects.artifacts?.map((a) => a.id)).toEqual(files.map((a) => a.id));
    // And a canvas with one of them is a call away.
    const board = artifactOf(await ok(run, "create_canvas", { title: "Lighthouses", images: [files[1]?.id] }));
    expect((await shapesOf(board.id)).filter((s) => s.type === "image")).toHaveLength(1);
    const [usage] = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.kind, "image"));
    expect(usage).toMatchObject({ agentId: f.agent.id, runId: run.id });
  });
});
