import { describe, expect, test } from "bun:test";
import { createAnthropicProvider, createModelProviders, type ModelRequest, PROVIDERS } from "../src";
import { scripted, sse } from "./scripted";

type Compat = "deepseek" | "moonshot" | "zai" | "minimax";

/** The catalog's adapter for a compatible provider, on a scripted transport. */
function compat(id: Compat, body: string) {
  const { fetcher, requests } = scripted(body);
  const { baseURL, compat } = PROVIDERS[id];
  return { requests, provider: createAnthropicProvider({ id, baseURL, compat, fetch: fetcher, maxRetries: 0 }) };
}

const start = (model: string, usage: Record<string, number> = { input_tokens: 40, output_tokens: 1 }) => ({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage },
});
const end = (stop: string, usage: Record<string, number>) => [
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage },
  { type: "message_stop" },
];
const text = (index: number, value: string) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index },
];
const thinking = (index: number, signature: string) => [
  { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "Hmm." } },
  { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
  { type: "content_block_stop", index },
];
const toolUse = (index: number, name: string, json: string) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } },
  { type: "content_block_stop", index },
];

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "deepseek-flash",
  system: [{ text: "org", cache: true }, { text: "where" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1000,
  ...over,
});
const quiet = { apiKey: "k", onDelta: () => {} };

