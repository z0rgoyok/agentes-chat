import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import {
  createCustomProvider,
  createGeminiProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  IMAGE_ASPECTS,
  IMAGE_CATALOG,
  IMAGE_MODEL_IDS,
  type ImageRequest,
  imageCostNanoUsd,
  imageModelInfo,
  imagePixels,
  imageTypeOf,
  isImageBlocked,
  looksLikeImageModel,
  MODEL_CATALOG,
  type ModelProvider,
  maxImageCostNanoUsd,
  nearestAspect,
  ProviderError,
  typicalImageCostNanoUsd,
} from "../src";
import { createFakeProvider, fakeImagePng } from "../src/fake";

/** A tiny real PNG the providers' answers carry (the fake's drawing). */
const PNG = fakeImagePng("a lighthouse at dusk", "1:1");
const PNG_B64 = Buffer.from(PNG).toString("base64");

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  /** JSON bodies parsed; multipart bodies as their field names. */
  body: Record<string, unknown> | string[] | null;
}

/** A transport answering each request with the next scripted answer (the last one repeats). No network. */
function answers(...replies: (Response | (() => Response))[]) {
  const sent: Sent[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    // The OpenAI SDK reads a `data:` URL once to learn how the transport sends multipart bodies.
    if (url.startsWith("data:")) return fetch(url);
    const raw = init?.body;
    let body: Sent["body"] = null;
    if (typeof raw === "string") body = JSON.parse(raw) as Record<string, unknown>;
    else if (raw instanceof FormData) body = [...raw.keys()];
    else if (raw) {
      const text = await new Response(raw as ConstructorParameters<typeof Response>[0]).text();
      body = [...text.matchAll(/name="([^"]+)"/g)].map((m) => m[1] ?? "");
    }
    sent.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
    if (!reply) throw new Error("no scripted answer");
    return typeof reply === "function" ? reply() : reply.clone();
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const request = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  model: "gemini-nano-banana-2.1",
  prompt: "a lighthouse at dusk",
  count: 1,
  aspect: "16:9",
  ...over,
});

const failure = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e as ProviderError);

/** A provider's `generateImage`, which every adapter here has. */
function imagesOf(provider: ModelProvider) {
  const generate = provider.generateImage;
  if (!generate) throw new Error(`${provider.id} makes no pictures`);
  return generate;
}

