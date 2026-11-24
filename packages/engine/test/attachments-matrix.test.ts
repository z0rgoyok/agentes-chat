import { afterEach, describe, expect, test } from "bun:test";
import type { SpeechEngine } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  createAnthropicProvider,
  createCustomProvider,
  createGeminiProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  customModelId,
  type ModelMessage,
  type ModelProvider,
  type ToolImage,
} from "@agenteschat/providers";
import {
  type ArtifactActor,
  createFileArtifact,
  drainOutbox,
  fileForModel,
  grantScopes,
  MCP_IMAGES_TOO_OLD,
  markdownToDocx,
  markdownToPdf,
  mcpResultFrame,
  postPersonMessage,
  type ToolContext,
  transcriptKey,
  zip,
} from "../src";
import { PNG, pptxFixture, xlsxFixture } from "./file-fixtures";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DRIVE = ["drive:read"].map((scope) => ({ connectionId: null, scope }));
const bytesOf = (s: string) => new TextEncoder().encode(s);
const agentActor = (): ArtifactActor => ({ type: "agent", agentId: f.agent.id, channelId: f.general.id });

/** A speech engine that hears one sentence and counts how often it was asked. */
function fakeSpeech(): SpeechEngine & { calls: number } {
  const engine = {
    id: "local" as const,
    model: "fake",
    nanoUsdPerHour: 0,
    minBilledSeconds: 0,
    calls: 0,
    async file() {
      engine.calls++;
      return { text: "Bom dia, a reunião mudou para as três." };
    },
  };
  return engine;
}

async function runCtx(): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev oi",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: run.threadRootId,
    triggerMessageId: msg.id,
  };
}

const readArtifact = async (ctx: ToolContext, id: string) => {
  const outcome = await f.tools?.invoke(ctx, {
    toolUseId: crypto.randomUUID(),
    name: "read_artifact",
    input: { artifact_id: id },
  });
  if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
  return outcome.output;
};

/** Every file type people send, as its bytes, and what each must give the AI. */
function files() {
  const bigJpeg = new Uint8Array(4_000_000);
  bigJpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  return [
    { name: "print.png", bytes: PNG, shown: "picture", has: "It is a picture: shown to you" },
    { name: "foto.jpg", bytes: bigJpeg, shown: null, has: "past the 3.3 MB an AI is shown at once" },
    {
      name: "relatorio.pdf",
      bytes: markdownToPdf("# Relatório\n\nVendas subiram.", { fonts: "standard" }),
      shown: "pdf",
      has: "It is a PDF (1 page)",
    },
    {
      name: "contrato.docx",
      bytes: markdownToDocx("Cláusula primeira: prazo de 30 dias."),
      shown: null,
      has: "Cláusula primeira",
    },
    { name: "deck.pptx", bytes: pptxFixture(), shown: null, has: "Metas & prazos" },
    { name: "precos.xlsx", bytes: xlsxFixture(), shown: null, has: '"Café, moído",sim,12.5,TRUE' },
    { name: "dados.csv", bytes: bytesOf("nome,valor\nAna,10\n"), shown: null, has: "Ana,10" },
    {
      name: "app.ts",
      bytes: bytesOf("export const total = 42;\n"),
      shown: null,
      has: "export const total = 42;",
      type: "video/mp2t",
    },
    {
      name: "voz.mp3",
      bytes: new Uint8Array([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0]),
      shown: null,
      has: "a reunião mudou",
    },
    {
      name: "clip.mp4",
      bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
      shown: null,
      has: "review_media watches it",
    },
    { name: "fotos.zip", bytes: zip([["a.png", PNG]]), shown: null, has: "It is a zip archive" },
  ];
}

