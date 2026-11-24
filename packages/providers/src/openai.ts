import OpenAI, { toFile } from "openai";
import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { effortWithin, MODEL_CATALOG } from "./catalog";
import {
  decodeImage,
  type ImageRequest,
  type ImageResult,
  type ImageUsage,
  imageBlockedError,
  imagePixels,
  imageTypeOf,
  MAX_IMAGES_PER_REQUEST,
  type MadeImage,
} from "./images";
import {
  type ContentBlock,
  deniedError,
  laidOut,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type PartialUsage,
  PDF_MEDIA_TYPE,
  ProviderError,
  type StopReason,
  shortSaid,
  stableToolsFirst,
  systemText,
} from "./types";

/**
 * OpenAI over the Responses API, streaming. A client per call with the
 * org's key (and optional organization/project headers).
 *
 * - System prompt → `instructions`; messages and tool round trips → input
 *   items (`function_call` / `function_call_output`), mapped from the neutral
 *   `tool_use` / `tool_result` blocks.
 * - Stateless (`store: false`) with `reasoning.encrypted_content` included:
 *   reasoning items come back as `opaque` blocks and are replayed unchanged
 *   in tool loops. Blocks from other providers are dropped.
 * - `outputSchema` → `text.format` JSON Schema (strict); `effort` →
 *   `reasoning.effort` on reasoning models (`none` only on one that can
 *   turn reasoning off, `low` on the others).
 * - Usage: `input_tokens` includes cached and cache-write tokens; we split
 *   them so each is priced at its own rate.
 * - Mid-stream failures carry what was received (`ProviderError.partial`).
 */
export function createOpenAIProvider(
  options: { baseURL?: string; maxRetries?: number /** Tests only: scripted transport. */; fetch?: typeof fetch } = {},
): ModelProvider {
  const client = (apiKey: string, organization?: string, project?: string) =>
    new OpenAI({
      apiKey,
      baseURL: options.baseURL,
      maxRetries: options.maxRetries ?? 2,
      fetch: options.fetch,
      organization: organization ?? null,
      project: project ?? null,
    });

  return {
    id: "openai",
    async stream(input, { apiKey, organization, project, onDelta }): Promise<ModelResult> {
      const request = laidOut(input);
      const partial: PartialUsage = {
        inputTokens: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: null,
        outputChars: 0,
      };
      const info = MODEL_CATALOG[request.model];
      const effort = request.effort === "none" && info?.leastThinking !== "off" ? "low" : effortWithin(request.effort);
      try {
        const stream = client(apiKey, organization, project).responses.stream(
          {
            model: request.model,
            instructions: systemText(request.system),
            input: toInput(request.messages),
            max_output_tokens: request.maxTokens,
            store: false,
            include: ["reasoning.encrypted_content"],
            ...(request.tools && request.tools.length > 0 ? { tools: toTools(request) } : {}),
            ...(request.outputSchema
              ? {
                  text: {
                    format: {
                      type: "json_schema" as const,
                      name: "output",
                      schema: request.outputSchema,
                      strict: true,
                    },
                  },
                }
              : {}),
            ...(info?.reasoning && effort ? { reasoning: { effort } } : {}),
          },
          { signal: request.signal },
        );
        stream.on("event", (event: ResponseStreamEvent) => {
          if (event.type === "response.output_text.delta") {
            partial.outputChars += event.delta.length;
            onDelta(event.delta);
          } else if (event.type === "response.function_call_arguments.delta") {
            partial.outputChars += event.delta.length;
          }
        });
        const response = await stream.finalResponse();
        // A failed response ends its stream cleanly: read as a reply, it would be an empty one that "worked".
        if (response.status === "failed") {
          throw new OpenAI.APIError(undefined, response.error ?? undefined, response.error?.message, undefined);
        }
        return fromResponse(response as unknown as Response);
      } catch (error) {
        const mapped = openAIError(error);
        if (partial.outputChars > 0) mapped.partial = partial;
        throw mapped;
      }
    },
    generateImage: (request, { apiKey, organization, project }) =>
      openAIImages(client(apiKey, organization, project), request),
  };
}

/** A picture GPT Image refused to make: its moderation, in the API's codes or words. */
const IMAGE_REFUSED =
  /moderation_blocked|content_policy_violation|safety system|content policy|image_generation_user_error/i;

/** A failure of the Images API in every adapter's words, a refused prompt as `imageBlockedError`. */
function imageError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.APIError && error.status === 400) {
    const said = saidIn(error);
    if (IMAGE_REFUSED.test(`${error.code ?? ""} ${said ?? ""}`)) return imageBlockedError(said);
  }
  return openAIError(error);
}