describe("Anthropic-compatible providers (scripted transport)", () => {
  test("DeepSeek: its base URL and key; the system breakpoints stay; nothing only Anthropic takes; medium effort goes as high", async () => {
    const { provider, requests } = compat(
      "deepseek",
      sse([start("deepseek-flash"), ...text(0, "oi"), ...end("end_turn", { output_tokens: 3 })]),
    );
    // A model flagged for Anthropic's server-side fallback still gets none here.
    await provider.stream(
      request({
        model: "claude-sonnet-5-5",
        tools: [{ name: "search", description: "s", inputSchema: { type: "object" } }],
        effort: "medium",
      }),
      { apiKey: "sk-ds", onDelta: () => {} },
    );
    const sent = requests[0];
    expect(sent?.url.startsWith("https://api.deepseek.com/anthropic/v1/messages")).toBe(true);
    expect(sent?.headers.get("x-api-key")).toBe("sk-ds");
    expect(sent?.headers.get("anthropic-beta")).toBeNull();
    expect(sent?.body.system).toEqual([
      { type: "text", text: "org", cache_control: { type: "ephemeral" } },
      { type: "text", text: "where" },
    ]);
    for (const field of ["cache_control", "fallbacks", "tool_choice"]) expect(sent?.body).not.toHaveProperty(field);
    expect(sent?.body.tools).toEqual([{ name: "search", description: "s", input_schema: { type: "object" } }]);
    expect(sent?.body.output_config).toEqual({ effort: "high" });
  });

  test("structured output is a forced structured_output tool (DeepSeek takes tool_choice any); its input is the reply's JSON", async () => {
    const { provider, requests } = compat(
      "deepseek",
      sse([
        start("deepseek-flash"),
        ...thinking(0, "sig-ds"),
        ...toolUse(1, "structured_output", '{"needs_agent":1}'),
        ...end("tool_use", { output_tokens: 9 }),
      ]),
    );
    const schema = { type: "object", properties: { needs_agent: { type: "number" } }, required: ["needs_agent"] };
    const result = await provider.stream(request({ outputSchema: schema, effort: "low" }), quiet);
    const body = requests[0]?.body;
    expect(body?.tools).toEqual([{ name: "structured_output", description: expect.any(String), input_schema: schema }]);
    expect(body?.tool_choice).toEqual({ type: "any" });
    expect(body?.thinking).toEqual({ type: "disabled" });
    expect(body?.output_config).toBeUndefined();
    expect(result.text).toBe('{"needs_agent":1}');
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toEqual([
      { type: "opaque", provider: "deepseek", data: { type: "thinking", thinking: "Hmm.", signature: "sig-ds" } },
      { type: "text", text: '{"needs_agent":1}' },
    ]);
  });

  test("a model that always thinks is never forced: thinking refuses tool_choice, and the tool is only offered", async () => {
    for (const [id, model] of [
      ["deepseek", "deepseek-v4-pro"],
      ["moonshot", "kimi-k3"],
    ] as const) {
      const { provider, requests } = compat(
        id,
        sse([start(model), ...toolUse(0, "structured_output", '{"ok":1}'), ...end("tool_use", { output_tokens: 3 })]),
      );
      const result = await provider.stream(request({ model, outputSchema: { type: "object" }, effort: "low" }), quiet);
      expect(requests[0]?.body).not.toHaveProperty("tool_choice");
      expect(requests[0]?.body).not.toHaveProperty("thinking");
      expect(result.text).toBe('{"ok":1}');
    }
  });

  test("Z.ai and MiniMax take only tool_choice auto: the tool is offered, not forced, and a reply in text stays the text", async () => {
    for (const [id, model] of [
      ["zai", "glm-5.3-flash"],
      ["minimax", "MiniMax-M3.1-Flash"],
    ] as const) {
      const { provider, requests } = compat(
        id,
        sse([start(model), ...text(0, '{"needs_agent":0}'), ...end("end_turn", { output_tokens: 5 })]),
      );
      const result = await provider.stream(request({ model, outputSchema: { type: "object" } }), quiet);
      expect(requests[0]?.url.startsWith(`${PROVIDERS[id].baseURL}/v1/messages`)).toBe(true);
      expect(requests[0]?.body).not.toHaveProperty("tool_choice");
      expect((requests[0]?.body.tools as { name: string }[] | undefined)?.map((t) => t.name)).toEqual([
        "structured_output",
      ]);
      expect(result.text).toBe('{"needs_agent":0}');
    }
  });

  test("effort none: DeepSeek Flash and MiniMax M3 think not at all with no effort; GLM-5.3 Flash can't, so low", async () => {
    for (const [id, model, thinking, effort] of [
      ["deepseek", "deepseek-flash", { type: "disabled" }, undefined],
      ["minimax", "MiniMax-M3", { type: "disabled" }, undefined],
      ["zai", "glm-5.3-flash", undefined, "low"],
    ] as const) {
      const { provider, requests } = compat(
        id,
        sse([start(model), ...text(0, "{}"), ...end("end_turn", { output_tokens: 2 })]),
      );
      await provider.stream(request({ model, effort: "none" }), quiet);
      const body = requests[0]?.body;
      expect(body?.thinking).toEqual(thinking);
      expect(body?.output_config).toEqual(effort ? { effort } : undefined);
    }
  });

  test("pictures: DeepSeek Flash sees a tool result's picture, its PDF stays a note; DeepSeek V4 Pro keeps the note", async () => {
    const asked = (model: string): ModelRequest =>
      request({
        model,
        messages: [
          { role: "user", content: "o que tem nos arquivos?" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "read_artifact", input: {} },
              { type: "tool_use", id: "t2", name: "read_artifact", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "t1",
                content: "red.png",
                images: [{ mediaType: "image/png", data: "UE5H" }],
              },
              {
                type: "tool_result",
                toolUseId: "t2",
                content: "plan.pdf",
                images: [{ mediaType: "application/pdf", data: "JVBERi0=", pages: 1, name: "plan.pdf" }],
              },
            ],
          },
        ],
      });
    const flash = compat("deepseek", sse([start("deepseek-flash"), ...text(0, "vermelho"), ...end("end_turn", {})]));
    const seen = await flash.provider.stream(asked("deepseek-flash"), quiet);
    const sent = JSON.stringify(flash.requests[0]?.body.messages);
    expect(sent).toContain('"type":"image"');
    expect(sent).not.toContain('"type":"document"');
    expect(sent).toContain(
      "The PDF is not shown to you: this agent's AI (deepseek-flash) reads pictures through this connection, not PDFs.",
    );
    expect(sent).not.toContain("The picture is not shown to you");
    expect(seen.imagesLeftOut).toBe(true);

    const pro = compat("deepseek", sse([start("deepseek-v4-pro"), ...text(0, "só texto"), ...end("end_turn", {})]));
    const blind = await pro.provider.stream(asked("deepseek-v4-pro"), quiet);
    const words = JSON.stringify(pro.requests[0]?.body.messages);
    expect(words).not.toContain('"type":"image"');
    expect(words).toContain("The picture is not shown to you: this agent's AI (deepseek-v4-pro) reads text only");
    expect(blind.imagesLeftOut).toBe(true);
  });

  test("pictures alone: nothing is left out of DeepSeek Flash's turn", async () => {
    const flash = compat("deepseek", sse([start("deepseek-flash"), ...text(0, "vermelho"), ...end("end_turn", {})]));
    const seen = await flash.provider.stream(
      request({
        messages: [
          { role: "user", content: "o que tem?" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_artifact", input: {} }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "t1",
                content: "red.png",
                images: [{ mediaType: "image/png", data: "UE5H" }],
              },
            ],
          },
        ],
      }),
      quiet,
    );
    expect(JSON.stringify(flash.requests[0]?.body.messages)).not.toContain("is not shown to you");
    expect(seen.imagesLeftOut).toBeUndefined();
  });

  test("a PDF goes as its own text where the PDF can't, with nothing flagged; one with no text keeps the note", async () => {
    const asked = (model: string, text?: string): ModelRequest =>
      request({
        model,
        messages: [
          { role: "user", content: "o que diz o contrato?" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_artifact", input: {} }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "t1",
                content: "contrato.pdf",
                images: [
                  {
                    mediaType: "application/pdf",
                    data: "JVBERi0=",
                    pages: 1,
                    name: "contrato.pdf",
                    ...(text ? { text } : {}),
                  },
                ],
              },
            ],
          },
        ],
      });
    const words = '<external_data source="file contrato.pdf">\nPrazo de 30 dias.\n</external_data>';
    for (const model of ["deepseek-flash", "deepseek-v4-pro"]) {
      const sent = compat("deepseek", sse([start(model), ...text(0, "30 dias"), ...end("end_turn", {})]));
      const seen = await sent.provider.stream(asked(model, words), quiet);
      const body = JSON.stringify(sent.requests[0]?.body.messages);
      expect(body).not.toContain('"type":"document"');
      expect(body).toContain(JSON.stringify(words).slice(1, -1));
      expect(body).toContain(`The PDF contrato.pdf is not shown to you as pages: this agent's AI (${model})`);
      expect(body).not.toContain("The PDF is not shown to you");
      expect(seen.imagesLeftOut).toBeUndefined();
    }
    const scan = compat("deepseek", sse([start("deepseek-flash"), ...text(0, "?"), ...end("end_turn", {})]));
    const blind = await scan.provider.stream(asked("deepseek-flash"), quiet);
    expect(JSON.stringify(scan.requests[0]?.body.messages)).toContain(
      "The PDF is not shown to you: this agent's AI (deepseek-flash) reads pictures through this connection, not PDFs. No text could be read out of the PDF either",
    );
    expect(blind.imagesLeftOut).toBe(true);
  });

  test("max goes as high to an endpoint whose models don't list it", async () => {
    const { provider, requests } = compat(
      "moonshot",
      sse([start("kimi-k3.1-pro"), ...text(0, "{}"), ...end("end_turn", { output_tokens: 2 })]),
    );
    await provider.stream(request({ model: "kimi-k3.1-pro", effort: "max" }), quiet);
    expect(requests[0]?.body.output_config).toEqual({ effort: "high" });
  });

  test("thinking replays unchanged to the provider that wrote it; another provider's is left out", async () => {
    const { provider, requests } = compat(
      "moonshot",
      sse([start("kimi-k3.1-pro"), ...text(0, "ok"), ...end("end_turn", { output_tokens: 1 })]),
    );
    const own = { type: "thinking", thinking: "plan", signature: "sig-kimi" };
    const call = { type: "tool_use" as const, id: "toolu_0", name: "search", input: { q: "x" } };
    await provider.stream(
      request({
        model: "kimi-k3.1-pro",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "anthropic", data: { type: "thinking", thinking: "x", signature: "sig-a" } },
              { type: "opaque", provider: "moonshot", data: own },
              call,
            ],
          },
          { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_0", content: "found" }] },
        ],
      }),
      quiet,
    );
    expect((requests[0]?.body.messages as Record<string, unknown>[] | undefined)?.[1]).toEqual({
      role: "assistant",
      content: [own, call],
    });
  });

  test("usage without cache fields counts them as 0; a prompt count sent only at the end is the one billed", async () => {
    const { provider } = compat(
      "minimax",
      sse([
        start("MiniMax-M3", { input_tokens: 0, output_tokens: 0 }),
        ...text(0, "ok"),
        ...end("end_turn", { input_tokens: 1252, output_tokens: 213 }),
      ]),
    );
    const result = await provider.stream(request({ model: "MiniMax-M3" }), quiet);
    expect(result.usage).toEqual({ inputTokens: 1252, outputTokens: 213, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test("one adapter per provider, named by its id; the compatible ones don't count tokens", () => {
    const adapters = createModelProviders();
    expect(Object.keys(adapters)).toEqual(Object.keys(PROVIDERS));
    for (const [id, adapter] of Object.entries(adapters)) expect(adapter.id).toBe(id);
    expect(adapters.anthropic?.countTokens).toBeDefined();
    expect(adapters.deepseek?.countTokens).toBeUndefined();
  });
});