describe("the image catalog", () => {
  test("lives apart from the chat models, Nano Banana 2.1 first, every entry coherent", () => {
    expect(IMAGE_MODEL_IDS[0]).toBe("gemini-nano-banana-2.1");
    for (const [id, info] of Object.entries(IMAGE_CATALOG)) {
      expect(MODEL_CATALOG[id]).toBeUndefined();
      expect(info.aspects.length).toBeGreaterThan(0);
      for (const a of info.aspects) expect(IMAGE_ASPECTS).toContain(a);
      expect(info.maxCount).toBeGreaterThanOrEqual(1);
      expect(info.maxCount).toBeLessThanOrEqual(4);
      expect(info.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (info.price.per === "image") for (const size of info.sizes) expect(info.price.bySize[size]).toBeGreaterThan(0);
      expect(typicalImageCostNanoUsd(id)).toBeGreaterThan(0);
    }
    expect(Object.values(IMAGE_CATALOG).map((m) => m.provider)).toEqual(
      expect.arrayContaining(["gemini", "openai", "openrouter"]),
    );
  });

  test("a workspace endpoint's model is priced by the workspace; anything else is unknown", () => {
    const id = "custom:5b0a3c66-7a35-4b8e-9d3b-2f6a1c9e8d10:flux.1-schnell";
    expect(imageModelInfo(id)).toMatchObject({
      provider: "custom",
      apiModel: "flux.1-schnell",
      price: { per: "free" },
    });
    expect(imageModelInfo("claude-sonnet-5-5")).toBeUndefined();
    expect(imageModelInfo("custom:not-a-uuid:flux")).toBeUndefined();
    expect(looksLikeImageModel("flux.1-schnell")).toBe(true);
    expect(looksLikeImageModel("stable-diffusion-xl")).toBe(true);
    expect(looksLikeImageModel("llama-4-scout")).toBe(false);
  });

  test("an aspect a model doesn't take goes to its nearest; pixels are steps of 16 with the right shape", () => {
    const mini = IMAGE_CATALOG["gpt-image-1-mini"];
    if (!mini) throw new Error("missing gpt-image-1-mini");
    expect(nearestAspect(mini, "16:9")).toBe("3:2");
    expect(nearestAspect(mini, "9:16")).toBe("2:3");
    expect(nearestAspect(mini, "1:1")).toBe("1:1");
    expect(imagePixels("1:1")).toBe("1024x1024");
    expect(imagePixels("3:2")).toBe("1536x1024");
    expect(imagePixels("16:9")).toBe("1536x864");
    expect(imagePixels("9:16")).toBe("864x1536");
    expect(imagePixels("4:3", "2K")).toBe("2048x1536");
    expect(imagePixels("16:9", "1K", true)).toBe("1536x1024");
    expect(imagePixels("3:4", "1K", true)).toBe("1024x1536");
    for (const a of IMAGE_ASPECTS) {
      const [w, h] = imagePixels(a).split("x").map(Number);
      expect((w ?? 0) % 16).toBe(0);
      expect((h ?? 0) % 16).toBe(0);
    }
  });
});

describe("what a request costs", () => {
  test("per picture: reserved for every picture asked, settled for the ones made", () => {
    const at = maxImageCostNanoUsd("gemini-nano-banana-2.1", { count: 3, prompt: "x", size: "1K" });
    expect(at).toBe(3 * 33_600_000);
    expect(maxImageCostNanoUsd("gemini-nano-banana-2.1", { count: 1, prompt: "x", size: "2K" })).toBe(50_400_000);
    const made = { images: [{ mediaType: "image/png", bytes: PNG }] };
    expect(imageCostNanoUsd("gemini-3.1-flash-image", { size: "1K" }, made)).toBe(67_000_000);
  });

  test("per token: the usage priced at each rate; without usage, each picture at its worst", () => {
    const usage = { textInputTokens: 100, imageInputTokens: 1000, outputTokens: 2000 };
    const made = { images: [{ mediaType: "image/png", bytes: PNG }], usage };
    // gpt-image-2: text $5/M, pictures in $8/M, out $30/M.
    expect(imageCostNanoUsd("gpt-image-2", {}, made)).toBe(100 * 5000 + 1000 * 8000 + 2000 * 30_000);
    expect(imageCostNanoUsd("gpt-image-2", {}, { images: made.images })).toBe(8000 * 30_000);
    const worst = maxImageCostNanoUsd("gpt-image-2", {
      count: 2,
      prompt: "x".repeat(400),
      references: [{ mediaType: "image/png", data: "" }],
    });
    // One call for both, so the prompt and the reference count once; each picture at 8000 tokens out.
    expect(worst).toBe((200 + 64) * 5000 + 6500 * 8000 + 2 * 8000 * 30_000);
  });

  test("reported: what the provider says, else typical; free: nothing unless the admin priced the tokens", () => {
    const one = { images: [{ mediaType: "image/png", bytes: PNG }] };
    expect(imageCostNanoUsd("openrouter:openai/gpt-image-2", {}, { ...one, costNanoUsd: 123_456 })).toBe(123_456);
    expect(imageCostNanoUsd("openrouter:openai/gpt-image-2", {}, one)).toBe(60_000_000);
    expect(maxImageCostNanoUsd("openrouter:openai/gpt-image-2", { count: 2, prompt: "x" })).toBe(600_000_000);
    const custom = "custom:5b0a3c66-7a35-4b8e-9d3b-2f6a1c9e8d10:flux";
    expect(imageCostNanoUsd(custom, {}, { ...one, costNanoUsd: 999 })).toBe(0);
    expect(maxImageCostNanoUsd(custom, { count: 4, prompt: "x" })).toBe(0);
    const usage = { textInputTokens: 10, imageInputTokens: 0, outputTokens: 100 };
    expect(imageCostNanoUsd(custom, {}, { ...one, usage }, { input: 2, output: 3 })).toBe(10 * 2 + 100 * 3);
    expect(() => maxImageCostNanoUsd("nope", { count: 1, prompt: "x" })).toThrow();
  });
});

/** An interaction answer with one picture in its `model_output` step. */
const interaction = (data = PNG_B64, extra: Record<string, unknown> = {}) => ({
  id: "v1_img",
  status: "completed",
  model: "gemini-nano-banana-2.1",
  steps: [
    { type: "user_input", content: [{ type: "text", text: "a lighthouse at dusk" }] },
    { type: "model_output", content: [{ type: "image", mime_type: "image/png", data }] },
  ],
  usage: { total_input_tokens: 12, total_output_tokens: 1290 },
  ...extra,
});

describe("Gemini (Interactions API)", () => {
  test("one call per picture, the image response format, the prompt and references as input items", async () => {
    const { fetcher, sent } = answers(json(interaction()));
    const provider = createGeminiProvider({ fetch: fetcher });
    const result = await provider.generateImage?.(
      request({ count: 2, references: [{ mediaType: "image/jpeg", data: "AAAA" }] }),
      { apiKey: "AQ.key" },
    );
    expect(result?.images).toHaveLength(2);
    expect(result?.images[0]?.mediaType).toBe("image/png");
    expect(result?.usage).toEqual({ textInputTokens: 24, imageInputTokens: 0, outputTokens: 2580 });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(sent[0]?.headers.get("x-goog-api-key")).toBe("AQ.key");
    expect(sent[0]?.body).toEqual({
      model: "gemini-nano-banana-2.1",
      input: [
        { type: "text", text: "a lighthouse at dusk" },
        { type: "image", mime_type: "image/jpeg", data: "AAAA" },
      ],
      response_format: { type: "image", aspect_ratio: "16:9", image_size: "1K" },
      store: false,
    });
  });

  test("older answers' shapes are read too", async () => {
    const { fetcher } = answers(json({ status: "completed", outputs: [{ type: "image", data: PNG_B64 }] }));
    const result = await createGeminiProvider({ fetch: fetcher }).generateImage?.(request(), { apiKey: "k" });
    expect(result?.images).toHaveLength(1);
  });

  test("a blocked prompt, or words instead of a picture, is a refusal", async () => {
    const blocked = answers(json({ status: "failed", errors: [{ code: "safety", message: "Blocked for safety" }] }));
    const one = await failure(imagesOf(createGeminiProvider({ fetch: blocked.fetcher }))(request(), { apiKey: "k" }));
    expect(isImageBlocked(one)).toBe(true);
    expect(one?.said).toBe("Blocked for safety");
    const words = answers(
      json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "I can't." }] }] }),
    );
    const two = await failure(imagesOf(createGeminiProvider({ fetch: words.fetcher }))(request(), { apiKey: "k" }));
    expect(isImageBlocked(two)).toBe(true);
  });

  test("a failure after a picture came keeps the picture and says why the rest didn't", async () => {
    const { fetcher } = answers(json(interaction()), json({ error: { code: "rate_limit_exceeded" } }, 429));
    const result = await createGeminiProvider({ fetch: fetcher }).generateImage?.(request({ count: 3 }), {
      apiKey: "k",
    });
    expect(result?.images).toHaveLength(1);
    expect(result?.error).toBeInstanceOf(ProviderError);
    expect(result?.error?.retryable).toBe(true);
  });

  test("a refused key fails the call at once; something that isn't a picture is never stored", async () => {
    const bad = answers(json({ error: { code: "authentication", message: "API key not valid" } }, 401));
    const error = await failure(imagesOf(createGeminiProvider({ fetch: bad.fetcher }))(request(), { apiKey: "k" }));
    expect(error?.status).toBe(401);
    const html = answers(json(interaction(Buffer.from("<html>nope</html>").toString("base64"))));
    const junk = await failure(imagesOf(createGeminiProvider({ fetch: html.fetcher }))(request(), { apiKey: "k" }));
    expect(junk?.message).toContain("could not read");
  });
});

