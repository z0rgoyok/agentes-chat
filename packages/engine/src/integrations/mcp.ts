import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorResult, listed, toolError, toolResult } from "../apps/tools";
import { appsUrls } from "../apps/urls";
import { TooManyError } from "../errors";
import { INTEGRATION_LIMITS, type IntegrationPrincipal } from "./apps";
import { type AppMessage, appChannels, assertAppMayWork, postAsApp, readAsApp, type TrafficDeps } from "./traffic";

/** The tools an integration app gets on `/mcp` (ADR 0251): its channels, posting as itself, reading what came since. */
export const INTEGRATION_TOOL_NAMES = ["list_channels", "post_message", "read_messages"] as const;

export interface IntegrationMcpDeps extends TrafficDeps {
  publicUrl: string;
  report?: (error: unknown, context: Record<string, unknown>) => void;
}

const postInput = z
  .object({
    channel_id: z.uuid().describe("A channel from list_channels with can_post true"),
    text: z.string().min(1).max(INTEGRATION_LIMITS.text).describe("The message, as the outside person wrote it"),
    thread_id: z.uuid().optional().describe("Post in this thread (the id of its first message)"),
    sender: z
      .string()
      .max(INTEGRATION_LIMITS.sender)
      .optional()
      .describe("The outside person's display name, shown beside the app's name"),
    idempotency_key: z.string().max(64).optional().describe("The same key within a day posts the message once"),
  })
  .strict();
const readInput = z
  .object({
    channel_id: z.uuid().optional().describe("Only this channel (default: every channel of the app)"),
    after: z.uuid().optional().describe("next_cursor of the previous read: only messages written since"),
    limit: z.number().int().min(1).max(100).optional().describe("Messages, 1 to 100 (default 50)"),
  })
  .strict();

/** Text others wrote comes back fenced as content (`toolResult`'s `untrusted_text`). */
const fenced = (m: AppMessage) => {
  const { text, ...rest } = m;
  return { ...rest, untrusted_text: text };
};

/** One McpServer per request, for the app. */
export function buildIntegrationMcpServer(deps: IntegrationMcpDeps, p: IntegrationPrincipal, version: string) {
  const urls = appsUrls(deps.publicUrl);
  const server = new McpServer(
    { name: "agentes-chat", title: "agentes.chat", version, websiteUrl: urls.issuer },
    {
      instructions: `This connection is the integration app "${p.name.slice(0, 64)}" in an agentes.chat workspace. It posts as itself in the channels list_channels returns, never as a person; agents there answer what it posts. read_messages returns what was written since a cursor.`,
      maxToolInputElements: 1_000,
    },
  );
  const tool = <S extends z.ZodObject>(
    name: (typeof INTEGRATION_TOOL_NAMES)[number],
    cfg: { title: string; description: string; input: S; readOnly: boolean },
    run: (args: z.output<S>) => Promise<Record<string, unknown>>,
  ) =>
    server.registerTool(
      name,
      {
        title: cfg.title,
        description: cfg.description,
        inputSchema: listed(cfg.input) as never,
        annotations: {
          title: cfg.title,
          readOnlyHint: cfg.readOnly,
          destructiveHint: false,
          idempotentHint: cfg.readOnly,
          openWorldHint: true,
        },
      },
      (async (args: z.output<S>) => {
        try {
          await assertAppMayWork(deps.db, p);
          return toolResult(await run(args));
        } catch (error) {
          if (error instanceof TooManyError) {
            return toolError("Too many requests from this app. Try again later.", {
              retry_after: error.params?.retryAfter ?? 60,
            });
          }
          return errorResult(error, deps, { tool: name, orgId: p.orgId, appId: p.appId });
        }
      }) as never,
    );

  tool(
    "list_channels",
    {
      title: "List the app's channels",
      description: "Lists the channels this app reads, with can_post true where it may also post.",
      input: z.object({}).strict(),
      readOnly: true,
    },
    async () => ({ channels: await appChannels(deps.db, p) }),
  );
  tool(
    "post_message",
    {
      title: "Post a message",
      description:
        "Posts a message as this app in one of its channels, optionally in a thread and with the outside sender's name. Agents in the channel answer it as usual; their replies are returned by read_messages and sent to the app's webhook.",
      input: postInput,
      readOnly: false,
    },
    async (args) => {
      const posted = await postAsApp(deps, p, {
        channelId: args.channel_id,
        threadId: args.thread_id ?? null,
        text: args.text,
        sender: args.sender ?? null,
        idempotencyKey: args.idempotency_key ?? null,
      });
      return { message: fenced(posted.message), answering: posted.runs, duplicate: posted.duplicate };
    },
  );
  tool(
    "read_messages",
    {
      title: "Read new messages",
      description:
        "Returns the messages written in the app's channels after a cursor, oldest first, with each agent reply's in_reply_to. Pass next_cursor as after on the next call.",
      input: readInput,
      readOnly: true,
    },
    async (args) => {
      const read = await readAsApp(deps.db, p, {
        channelId: args.channel_id ?? null,
        after: args.after ?? null,
        limit: args.limit,
      });
      return { messages: read.messages.map(fenced), next_cursor: read.next_cursor };
    },
  );
  return server;
}
