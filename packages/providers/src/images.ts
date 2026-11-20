import { type Endpoint, ProviderError } from "./types";

/**
 * Image generation (ADR 0197): one catalog of image models, apart from the chat models' `MODEL_CATALOG`, so image
 * models never show up in model pickers, the router or Automático. Pure data and arithmetic: the apps import it
 * (`@agenteschat/providers/images`) to list and price models without the SDKs. Only the Model Gateway calls a
 * provider's `generateImage`.
 */

/** The shapes a picture can take. */
export type ImageAspect = "1:1" | "3:2" | "2:3" | "4:3" | "3:4" | "16:9" | "9:16";
export const IMAGE_ASPECTS: readonly ImageAspect[] = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];
export const isImageAspect = (value: unknown): value is ImageAspect => IMAGE_ASPECTS.includes(value as ImageAspect);

/** How large: about a thousand or two thousand pixels on the long side. */
export type ImageSize = "1K" | "2K";
export const IMAGE_SIZES: readonly ImageSize[] = ["1K", "2K"];

/** At most this many pictures one request makes (ADR 0197). */
export const MAX_IMAGES_PER_REQUEST = 4;
/** At most this many pictures one request starts from (variations, edits). */
export const MAX_IMAGE_REFERENCES = 4;
/** The longest prompt a request takes, in characters. */
export const MAX_IMAGE_PROMPT_CHARS = 4000;

/** Who makes an image model: providers of `PROVIDERS` that have an image API. */
export type ImageProviderId = "gemini" | "openai" | "openrouter" | "custom";

/**
 * How a model is billed, in nano-USD (1e-9 USD), as its maker bills it:
 * - `image`: a price per picture by its size;
 * - `token`: per token of text in, pictures in and out (OpenAI's GPT Image), priced from the response's usage; a
 *   picture's worst case is `worstOutputTokens` out;
 * - `reported`: the provider says what each call cost (OpenRouter's `usage.cost`); `typical` prices a call that
 *   says nothing, `worst` reserves the budget;
 * - `free`: nothing (a workspace's own endpoint, unless its admin priced its tokens).
 */
export type ImagePrice =
  | { per: "image"; bySize: Partial<Record<ImageSize, number>> }
  | { per: "token"; textInput: number; imageInput: number; output: number; worstOutputTokens: number }
  | { per: "reported"; typical: number; worst: number }
  | { per: "free" };

export interface ImageModelInfo {
  provider: ImageProviderId;
  /** What people read in the canvas's model menu. */
  label: string;
  /** The id sent to the provider's API. */
  apiModel: string;
  aspects: readonly ImageAspect[];
  sizes: readonly ImageSize[];
  /** Pictures one request may ask for. */
  maxCount: number;
  /** Pictures one API call returns: more are made by calling again. */
  perCall: number;
  /** It takes pictures to start from (variations, edits). */
  refs: boolean;
  price: ImagePrice;
  /** The day its price was read on the maker's page (prices change often; each call is priced at its time). */
  pricedAt: string;
}

const ALL_ASPECTS = IMAGE_ASPECTS;
/** GPT Image's three fixed sizes (`gpt-image-1-mini`): square, landscape, portrait. */
const THREE_ASPECTS: readonly ImageAspect[] = ["1:1", "3:2", "2:3"];
const usd = (value: number) => Math.round(value * 1e9);
/** USD per million tokens, as nano-USD per token. */
const perMillion = (value: number) => Math.round(value * 1000);

/**
 * Image models by id, the default first: a workspace's default is the first one it has a key for (ADR 0197). Prices
 * from each maker's page on 2026-11-17: Gemini per picture by size, OpenAI per token (GPT Image), OpenRouter as it
 * reports each call. Update the table when prices change: usage rows keep the cost of their time.
 */