describe("OpenAI (GPT Image)", () => {
  const imagesResponse = (n = 1) => ({
    created: 1,
    data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })),
    usage: {
      input_tokens: 50,
      input_tokens_details: { text_tokens: 40, image_tokens: 10 },
      output_tokens: 1056,
      total_tokens: 1106,
    },
  });

  test("generations: n pictures in one call, sized by the aspect, medium WebP, token usage", async () => {
    const { fetcher, sent } = answers(json(imagesResponse(2)));
    const provider = createOpenAIProvider({ fetch: fetcher, maxRetries: 0 });
    const result = await provider.generateImage?.(request({ model: "gpt-image-2", count: 2 }), { apiKey: "sk-test" });
    expect(result?.images).toHaveLength(2);
    expect(result?.usage).toEqual({ textInputTokens: 40, imageInputTokens: 10, outputTokens: 1056 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.openai.com/v1/images/generations");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(sent[0]?.body).toMatchObject({
      model: "gpt-image-2",
      prompt: "a lighthouse at dusk",
      n: 2,
      size: "1536x864",
      quality: "medium",
      output_format: "webp",
    });
    expect((sent[0]?.body as Record<string, unknown> | undefined)?.response_format).toBeUndefined();
  });

  test("the first GPT Image models get their nearest fixed size", async () => {
    const { fetcher, sent } = answers(json(imagesResponse()));
    await createOpenAIProvider({ fetch: fetcher, maxRetries: 0 }).generateImage?.(
      request({ model: "gpt-image-1-mini", aspect: "16:9" }),
      { apiKey: "sk-test" },
    );
    expect((sent[0]?.body as Record<string, unknown> | undefined)?.size).toBe("1536x1024");
  });

  test("with references: edits, the pictures sent as files", async () => {
    const { fetcher, sent } = answers(json(imagesResponse()));
    const result = await createOpenAIProvider({ fetch: fetcher, maxRetries: 0 }).generateImage?.(
      request({ model: "gpt-image-2", references: [{ mediaType: "image/png", data: PNG_B64 }] }),
      { apiKey: "sk-test" },
    );
    expect(result?.images).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.openai.com/v1/images/edits");
    expect(sent[0]?.body).toEqual(expect.arrayContaining(["prompt", "model", "n", "size"]));
    expect(JSON.stringify(sent[0]?.body)).toContain("image");
  });

  test("a prompt its moderation refuses is a refusal; a refused key is the usual failure", async () => {
    const refused = answers(
      json({ error: { message: "Your request was rejected by the safety system.", code: "moderation_blocked" } }, 400),
    );
    const one = await failure(
      imagesOf(createOpenAIProvider({ fetch: refused.fetcher, maxRetries: 0 }))(request({ model: "gpt-image-2" }), {
        apiKey: "sk",
      }),
    );
    expect(isImageBlocked(one)).toBe(true);
    const key = answers(json({ error: { message: "Incorrect API key", code: "invalid_api_key" } }, 401));
    const two = await failure(
      imagesOf(createOpenAIProvider({ fetch: key.fetcher, maxRetries: 0 }))(request({ model: "gpt-image-2" }), {
        apiKey: "sk",
      }),
    );
    expect(isImageBlocked(two)).toBe(false);
    expect(two?.status).toBe(401);
  });
});