/** GPT Image's first models take only their three sizes; the newer ones any `WIDTHxHEIGHT` in steps of 16. */
const takesThreeSizes = (model: string) => /^gpt-image-1/.test(model) || /^dall-e/.test(model);

/**
 * Pictures over OpenAI's Images API, also any server that speaks it (ADR 0197, a workspace's endpoint, ADR 0146):
 * `images.generate`, or `images.edit` with the references as the pictures to start from; `n` pictures a call, called
 * again for the rest when a server makes fewer. GPT Image answers in base64 with token usage, asked here for medium
 * quality WebP; another server (`compatible`) is asked for base64 (`response_format`) and sent one reference, the most
 * every server takes, and a picture it answers with as an address is read with `fetchUrl`. A refused prompt is
 * `imageBlockedError`; a failure after some pictures came returns those, with the failure in `error`.
 */
export async function openAIImages(
  client: OpenAI,
  request: ImageRequest,
  options: { compatible?: boolean; fetchUrl?: (url: string) => Promise<Uint8Array> } = {},
): Promise<ImageResult> {
  const count = Math.max(1, Math.min(MAX_IMAGES_PER_REQUEST, Math.floor(request.count)));
  const size = imagePixels(request.aspect, request.size ?? "1K", takesThreeSizes(request.model));
  const refs = options.compatible ? (request.references ?? []).slice(0, 1) : (request.references ?? []);
  const made: MadeImage[] = [];
  const usage: ImageUsage = { textInputTokens: 0, imageInputTokens: 0, outputTokens: 0 };
  let reported = false;
  for (let call = 0; call < count && made.length < count; call++) {
    const n = count - made.length;
    const common = {
      model: request.model,
      prompt: request.prompt,
      n,
      size,
      ...(options.compatible
        ? { response_format: "b64_json" as const }
        : { quality: "medium" as const, output_format: "webp" as const, output_compression: 90 }),
    };
    try {
      const response =
        refs.length > 0
          ? await client.images.edit(
              {
                ...common,
                image: await Promise.all(
                  refs.map((r, i) =>
                    toFile(Buffer.from(r.data, "base64"), `reference-${i + 1}.${extensionOf(r.mediaType)}`, {
                      type: r.mediaType,
                    }),
                  ),
                ),
              },
              { signal: request.signal },
            )
          : await client.images.generate(common, { signal: request.signal });
      const u = response.usage;
      if (u) {
        reported = true;
        const image = u.input_tokens_details?.image_tokens ?? 0;
        usage.imageInputTokens += image;
        usage.textInputTokens += u.input_tokens_details?.text_tokens ?? Math.max(0, u.input_tokens - image);
        usage.outputTokens += u.output_tokens;
      }
      const before = made.length;
      for (const item of response.data ?? []) {
        if (made.length >= count) break;
        if (typeof item.b64_json === "string" && item.b64_json) made.push(decodeImage(item.b64_json));
        else if (typeof item.url === "string" && item.url && options.fetchUrl) {
          const bytes = await options.fetchUrl(item.url);
          const mediaType = imageTypeOf(bytes);
          if (!mediaType) throw new ProviderError("could not read the provider's picture", true);
          made.push({ mediaType, bytes });
        }
      }
      if (made.length === before) throw new ProviderError("the provider sent no picture", true);
    } catch (error) {
      const failure = request.signal?.aborted ? new ProviderError("request aborted", false) : imageError(error);
      if (made.length === 0) throw failure;
      return { images: made, ...(reported ? { usage } : {}), error: failure };
    }
  }
  return { images: made, ...(reported ? { usage } : {}) };
}

const extensionOf = (mediaType: string) =>
  mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : mediaType === "image/gif" ? "gif" : "png";

function toTools(request: ModelRequest): FunctionTool[] {
  return stableToolsFirst(request.tools ?? []).map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
}

function toInput(messages: ModelMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      items.push({ role: m.role, content: m.content });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") items.push({ role: m.role, content: b.text });
      else if (b.type === "tool_use")
        items.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      else if (b.type === "tool_result")
        items.push({
          type: "function_call_output",
          call_id: b.toolUseId,
          output: b.images?.length
            ? [
                { type: "input_text", text: b.isError ? `ERROR: ${b.content}` : b.content },
                ...b.images.map((i) =>
                  i.mediaType === PDF_MEDIA_TYPE
                    ? {
                        type: "input_file" as const,
                        filename: i.name ?? "file.pdf",
                        file_data: `data:${PDF_MEDIA_TYPE};base64,${i.data}`,
                      }
                    : {
                        type: "input_image" as const,
                        image_url: `data:${i.mediaType};base64,${i.data}`,
                        detail: "auto" as const,
                      },
                ),
              ]
            : b.isError
              ? `ERROR: ${b.content}`
              : b.content,
        });
      else if (b.type === "opaque" && b.provider === "openai") items.push(b.data as unknown as ResponseInputItem);
      // Opaque blocks of another provider (e.g. Anthropic thinking) can't be replayed here.
    }
  }
  return items;
}

