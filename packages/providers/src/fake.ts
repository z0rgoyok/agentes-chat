export { createFakeEmbeddings } from "./embeddings";

import { deflateSync } from "node:zlib";
import {
  aspectRatio,
  type ImageAspect,
  type ImageCallOptions,
  type ImageRequest,
  type ImageResult,
  type ImageUsage,
  MAX_IMAGES_PER_REQUEST,
} from "./images";
import {
  type ContentBlock,
  type Endpoint,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  ProviderError,
  promptChars,
  type StopReason,
  systemText,
  textOf,
} from "./types";

export interface FakeReply {
  chunks: string[];
  /** Progress notes told apart from the text (`StreamOptions.onNote`), before it. */
  notes?: string[];
  /** Tool calls appended after the text (stop reason becomes `tool_use` unless set). */
  toolUses?: { id?: string; name: string; input: Record<string, unknown> }[];
  /** Extra provider blocks to return (e.g. a fake thinking block), placed first. */
  opaque?: Record<string, unknown>[];
  usage?: Partial<ModelUsage>;
  stopReason?: StopReason;
  /** Report a different answering model (simulates a server-side fallback). */
  model?: string;
  /** Thinking the call went without (`ModelResult.thinking`). */
  thinking?: ModelResult["thinking"];
  /** What the provider says the call cost (OpenRouter's reported cost). */
  costNanoUsd?: number;
  /** The connection left tool results' pictures out (`ModelResult.imagesLeftOut`). */
  imagesLeftOut?: true;
  /**
   * Fail after streaming `chunks`. `inputTokens` simulates the start-of-stream
   * usage event (null = the stream died before it).
   */
  failMidStream?: { error?: string; retryable?: boolean; inputTokens: number | null };
  /**
   * Waits for this after the first chunk (the test cancels meanwhile). If the
   * request's signal is aborted then, the stream ends like a real abort:
   * `request aborted`, with the usage so far.
   */
  hold?: Promise<unknown>;
}

export interface FakeCall {
  request: ModelRequest;
  apiKey: string;
  workspaceId?: string;
  endpoint?: Endpoint;
  session?: string;
}

/** A scripted answer to an image call (`createFakeProvider`'s `image`). */
export interface FakeImageReply {
  /** Pictures made (default: as many as asked); fewer than asked with `error` is a call that failed midway. */
  count?: number;
  usage?: ImageUsage;
  /** What the provider says the call cost. */
  costNanoUsd?: number;
  model?: string;
  /** The rest failed with this, after `count` pictures. */
  error?: ProviderError;
  /** Waits for this before answering (a test looks at the request in flight meanwhile). */
  hold?: Promise<unknown>;
}

export interface FakeImageCall {
  request: Omit<ImageRequest, "signal">;
  apiKey: string;
  endpoint?: Endpoint;
}

/**
 * In-memory provider for tests: no network. By default answers
 * "Echo: <last user message>" in three chunks. Pass `reply` to script answers
 * or throw errors. Records every call (including the decrypted key, so tests
 * can assert the gateway used the right credential).
 */
