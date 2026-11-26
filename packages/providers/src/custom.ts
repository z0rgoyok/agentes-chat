import { createHash } from "node:crypto";
import OpenAI from "openai";
import { createAnthropicProvider } from "./anthropic";
import { parseCustomModel } from "./catalog";
import { openAIImages } from "./openai";
import { createOpenRouterProvider } from "./openrouter";
import {
  type Endpoint,
  hasToolImages,
  type ModelProvider,
  type ModelResult,
  PDF_MEDIA_TYPE,
  ProviderError,
} from "./types";

/** The APIs a workspace's own endpoint may speak (a gateway, Ollama, vLLM, LM Studio, LiteLLM…). */
export type EndpointStyle = Endpoint["style"];
export const ENDPOINT_STYLES = ["openai", "anthropic"] as const satisfies readonly EndpointStyle[];

const LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 2_000_000;
const MAX_LISTED = 500;
const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
const CATALOG_TTL_MS = 5 * 60_000;
const MAX_CATALOGS = 256;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

interface ListedModel {
  id: string;
  label?: string;
  imageInput?: true;
  prices?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

function listedPrices(row: Raw): ListedModel["prices"] {
  const p = obj(row.pricing);
  if (row.pricing_unit !== "USD_per_million_tokens" || !p) return;
  const rate = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 10_000;
  if (!rate(p.input) || !rate(p.output)) return;
  if (p.cached_input !== undefined && !rate(p.cached_input)) return;
  if (p.cache_write !== undefined && !rate(p.cache_write)) return;
  return {
    input: p.input,
    output: p.output,
    ...(rate(p.cached_input) ? { cacheRead: p.cached_input } : {}),
    ...(rate(p.cache_write) ? { cacheWrite: p.cache_write } : {}),
  };
}

/**
 * The model ids an endpoint lists: `{ data: [{ id }] }` (OpenAI's and Anthropic's `GET /v1/models`, LiteLLM, vLLM,
 * LM Studio, Ollama's `/v1`), or Ollama's own `{ models: [{ model | name }] }`. Outside data: ids that don't look
 * like one are dropped, repeats too, at most 500.
 */
export function parseEndpointModels(body: unknown): ListedModel[] {
  const root = obj(body);
  const rows = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const seen = new Set<string>();
  const out: ListedModel[] = [];
  for (const row of rows) {
    const r = obj(row);
    const id = r && [r.id, r.model, r.name].find((v): v is string => typeof v === "string");
    if (!id || !MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = r.display_name;
    const modalities = r.input_modalities ?? obj(r.architecture)?.input_modalities;
    const prices = listedPrices(r);
    out.push({
      id,
      ...(prices ? { prices } : {}),
      ...(typeof name === "string" && name.trim() && name.length <= 120 ? { label: name.trim() } : {}),
      ...(Array.isArray(modalities) && modalities.includes("image") ? { imageInput: true } : {}),
    });
    if (out.length >= MAX_LISTED) break;
  }
  return out;
}

/** A response's body as JSON, read up to `max` bytes: a longer one fails. */
async function cappedJson(res: Response, max: number): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ProviderError("the model list is too large", false);
    }
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

/**
 * An endpoint's model list, with the key: `GET {baseURL}/models` for Chat Completions, `GET {baseURL}/v1/models` for
 * Anthropic Messages. Ten seconds and 2 MB at most. A refusal or an unreadable answer throws a `ProviderError` whose
 * message the admin reads.
 */
export async function listEndpointModels(
  endpoint: Endpoint,
  apiKey: string,
  http: typeof fetch,
): Promise<ListedModel[]> {
  const url = endpoint.style === "anthropic" ? `${endpoint.baseURL}/v1/models` : `${endpoint.baseURL}/models`;
  const headers: Record<string, string> =
    endpoint.style === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" }
      : { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  let res: Response;
  try {
    res = await http(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch (error) {
    throw new ProviderError(`could not reach provider: ${(error as Error).message}`, true);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError(`the provider answered ${res.status}`, false, res.status);
  }
  let body: unknown;
  try {
    body = await cappedJson(res, LIST_MAX_BYTES);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("could not read the model list", false);
  }
  return parseEndpointModels(body);
}

/** A reply's ceilings: a server people pointed us at (stuck, or hostile) can't fill this process's memory or hold a worker. */
export const ENDPOINT_REPLY_MAX_BYTES = 32_000_000;
export const ENDPOINT_CALL_TIMEOUT_MS = 20 * 60_000;

/** `http` with each exchange bounded: done within `timeoutMs` (the body streamed included), its body within `maxBytes`. */
export function boundedFetch(
  http: typeof fetch = fetch,
  limits = { maxBytes: ENDPOINT_REPLY_MAX_BYTES, timeoutMs: ENDPOINT_CALL_TIMEOUT_MS },
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const res = await http(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    if (!res.body) return res;
    let total = 0;
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > limits.maxBytes) controller.error(new ProviderError("the endpoint's reply is too large", false));
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

/** `http` with `headers` set on every request, over what the SDK set itself (its own User-Agent). */
export const withHeaders = (http: typeof fetch, headers: Record<string, string>): typeof fetch =>
  ((input: string | URL | Request, init: RequestInit = {}) => {
    const merged = new Headers(init.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return http(input, { ...init, headers: merged });
  }) as typeof fetch;

/**
 * What OpenCode's gateway asks of a client that isn't OpenCode itself (opencode.ai/v2/docs/console/go, "Where can I
 * use it", read 2026-11-07): its own User-Agent, never an SDK's, and a stable session id per conversation in
 * `x-opencode-session`. Its Go plan refuses a call without them ("400 Request is missing x-opencode-session"). Null
 * for any other endpoint.
 */
export function endpointHeaders(baseURL: string, session: string, version = "dev"): Record<string, string> | null {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return null;
  }
  return host === "opencode.ai" || host.endsWith(".opencode.ai")
    ? { "user-agent": `agentes.chat/${version}`, "x-opencode-session": session }
    : null;
}

/**
 * Claude reads images wherever it is served (Amazon Bedrock's runtime and Mantle, a gateway): its ids all name it
 * (`global.anthropic.claude-sonnet-5-5`). Another company's model on an Anthropic-compatible endpoint isn't trusted to.
 */
const readsImages = (model: string) => /claude/i.test(model);

/** A receipt lookup may be retried safely, even if the model call cannot. */
function meteredHttp(http: typeof fetch, endpoint: Endpoint, apiKey: string) {
  let token: string | null = null;
  const capture: typeof fetch = (async (input, init) => {
    const response = await http(input, init);
    if (init?.method?.toUpperCase() === "POST" && response.ok) {
      token = response.headers.get("x-respan-usage-receipt");
    }
    return response;
  }) as typeof fetch;
  return {
    http: endpoint.respanReceipts ? capture : http,
    async cost(): Promise<{ costNanoUsd: number; pricingReceipt: Raw } | undefined> {
      if (!endpoint.respanReceipts || !token || !/^r_\d+~[0-9:.TZ-]{20,32}$/.test(token)) return;
      const url = endpoint.baseURL.replace(/\/$/, "") + "/usage/receipts/" + encodeURIComponent(token);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await http(url, {
            signal: AbortSignal.timeout(2000),
            redirect: "error",
            headers: { authorization: "Bearer " + apiKey },
          });
          if (response.status === 200) {
            const receipt = obj(await cappedJson(response, 32_768));
            const n = receipt?.cost_nano_usd;
            return receipt?.receipt === token && typeof n === "number" && Number.isSafeInteger(n) && n >= 0
              ? {
                  costNanoUsd: n,
                  pricingReceipt: {
                    receipt: token,
                    rateCards: receipt.rate_cards,
                    provider: receipt.provider,
                    model: receipt.model,
                  },
                }
              : undefined;
          }
          await response.body?.cancel();
          if (response.status !== 202) return;
        } catch {
          /* Only retry the metering read. */
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

/**
 * The adapter for every workspace endpoint, registered once as `custom`: each call names its endpoint
 * (`StreamOptions.endpoint`) and goes through the catalog's own adapters with that address, Anthropic's in its
 * compatible mode or the Chat Completions one OpenRouter uses. The endpoint's model id is sent, the full
 * `custom:` id comes back (so a catalog id it may share is never priced at the catalog's prices), and a cost the
 * server reports is ignored: the admin's prices count. `version`: this server's, in the User-Agent an endpoint that
 * asks for one gets (`endpointHeaders`).
 */
export function createCustomProvider(
  options: { fetch?: typeof fetch; maxRetries?: number; version?: string } = {},
): ModelProvider {
  const bounded = boundedFetch(options.fetch);
  const catalogs = new Map<string, { expires: number; models: Promise<ListedModel[]> }>();
  function imageCatalog(credentialId: string, endpoint: Endpoint, apiKey: string, http: typeof fetch) {
    // Rotating a credential keeps its ID but may change the models this key sees.
    const keyDigest = createHash("sha256").update(apiKey).digest("hex");
    const scope = `${credentialId}|${endpoint.baseURL}|${keyDigest}`;
    const cached = catalogs.get(scope);
    if (cached && cached.expires > Date.now()) return cached.models;
    catalogs.delete(scope);
    if (catalogs.size >= MAX_CATALOGS) {
      const oldest = catalogs.keys().next().value;
      if (oldest !== undefined) catalogs.delete(oldest);
    }
    const models = listEndpointModels(endpoint, apiKey, http).catch(() => []);
    catalogs.set(scope, { expires: Date.now() + CATALOG_TTL_MS, models });
    return models;
  }
  return {
    id: "custom",
    async stream(request, streamOptions): Promise<ModelResult> {
      const { endpoint } = streamOptions;
      const parsed = parseCustomModel(request.model);
      if (!endpoint || !parsed) throw new ProviderError("this model has no endpoint", false);
      const extra = endpointHeaders(endpoint.baseURL, streamOptions.session ?? crypto.randomUUID(), options.version);
      const meter = meteredHttp(extra ? withHeaders(bounded, extra) : bounded, endpoint, streamOptions.apiKey);
      const http = meter.http;
      const inner =
        endpoint.style === "anthropic"
          ? createAnthropicProvider({
              id: "custom",
              baseURL: endpoint.baseURL,
              compat: { toolChoiceAny: false, images: readsImages(parsed.model) },
              fetch: http,
              maxRetries: options.maxRetries,
            })
          : createOpenRouterProvider({
              compatible: {
                id: "custom",
                baseURL: endpoint.baseURL,
                pictures:
                  endpoint.modelInputs?.find((model) => model.id === parsed.model)?.imageInput ??
                  (hasToolImages(request.messages, (image) => image.mediaType !== PDF_MEDIA_TYPE) &&
                    !request.signal?.aborted &&
                    (await imageCatalog(parsed.credentialId, endpoint, streamOptions.apiKey, http)).some(
                      (model) => model.id === parsed.model && model.imageInput,
                    )),
              },
              fetch: http,
              maxRetries: options.maxRetries,
            });
      const { costNanoUsd: _reported, ...result } = await inner.stream(
        { ...request, model: parsed.model },
        streamOptions,
      );
      const cost = await meter.cost();
      return { ...result, model: request.model, ...cost };
    },
    /**
     * Pictures from an endpoint that speaks OpenAI's Images API (`/images/generations`, `/images/edits`, ADR 0197):
     * through the same bounded fetch, a picture it answers with as an address read through it too. The workspace
     * prices them (`imageCostNanoUsd`): a cost the server reports is ignored.
     */
    async generateImage(request, { apiKey, endpoint }) {
      if (endpoint?.style !== "openai") throw new ProviderError("this endpoint makes no pictures", false);
      const model = parseCustomModel(request.model)?.model ?? request.model;
      const meter = meteredHttp(bounded, endpoint, apiKey);
      const client = new OpenAI({
        apiKey,
        baseURL: endpoint.baseURL,
        fetch: meter.http,
        maxRetries: options.maxRetries ?? 2,
      });
      const fetchUrl = async (url: string) => {
        let res: Response;
        try {
          if (!/^https?:\/\//i.test(url)) throw new Error("not a web address");
          res = await bounded(url, { signal: request.signal });
        } catch {
          throw new ProviderError("could not read the endpoint's picture", true);
        }
        if (!res.ok) throw new ProviderError(`the endpoint answered ${res.status} for its picture`, true, res.status);
        return new Uint8Array(await res.arrayBuffer());
      };
      const { costNanoUsd: _reported, ...result } = await openAIImages(
        client,
        { ...request, model },
        { compatible: true, fetchUrl },
      );
      const cost = await meter.cost();
      return { ...result, ...cost };
    },
  };
}