describe("OpenRouter (Images API)", () => {
  test("one request for n pictures, references as data URLs, its reported cost, attribution", async () => {
    const { fetcher, sent } = answers(
      json({
        model: "openai/gpt-image-2",
        data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }],
        usage: { cost: 0.12 },
      }),
    );
    const provider = createOpenRouterProvider({ fetch: fetcher });
    const result = await provider.generateImage?.(
      request({
        model: "openai/gpt-image-2",
        count: 2,
        aspect: "3:2",
        references: [{ mediaType: "image/png", data: "AAAA" }],
      }),
      { apiKey: "sk-or-test" },
    );
    expect(result?.images).toHaveLength(2);
    expect(result?.costNanoUsd).toBe(120_000_000);
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/images");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(sent[0]?.headers.get("x-openrouter-title")).toBe("agentes.chat");
    expect(sent[0]?.body).toEqual({
      model: "openai/gpt-image-2",
      prompt: "a lighthouse at dusk",
      n: 2,
      aspect_ratio: "3:2",
      resolution: "1K",
      input_references: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    });
  });

  test("fewer pictures than asked: it asks again for the rest, adding up the cost", async () => {
    const one = json({ data: [{ b64_json: PNG_B64 }], usage: { cost: 0.04 } });
    const { fetcher, sent } = answers(one, one);
    const result = await createOpenRouterProvider({ fetch: fetcher }).generateImage?.(
      request({ model: "bytedance-seed/seedream-4.5", count: 2 }),
      { apiKey: "k" },
    );
    expect(result?.images).toHaveLength(2);
    expect(result?.costNanoUsd).toBe(80_000_000);
    expect((sent[1]?.body as Record<string, unknown> | undefined)?.n).toBe(1);
  });

  test("its moderation refusing the prompt is a refusal; no credit is the usual failure", async () => {
    const refused = answers(json({ error: { code: 403, message: "Input was flagged by moderation" } }, 403));
    const one = await failure(
      imagesOf(createOpenRouterProvider({ fetch: refused.fetcher }))(request(), { apiKey: "k" }),
    );
    expect(isImageBlocked(one)).toBe(true);
    const broke = answers(json({ error: { code: 402, message: "Insufficient credits" } }, 402));
    const two = await failure(imagesOf(createOpenRouterProvider({ fetch: broke.fetcher }))(request(), { apiKey: "k" }));
    expect(two?.status).toBe(402);
  });

  test("a workspace endpoint speaking Chat Completions makes no pictures through this route", () => {
    const compatible = createOpenRouterProvider({
      compatible: { id: "custom", baseURL: "https://llm.example.com/v1" },
    });
    expect(compatible.generateImage).toBeUndefined();
  });
});