export function createFakeProvider(
  reply?: (request: ModelRequest, call: number) => FakeReply | Error,
  options: {
    /** Scripted image answers (ADR 0197); default: every picture asked for, drawn by `fakeImagePng`. */
    image?: (request: ImageRequest, call: number) => FakeImageReply | Error;
  } = {},
) {
  const calls: FakeCall[] = [];
  const countCalls: ModelRequest[] = [];
  const imageCalls: FakeImageCall[] = [];
  let toolSeq = 0;
  const provider: ModelProvider & {
    calls: FakeCall[];
    countCalls: ModelRequest[];
    imageCalls: FakeImageCall[];
    generateImage(request: ImageRequest, options: ImageCallOptions): Promise<ImageResult>;
  } = {
    id: "anthropic",
    calls,
    countCalls,
    imageCalls,
    async stream(request, { apiKey, workspaceId, endpoint, session, onDelta, onNote }): Promise<ModelResult> {
      calls.push({
        request: structuredClone({ ...request, signal: undefined }),
        apiKey,
        workspaceId,
        ...(endpoint ? { endpoint } : {}),
        ...(session ? { session } : {}),
      });
      const scripted = reply?.(request, calls.length);
      if (scripted instanceof Error) throw scripted;
      const lastMessage = request.messages.at(-1);
      const last = lastMessage ? textOf(lastMessage.content) : "";
      const r = scripted ?? { chunks: ["Echo: ", last.slice(0, 40), "."] };
      for (const note of r.notes ?? []) onNote?.(note);
      let streamed = 0;
      for (const [i, chunk] of r.chunks.entries()) {
        await Promise.resolve();
        if (request.signal?.aborted) break;
        onDelta(chunk);
        streamed += chunk.length;
        if (i === 0 && r.hold) await r.hold;
      }
      if (request.signal?.aborted) {
        throw new ProviderError("request aborted", false, undefined, {
          inputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: null,
          outputChars: streamed,
        });
      }
      const text = r.chunks.join("");
      if (r.failMidStream) {
        throw new ProviderError(r.failMidStream.error ?? "stream broke", r.failMidStream.retryable ?? true, 500, {
          inputTokens: r.failMidStream.inputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: null,
          outputChars: text.length,
        });
      }
      const content: ContentBlock[] = [
        ...(r.opaque ?? []).map((data) => ({ type: "opaque" as const, provider: "anthropic", data })),
        ...(text ? [{ type: "text" as const, text }] : []),
        ...(r.toolUses ?? []).map((t) => ({
          type: "tool_use" as const,
          id: t.id ?? `toolu_fake_${++toolSeq}`,
          name: t.name,
          input: t.input,
        })),
      ];
      return {
        text,
        content,
        model: r.model ?? request.model,
        stopReason: r.stopReason ?? (r.toolUses?.length ? "tool_use" : "end_turn"),
        usage: {
          inputTokens: r.usage?.inputTokens ?? Math.ceil((systemText(request.system).length + last.length) / 4),
          outputTokens: r.usage?.outputTokens ?? Math.ceil(text.length / 4),
          cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: r.usage?.cacheWriteTokens ?? 0,
        },
        ...(r.costNanoUsd !== undefined ? { costNanoUsd: r.costNanoUsd } : {}),
        ...(r.thinking ? { thinking: r.thinking } : {}),
        ...(r.imagesLeftOut ? { imagesLeftOut: r.imagesLeftOut } : {}),
      };
    },
    async countTokens(request) {
      countCalls.push(request);
      return Math.ceil(promptChars(request) / 4);
    },
    async generateImage(request, { apiKey, endpoint }): Promise<ImageResult> {
      const { signal, ...rest } = request;
      imageCalls.push({ request: structuredClone(rest), apiKey, ...(endpoint ? { endpoint } : {}) });
      const scripted = options.image?.(request, imageCalls.length);
      if (scripted instanceof Error) throw scripted;
      if (scripted?.hold) await scripted.hold;
      if (signal?.aborted) throw new ProviderError("request aborted", false);
      const asked = Math.max(1, Math.min(MAX_IMAGES_PER_REQUEST, Math.floor(request.count)));
      const count = Math.max(0, Math.min(asked, scripted?.count ?? asked));
      const images = Array.from({ length: count }, (_, i) => ({
        mediaType: "image/png",
        bytes: fakeImagePng(request.prompt, request.aspect, i),
      }));
      return {
        images,
        ...(scripted?.model ? { model: scripted.model } : {}),
        ...(scripted?.usage ? { usage: scripted.usage } : {}),
        ...(scripted?.costNanoUsd !== undefined ? { costNanoUsd: scripted.costNanoUsd } : {}),
        ...(scripted?.error ? { error: scripted.error } : {}),
      };
    },
  };
  return provider;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: its length, type, data and CRC. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** FNV-1a of a text, unsigned. */
function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** HSL (degrees, 0..1, 0..1) as RGB bytes. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * t));

/**
 * The fake's picture (ADR 0197 tests): a small valid PNG in the aspect asked, the same for the same prompt and index,
 * a landscape whose colors come from the prompt (a sky in a gradient, a sun, two hills), so a canvas in a test or a
 * local run without keys shows something pleasant and each prompt looks its own.
 */
export function fakeImagePng(prompt: string, aspect: ImageAspect = "1:1", index = 0): Uint8Array {
  const ratio = aspectRatio(aspect);
  const long = 96;
  const w = ratio >= 1 ? long : Math.max(1, Math.round(long * ratio));
  const h = ratio >= 1 ? Math.max(1, Math.round(long / ratio)) : long;
  const seed = hashOf(`${prompt}#${index}`);
  const hue = seed % 360;
  const hue2 = (hue + 30 + ((seed >>> 9) % 90)) % 360;
  const top = hsl(hue, 0.65, 0.82);
  const bottom = hsl(hue2, 0.55, 0.6);
  const sun = hsl((hue + 180) % 360, 0.85, 0.72);
  const far = hsl(hue2, 0.35, 0.45);
  const near = hsl((hue2 + 20) % 360, 0.45, 0.3);
  const sunX = w * (0.25 + ((seed >>> 3) % 50) / 100);
  const sunY = h * (0.22 + ((seed >>> 5) % 20) / 100);
  const sunR = Math.min(w, h) * 0.14;
  const phase = ((seed >>> 13) % 628) / 100;
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      let px = mix(top, bottom, y / Math.max(1, h - 1));
      const d = Math.hypot(x - sunX, y - sunY);
      if (d < sunR + 1) px = mix(px, sun, Math.max(0, Math.min(1, sunR + 1 - d)));
      const farLine = h * (0.62 + 0.07 * Math.sin((x / w) * Math.PI * 2 + phase));
      if (y >= farLine) px = far;
      const nearLine = h * (0.78 + 0.06 * Math.sin((x / w) * Math.PI * 3 + phase * 1.7));
      if (y >= nearLine) px = mix(near, bottom, (y - nearLine) / Math.max(1, h - nearLine) / 3);
      raw.set(px, row + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export type FakeProvider = ReturnType<typeof createFakeProvider>;