function fromResponse(response: Response): ModelResult {
  const content: ContentBlock[] = [];
  let refused = false;
  for (const item of response.output as ResponseOutputItem[]) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") content.push({ type: "text", text: part.text });
        else if (part.type === "refusal") refused = true;
      }
    } else if (item.type === "function_call") {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(item.arguments || "{}") as Record<string, unknown>;
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    } else if (item.type === "reasoning") {
      content.push({ type: "opaque", provider: "openai", data: item as unknown as Record<string, unknown> });
    }
  }
  const usage = response.usage;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const written = (usage?.input_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens ?? 0;
  const stopReason: StopReason = refused
    ? "refusal"
    : content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
        ? "max_tokens"
        : response.status === "completed"
          ? "end_turn"
          : "other";
  return {
    text: content.map((b) => (b.type === "text" ? b.text : "")).join(""),
    content,
    model: response.model,
    stopReason,
    usage: {
      inputTokens: Math.max(0, (usage?.input_tokens ?? 0) - cached - written),
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: written,
    },
  };
}

/**
 * What an upstream's raw error says: its text, or the message of its JSON body. Nothing else of a body or a page is
 * shown: a validation error can carry the request back, system prompt included.
 */
function upstreamWords(raw: unknown) {
  if (typeof raw !== "string") return "";
  if (!/^\s*[{[<]/.test(raw)) return raw;
  try {
    const body = JSON.parse(raw) as { message?: unknown; error?: { message?: unknown } } | null;
    const message = body?.error?.message ?? body?.message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

/**
 * What an error body says. OpenRouter's own message is often only "Provider returned error": the upstream's words are
 * in `metadata.raw`.
 */
export function saidIn(error: InstanceType<typeof OpenAI.APIError>) {
  const body = error.error as { message?: unknown; metadata?: { raw?: unknown } } | undefined;
  const upstream = upstreamWords(body?.metadata?.raw);
  return shortSaid(upstream || (typeof body?.message === "string" ? body.message : "")) || undefined;
}

/**
 * An OpenAI SDK failure in the words every adapter uses (also OpenRouter's, which speaks through this SDK). A failure
 * inside a stream arrives as a plain `APIError` with no status, only its body's `code`, so the code decides first. No
 * credit is a 429 on OpenAI: it never passes by waiting.
 */
export function openAIError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.APIError) {
    if (error.code === "insufficient_quota") {
      const said = saidIn(error);
      const why = `no prepaid credit left at the provider (429 insufficient_quota)${said ? `: ${said}` : ""}`;
      return new ProviderError(why, false, error.status ?? 429, undefined, said);
    }
    if (error.status === undefined) {
      if (error.code === "rate_limit_exceeded") return new ProviderError("rate limited by provider", true, 429);
      if (error.code === "invalid_api_key") return new ProviderError("invalid provider API key", false, 401);
      if (error.code === "server_error") return new ProviderError("provider error", true);
    }
  }
  if (error instanceof OpenAI.RateLimitError) return new ProviderError("rate limited by provider", true, 429);
  if (error instanceof OpenAI.AuthenticationError) return new ProviderError("invalid provider API key", false, 401);
  if (error instanceof OpenAI.PermissionDeniedError) return deniedError(error.code, saidIn(error));
  if (error instanceof OpenAI.InternalServerError) return new ProviderError("provider error", true, error.status);
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError("provider timed out", true);
  if (error instanceof OpenAI.APIConnectionError) return new ProviderError("could not reach provider", true);
  if (error instanceof OpenAI.APIUserAbortError) return new ProviderError("request aborted", false);
  if (error instanceof OpenAI.APIError) {
    const what = [error.status ?? "?", error.code].filter(Boolean).join(" ");
    const said = saidIn(error);
    return new ProviderError(
      `provider rejected the request (${what})${said ? `: ${said}` : ""}`,
      false,
      error.status,
      undefined,
      said,
    );
  }
  if (error instanceof OpenAI.OpenAIError || error instanceof SyntaxError) {
    return new ProviderError(`could not read the model's reply: ${error.message}`, true);
  }
  return new ProviderError(error instanceof Error ? error.message : String(error), false);
}