/** The brains an API agent may think with, as the request each sends. */
const CRED = "0b9c8a52-4c1f-4f7e-9a11-7d0f2b6c3e10";
type Brain = { name: string; reads: "all" | "pictures" | "text"; send: (messages: ModelMessage[]) => Promise<string> };
function brains(): Brain[] {
  const via =
    (make: (fetcher: typeof fetch) => ModelProvider, model: string, extra: Record<string, unknown> = {}) =>
    async (messages: ModelMessage[]) => {
      let body = "";
      const fetcher = (async (_url: unknown, init?: RequestInit) => {
        body = String(init?.body ?? "");
        return new Response("", { status: 500 });
      }) as unknown as typeof fetch;
      await make(fetcher)
        .stream({ model, system: "s", messages, maxTokens: 10 }, { apiKey: "k-123456789", onDelta() {}, ...extra })
        .catch(() => undefined);
      return body;
    };
  return [
    {
      name: "Claude (Anthropic)",
      reads: "all",
      send: via((fetch) => createAnthropicProvider({ fetch, maxRetries: 0 }), "claude-sonnet-5-5"),
    },
    {
      name: "GPT (OpenAI)",
      reads: "all",
      send: via((fetch) => createOpenAIProvider({ fetch, maxRetries: 0 }), "gpt-6-sol"),
    },
    { name: "Gemini", reads: "all", send: via((fetch) => createGeminiProvider({ fetch }), "gemini-3.8-flash") },
    {
      name: "OpenRouter",
      reads: "text",
      send: via((fetch) => createOpenRouterProvider({ fetch, maxRetries: 0 }), "deepseek/deepseek-v4-pro"),
    },
    {
      name: "DeepSeek (Anthropic-compatible)",
      reads: "text",
      send: via(
        (fetch) =>
          createAnthropicProvider({
            fetch,
            maxRetries: 0,
            compat: { toolChoiceAny: true },
            baseURL: "https://api.example.com/anthropic",
          }),
        "deepseek-v4-pro",
      ),
    },
    {
      name: "Claude on a workspace endpoint",
      reads: "all",
      send: via(
        (fetch) => createCustomProvider({ fetch, maxRetries: 0 }),
        customModelId(CRED, "global.anthropic.claude-sonnet-5-5"),
        {
          endpoint: { style: "anthropic", baseURL: "https://gw.example.com/anthropic" },
        },
      ),
    },
    {
      name: "Kimi on a workspace endpoint",
      reads: "text",
      send: via(
        (fetch) => createCustomProvider({ fetch, maxRetries: 0 }),
        customModelId(CRED, "moonshotai.kimi-k2.5"),
        {
          endpoint: { style: "anthropic", baseURL: "https://gw.example.com/anthropic" },
        },
      ),
    },
    {
      name: "OpenAI-style workspace endpoint",
      reads: "text",
      send: via((fetch) => createCustomProvider({ fetch, maxRetries: 0 }), customModelId(CRED, "llama-4"), {
        endpoint: { style: "openai", baseURL: "https://gw.example.com/v1" },
      }),
    },
  ];
}

/** A tool_result block in each provider's own shape for a picture and for a PDF. */
const PICTURE_BLOCK = /"type":"image"|"type":"input_image"/;
const PDF_BLOCK = /"type":"document"|"type":"input_file"/;

const turn = (content: string, images?: ToolImage[]): ModelMessage[] => [
  { role: "user", content: "o que tem no arquivo?" },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_artifact", input: {} }] },
  { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content, ...(images ? { images } : {}) }] },
];