describe("a workspace's own endpoint (Images API)", () => {
  const endpoint = { style: "openai" as const, baseURL: "https://images.example.com/v1" };
  const custom = "custom:5b0a3c66-7a35-4b8e-9d3b-2f6a1c9e8d10:flux.1-schnell";

  test("asks for base64 at the endpoint's address with its own model id; a reported cost is ignored", async () => {
    const { fetcher, sent } = answers(json({ created: 1, data: [{ b64_json: PNG_B64 }], cost: 1 }));
    const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).generateImage?.(
      request({ model: custom }),
      { apiKey: "none", endpoint },
    );
    expect(result?.images).toHaveLength(1);
    expect(result?.costNanoUsd).toBeUndefined();
    expect(sent[0]?.url).toBe("https://images.example.com/v1/images/generations");
    expect(sent[0]?.body).toMatchObject({ model: "flux.1-schnell", n: 1, response_format: "b64_json" });
  });

  test("a picture answered as an address is read through the same guarded transport", async () => {
    const { fetcher, sent } = answers(
      json({ created: 1, data: [{ url: "https://images.example.com/out/1.png" }] }),
      new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
    const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).generateImage?.(
      request({ model: custom }),
      { apiKey: "none", endpoint },
    );
    expect(result?.images[0]?.bytes).toEqual(PNG);
    expect(sent[1]?.url).toBe("https://images.example.com/out/1.png");
  });

  test("an Anthropic-style endpoint, or none, makes no pictures", async () => {
    const provider = createCustomProvider({ fetch: answers(json({})).fetcher });
    const error = await failure(
      imagesOf(provider)(request({ model: custom }), {
        apiKey: "none",
        endpoint: { style: "anthropic", baseURL: "https://llm.example.com/anthropic" },
      }),
    );
    expect(error?.message).toContain("no pictures");
  });
});

describe("the fake provider's pictures", () => {
  /** Width and height from a PNG's header, and its pixels inflated. */
  function readPng(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const w = view.getUint32(16);
    const h = view.getUint32(20);
    const idatLength = view.getUint32(33);
    const raw = inflateSync(bytes.subarray(41, 41 + idatLength));
    return { w, h, raw };
  }

  test("a valid PNG in the aspect asked, the same for the same prompt, another for another", () => {
    for (const aspect of IMAGE_ASPECTS) {
      const png = fakeImagePng("a fox in the snow", aspect);
      expect(imageTypeOf(png)).toBe("image/png");
      const { w, h, raw } = readPng(png);
      expect(Math.max(w, h)).toBe(96);
      const [aw, ah] = aspect.split(":").map(Number);
      expect(Math.abs(w / h - (aw ?? 1) / (ah ?? 1))).toBeLessThan(0.05);
      expect(raw.length).toBe(h * (1 + w * 3));
    }
    expect(fakeImagePng("a fox", "1:1")).toEqual(fakeImagePng("a fox", "1:1"));
    expect(fakeImagePng("a fox", "1:1")).not.toEqual(fakeImagePng("a bear", "1:1"));
    expect(fakeImagePng("a fox", "1:1", 0)).not.toEqual(fakeImagePng("a fox", "1:1", 1));
  });

  test("records each call and answers as scripted", async () => {
    const fake = createFakeProvider(undefined, {
      image: (_request, call) =>
        call === 1
          ? { count: 1, usage: { textInputTokens: 1, imageInputTokens: 0, outputTokens: 2 } }
          : new ProviderError("down", true, 503),
    });
    const first = await fake.generateImage(request({ count: 2 }), { apiKey: "k" });
    expect(first.images).toHaveLength(1);
    expect(first.usage?.outputTokens).toBe(2);
    expect(await failure(fake.generateImage(request(), { apiKey: "k" }))).toBeInstanceOf(ProviderError);
    expect(fake.imageCalls.map((c) => c.request.count)).toEqual([2, 1]);
    expect(fake.imageCalls[0]?.apiKey).toBe("k");
  });
});