export const IMAGE_CATALOG: Record<string, ImageModelInfo> = {
  "gemini-nano-banana-2.1": {
    provider: "gemini",
    label: "Nano Banana 2.1",
    apiModel: "gemini-nano-banana-2.1",
    aspects: ALL_ASPECTS,
    sizes: ["1K", "2K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: 1,
    refs: true,
    price: { per: "image", bySize: { "1K": usd(0.0336), "2K": usd(0.0504) } },
    pricedAt: "2026-11-17",
  },
  "gemini-3.1-flash-image": {
    provider: "gemini",
    label: "Nano Banana 2",
    apiModel: "gemini-3.1-flash-image",
    aspects: ALL_ASPECTS,
    sizes: ["1K", "2K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: 1,
    refs: true,
    price: { per: "image", bySize: { "1K": usd(0.067), "2K": usd(0.101) } },
    pricedAt: "2026-11-17",
  },
  "gemini-3-pro-image": {
    provider: "gemini",
    label: "Nano Banana Pro",
    apiModel: "gemini-3-pro-image",
    aspects: ALL_ASPECTS,
    sizes: ["1K", "2K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: 1,
    refs: true,
    price: { per: "image", bySize: { "1K": usd(0.134), "2K": usd(0.134) } },
    pricedAt: "2026-11-17",
  },
  "gemini-3.1-flash-lite-image": {
    provider: "gemini",
    label: "Nano Banana 2 Lite",
    apiModel: "gemini-3.1-flash-lite-image",
    aspects: ALL_ASPECTS,
    sizes: ["1K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: 1,
    refs: true,
    price: { per: "image", bySize: { "1K": usd(0.0336) } },
    pricedAt: "2026-11-17",
  },
  "gpt-image-2": {
    provider: "openai",
    label: "GPT Image 2",
    apiModel: "gpt-image-2",
    aspects: ALL_ASPECTS,
    sizes: ["1K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: MAX_IMAGES_PER_REQUEST,
    refs: true,
    price: {
      per: "token",
      textInput: perMillion(5),
      imageInput: perMillion(8),
      output: perMillion(30),
      worstOutputTokens: 8000,
    },
    pricedAt: "2026-11-17",
  },
  "gpt-image-1-mini": {
    provider: "openai",
    label: "GPT Image 1 Mini",
    apiModel: "gpt-image-1-mini",
    aspects: THREE_ASPECTS,
    sizes: ["1K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: MAX_IMAGES_PER_REQUEST,
    refs: true,
    price: {
      per: "token",
      textInput: perMillion(2),
      imageInput: perMillion(2.5),
      output: perMillion(8),
      worstOutputTokens: 8000,
    },
    pricedAt: "2026-11-17",
  },
  "gpt-image-2.5-flare": {
    provider: "openai",
    label: "GPT Image 2.5 Flare",
    apiModel: "gpt-image-2.5-flare",
    aspects: ALL_ASPECTS,
    sizes: ["1K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: MAX_IMAGES_PER_REQUEST,
    refs: true,
    price: {
      per: "token",
      textInput: perMillion(5),
      imageInput: perMillion(8),
      output: perMillion(30),
      worstOutputTokens: 8000,
    },
    pricedAt: "2026-11-17",
  },
  "openrouter:google/gemini-2.5-flash-image": {
    provider: "openrouter",
    label: "Gemini 2.5 Flash Image (OpenRouter)",
    apiModel: "google/gemini-2.5-flash-image",
    aspects: ALL_ASPECTS,
    sizes: ["1K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: MAX_IMAGES_PER_REQUEST,
    refs: true,
    price: { per: "reported", typical: usd(0.039), worst: usd(0.06) },
    pricedAt: "2026-11-17",
  },
  "openrouter:openai/gpt-image-2": {
    provider: "openrouter",
    label: "GPT Image 2 (OpenRouter)",
    apiModel: "openai/gpt-image-2",
    aspects: ALL_ASPECTS,
    sizes: ["1K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: MAX_IMAGES_PER_REQUEST,
    refs: true,
    price: { per: "reported", typical: usd(0.06), worst: usd(0.3) },
    pricedAt: "2026-11-17",
  },
  "openrouter:bytedance-seed/seedream-4.5": {
    provider: "openrouter",
    label: "Seedream 4.5 (OpenRouter)",
    apiModel: "bytedance-seed/seedream-4.5",
    aspects: ALL_ASPECTS,
    sizes: ["1K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: MAX_IMAGES_PER_REQUEST,
    refs: true,
    price: { per: "reported", typical: usd(0.04), worst: usd(0.08) },
    pricedAt: "2026-11-17",
  },
};

/** A workspace endpoint's image model (ADR 0146): `custom:<credentialId>:<model>`. */
const CUSTOM_IMAGE_ID = /^custom:([0-9a-f-]{36}):(.+)$/;

/**
 * Whether an endpoint's model id names an image model: endpoints don't say what a model makes, and their ids do (a
 * diffusion model, an image API's model). Only these of an endpoint's models are offered for pictures.
 */
export const looksLikeImageModel = (model: string) =>
  /image|dall-?e|flux|stable-?diffusion|sd-?xl|sd3|seedream|imagen|kandinsky|playground|hidream|qwen-image/i.test(
    model,
  );

/**
 * A model of the catalog, or a workspace endpoint's (`custom:` ids, priced by the workspace: free unless its admin
 * priced its tokens, which the gateway reads); undefined for anything else.
 */
export function imageModelInfo(model: string): ImageModelInfo | undefined {
  if (Object.hasOwn(IMAGE_CATALOG, model)) return IMAGE_CATALOG[model];
  const custom = CUSTOM_IMAGE_ID.exec(model);
  if (!custom?.[2]) return undefined;
  return {
    provider: "custom",
    label: custom[2],
    apiModel: custom[2],
    aspects: ALL_ASPECTS,
    sizes: ["1K"],
    maxCount: MAX_IMAGES_PER_REQUEST,
    perCall: MAX_IMAGES_PER_REQUEST,
    refs: true,
    price: { per: "free" },
    pricedAt: "2026-11-17",
  };
}

export const isImageModel = (model: string) => imageModelInfo(model) !== undefined;

/** The catalog's ids, in the order a workspace's default is picked. */
export const IMAGE_MODEL_IDS = Object.keys(IMAGE_CATALOG);

/** A picture to start from, base64. */
export interface ImageReference {
  mediaType: string;
  data: string;
}

export interface ImageRequest {
  /** An id of `IMAGE_CATALOG` or a workspace endpoint's `custom:` id (the gateway sends the provider's own). */
  model: string;
  prompt: string;
  count: number;
  aspect: ImageAspect;
  size?: ImageSize;
  references?: ImageReference[];
  signal?: AbortSignal;
}

/** Tokens a call used, where its provider says (OpenAI's GPT Image, Gemini): text in, pictures in, out. */
export interface ImageUsage {
  textInputTokens: number;
  imageInputTokens: number;
  outputTokens: number;
}

export interface MadeImage {
  mediaType: string;
  bytes: Uint8Array;
}

export interface ImageResult {
  /** The pictures made, in order: fewer than asked when `error` says why the rest weren't. */
  images: MadeImage[];
  /** The model that answered, when the provider says. */
  model?: string;
  usage?: ImageUsage;
  /** What the provider says the calls cost; absent: priced from the catalog. */
  costNanoUsd?: number;
  /** Some pictures were made, then a call failed: the rest weren't (what was made is still billed). */
  error?: ProviderError;
}

/** What each image call carries besides the request: the key and its account, a workspace's own endpoint. */
export interface ImageCallOptions {
  apiKey: string;
  workspaceId?: string;
  organization?: string;
  project?: string;
  endpoint?: Endpoint;
}

/** A provider refusing a prompt (its safety rules) says this: the canvas says it was refused, not that it failed. */
export const IMAGE_BLOCKED_WORDS = "the provider refused to make this image";

/** A refusal of the prompt itself, with the provider's words when it gave any. */
export const imageBlockedError = (said?: string) =>
  new ProviderError(
    `${IMAGE_BLOCKED_WORDS}${said ? `: ${said}` : ""}`,
    false,
    400,
    undefined,
    said ? said.replace(/\s+/g, " ").trim().slice(0, 300) : undefined,
  );

/** Whether a failure is the provider refusing the prompt (`imageBlockedError`), also once the gateway masked it. */
export const isImageBlocked = (error: unknown) =>
  error instanceof ProviderError && error.message.startsWith(IMAGE_BLOCKED_WORDS);

/** Width over height. */
export function aspectRatio(aspect: ImageAspect): number {
  const [w, h] = aspect.split(":").map(Number);
  return (w ?? 1) / (h ?? 1);
}

/** The model's aspect nearest to the one asked (its own when it takes it). */
export function nearestAspect(info: Pick<ImageModelInfo, "aspects">, aspect: ImageAspect): ImageAspect {
  if (info.aspects.includes(aspect)) return aspect;
  const want = Math.log(aspectRatio(aspect));
  let best = info.aspects[0] ?? "1:1";
  for (const a of info.aspects) {
    if (Math.abs(Math.log(aspectRatio(a)) - want) < Math.abs(Math.log(aspectRatio(best)) - want)) best = a;
  }
  return best;
}

/**
 * The pixels to ask for, as `WIDTHxHEIGHT`, both multiples of 16: at 1K a square is 1024 and the others 1536 on the
 * long side (GPT Image's own sizes), at 2K the long side is 2048. `fixedThree`: a model that takes only GPT Image's
 * three (1024×1024, 1536×1024, 1024×1536) gets the nearest.
 */
export function imagePixels(aspect: ImageAspect, size: ImageSize = "1K", fixedThree = false): string {
  if (fixedThree) {
    const r = aspectRatio(aspect);
    return r > 1.15 ? "1536x1024" : r < 0.87 ? "1024x1536" : "1024x1024";
  }
  const ratio = aspectRatio(aspect);
  const long = size === "2K" ? 2048 : ratio === 1 ? 1024 : 1536;
  const snap = (n: number) => Math.max(16, Math.round(n / 16) * 16);
  const w = ratio >= 1 ? long : snap(long * ratio);
  const h = ratio >= 1 ? snap(long / ratio) : long;
  return `${w}x${h}`;
}

/** The longest prompt counted for a reservation: about 2 characters a token, the safe side. */
const promptTokensAtMost = (prompt: string) => Math.ceil(prompt.length / 2) + 64;
/** What one reference picture may count for as input (a large one at high fidelity). */
const REFERENCE_TOKENS_AT_MOST = 6500;
/** Output tokens of a typical picture (1024×1024, medium), for prices shown before a call. */
const TYPICAL_OUTPUT_TOKENS = 1300;

/** Token prices of a workspace endpoint's model (nano-USD per token), when its admin set them. */
export interface EndpointTokenPrices {
  input: number;
  output: number;
}

/**
 * The most a request may cost, reserved against the budget before the call: every picture at its worst, the prompt
 * and the references at the most they count for. `endpoint`: a `custom:` model's admin prices.
 */
export function maxImageCostNanoUsd(
  model: string,
  request: Pick<ImageRequest, "count" | "size" | "prompt" | "references">,
  endpoint?: EndpointTokenPrices,
): number {
  const info = imageModelInfo(model);
  if (!info) throw new Error(`Image model ${model} is not in the catalog`);
  const count = Math.max(1, Math.floor(request.count));
  const refs = request.references?.length ?? 0;
  const prompt = promptTokensAtMost(request.prompt);
  const price = info.price;
  switch (price.per) {
    case "image":
      return count * perImage(price, request.size);
    case "token": {
      // One call per `perCall` pictures, each sending the prompt and the references again.
      const calls = Math.ceil(count / Math.max(1, info.perCall));
      const input = calls * (prompt * price.textInput + refs * REFERENCE_TOKENS_AT_MOST * price.imageInput);
      return input + count * price.worstOutputTokens * price.output;
    }
    case "reported":
      return count * price.worst;
    case "free":
      return endpoint
        ? prompt * endpoint.input + refs * REFERENCE_TOKENS_AT_MOST * endpoint.input + count * 8000 * endpoint.output
        : 0;
  }
}

/**
 * What a request cost, settled after the call: the provider's reported cost, else the catalog's price of the
 * pictures made (tokens when the provider reported them, else each picture at its worst so no call is free).
 */
export function imageCostNanoUsd(
  model: string,
  request: Pick<ImageRequest, "size">,
  result: Pick<ImageResult, "images" | "usage" | "costNanoUsd">,
  endpoint?: EndpointTokenPrices,
): number {
  const info = imageModelInfo(model);
  if (!info) throw new Error(`Image model ${model} is not in the catalog`);
  const made = result.images.length;
  const price = info.price;
  if (price.per !== "free" && typeof result.costNanoUsd === "number" && Number.isFinite(result.costNanoUsd)) {
    return Math.max(0, Math.round(result.costNanoUsd));
  }
  const u = result.usage;
  switch (price.per) {
    case "image":
      return made * perImage(price, request.size);
    case "token":
      return u
        ? u.textInputTokens * price.textInput + u.imageInputTokens * price.imageInput + u.outputTokens * price.output
        : made * price.worstOutputTokens * price.output;
    case "reported":
      return made * price.typical;
    case "free":
      return endpoint && u
        ? (u.textInputTokens + u.imageInputTokens) * endpoint.input + u.outputTokens * endpoint.output
        : 0;
  }
}

/** What a typical picture costs, in nano-USD, for the price people with usage rights see; null when nothing. */
export function typicalImageCostNanoUsd(model: string): number | null {
  const info = imageModelInfo(model);
  if (!info) return null;
  const price = info.price;
  switch (price.per) {
    case "image":
      return perImage(price, "1K");
    case "token":
      return 200 * price.textInput + TYPICAL_OUTPUT_TOKENS * price.output;
    case "reported":
      return price.typical;
    case "free":
      return null;
  }
}

function perImage(price: Extract<ImagePrice, { per: "image" }>, size: ImageSize = "1K"): number {
  // A size the table doesn't list costs what the dearest listed one does.
  return price.bySize[size] ?? Math.max(0, ...Object.values(price.bySize));
}

/** A picture's type from its first bytes (PNG, JPEG, WebP, GIF), or null. */
export function imageTypeOf(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return null;
}

/** The largest picture a provider's answer may carry (base64 decoded). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * A base64 picture of a provider's answer as bytes, its type read from the bytes (never trusted from the answer).
 * Throws a `ProviderError` for one that isn't a picture or is too large.
 */
export function decodeImage(data: string): MadeImage {
  const clean = data.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
  if (clean.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4)
    throw new ProviderError("the provider's picture is too large", false);
  const bytes = new Uint8Array(Buffer.from(clean, "base64"));
  const mediaType = imageTypeOf(bytes);
  if (!mediaType) throw new ProviderError("could not read the provider's picture", true);
  return { mediaType, bytes };
}

/** Bytes as base64 (a reference picture sent to a provider). */
export const bytesToBase64 = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