describe("attachments reach every brain", () => {
  test("read_artifact × file type × brain: shown, read out as text, or the exact cause", async () => {
    f = await setup({ artifactTools: true, reply: () => ({ chunks: ["ok"] }) });
    const speech = fakeSpeech();
    f.artifactDeps.speech = () => [speech];
    await grantScopes(f.db, f.org.id, f.agent.id, DRIVE);
    const ctx = await runCtx();
    const all = files();
    const matrix: string[] = [];
    for (const file of all) {
      const a = await createFileArtifact(f.artifactDeps, agentActor(), f.org.id, {
        title: file.name,
        name: file.name,
        bytes: file.bytes,
        ...(file.type ? { contentType: file.type } : {}),
      });
      const out = await readArtifact(ctx, a.id);
      expect(out.isError).toBeFalsy();
      expect(out.content).toContain(file.has);
      expect(out.content).not.toContain("Binary: its bytes");
      if (file.shown === "picture") expect(out.images?.[0]?.mediaType).toBe("image/png");
      else if (file.shown === "pdf") expect(out.images?.[0]).toMatchObject({ mediaType: "application/pdf", pages: 1 });
      else expect(out.images).toBeUndefined();

      for (const brain of brains()) {
        const body = await brain.send(turn(out.content, out.images));
        expect(body.length).toBeGreaterThan(0);
        const readsIt = brain.reads === "all";
        let got: string;
        if (file.shown === "picture") {
          expect(PICTURE_BLOCK.test(body)).toBe(readsIt);
          if (!readsIt) expect(body).toContain("The picture is not shown to you: this agent's AI (");
          got = readsIt ? "picture" : "note";
        } else if (file.shown === "pdf") {
          expect(PDF_BLOCK.test(body)).toBe(readsIt);
          if (!readsIt) expect(body).toContain("The PDF is not shown to you");
          got = readsIt ? "pdf" : "note";
        } else {
          // Text, and every exact cause, reach every brain as they are.
          expect(body).toContain(JSON.stringify(file.has).slice(1, -1));
          got = "text";
        }
        matrix.push(`${file.name} × ${brain.name}: ${got}`);
      }
    }
    expect(matrix).toHaveLength(all.length * brains().length);

    // An audio file is transcribed once per version: the words are kept beside its bytes.
    expect(speech.calls).toBe(1);
    const voz = (await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.title, "voz.mp3")))[0];
    if (!voz) throw new Error("no voz.mp3");
    const again = await fileForModel(f.artifactDeps, agentActor(), f.org.id, voz.id);
    expect(again.text).toBe("Bom dia, a reunião mudou para as três.");
    expect(speech.calls).toBe(1);
    const [v] = await f.db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, voz.id));
    const store = await f.artifactDeps.blobs.forConfig(f.org.id, v?.storageConfigId ?? null);
    expect(await store.get(transcriptKey(v?.blobKey ?? ""))).not.toBeNull();
  });

  test("no speech engine on the server: the audio's exact cause, never an empty file", async () => {
    f = await setup({ artifactTools: true, reply: () => ({ chunks: ["ok"] }) });
    const a = await createFileArtifact(f.artifactDeps, agentActor(), f.org.id, {
      title: "nota.m4a",
      name: "nota.m4a",
      bytes: new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41]),
    });
    const out = await fileForModel(f.artifactDeps, agentActor(), f.org.id, a.id);
    expect(out.note).toContain("this server has no speech-to-text set up");
    expect(out.text).toBeUndefined();
  });
});

test("a reply whose file reached a text-only connection carries its way out (meta.filesTextOnly)", async () => {
  let call = 0;
  f = await setup({
    reply: () => ({ chunks: ["Não vejo a imagem."], ...(++call === 1 ? { imagesLeftOut: true } : {}) }),
  });
  const reply = async () => {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    const rows = await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, f.agent.id));
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1);
  };
  expect((await reply())?.meta.filesTextOnly).toBe(true);
  expect((await reply())?.meta.filesTextOnly).toBeUndefined();
});

describe("computer brains through the runner bridge", () => {
  const picture = { mediaType: "image/png", data: Buffer.from(PNG).toString("base64") };

  test("a runner at the images protocol gets the pictures; an older one is told to update", () => {
    const out = {
      ok: true as const,
      text: "File print.png. It is a picture: shown to you with this result.",
      images: [picture],
    };
    expect(mcpResultFrame("c1", out, 62)).toEqual({
      type: "mcp.result",
      callId: "c1",
      ok: true,
      text: out.text,
      images: [picture],
    });
    const old = mcpResultFrame("c1", out, 61);
    expect(old).toEqual({ type: "mcp.result", callId: "c1", ok: true, text: `${out.text}\n${MCP_IMAGES_TOO_OLD}` });
    expect(mcpResultFrame("c2", { ok: true, text: "plain" }, 40)).toEqual({
      type: "mcp.result",
      callId: "c2",
      ok: true,
      text: "plain",
    });
    expect(mcpResultFrame("c3", { ok: false, error: { code: "x", message: "no" } }, 62)).toEqual({
      type: "mcp.result",
      callId: "c3",
      ok: false,
      error: { code: "x", message: "no" },
    });
  });

  test("pictures too big for one frame stay out with a note, never a frame the runner drops", () => {
    const huge = { mediaType: "image/png", data: "A".repeat(4_500_000) };
    const frame = mcpResultFrame("c1", { ok: true, text: "two", images: [huge, huge] }, 62);
    expect("images" in frame).toBe(false);
    expect(frame.ok && frame.text).toContain("too big together to pass to this computer");
  });
});
