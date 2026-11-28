import { connectorOAuthApps } from "@agenteschat/config";
import {
  acceptCustomSuggestion,
  CONNECTOR_EVENTS,
  type CustomDeps,
  composioConnectorsOf,
  connectCustomServer,
  connectOverHttp,
  connectorIconFile,
  connectorListing,
  listCustomServers,
  MCP_PRESETS,
  mcpPreset,
  NotFoundError,
  ownOAuthClient,
  refreshCustomServer,
  removeOwnOAuthClient,
  requirePermission,
  revokeConnection,
  saveCustomTools,
  setOwnOAuthClient,
  ValidationError,
  withComposio,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { imageFile } from "../../http/image-file";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Connectors"];
const Access = z.enum(["read", "write", "approval"]);
/** An admin's decision: how the tool may be used, or `off` (never offered, not asked again). */
const Decision = z.enum(["read", "write", "approval", "off"]);
/** What connecting did: a new account, a new sign-in for one, or the same account again (nothing new). */
export const Outcome = z.enum(["connected", "reconnected", "same_account"]);

/** The person's own connection, which any member adds, instead of the team's (who manages connectors). */
export const Personal = z.boolean().optional().openapi({
  description:
    "The person's own connection, which any member adds (who manages connectors adds the team's): only they see its details, and agents use it for them. GitHub connects for the team only.",
});

/**
 * `others=1`: also everyone else's personal connections (who manages connectors only), as read-only rows. A client
 * that doesn't send it (an older app) never gets one, so it can't show someone's as the team's.
 */
export const OthersQuery = z.object({
  others: z
    .enum(["0", "1"])
    .optional()
    .openapi({ description: "`1`: also everyone else's personal ones, for who manages connectors." }),
});

const CustomServer = z
  .object({
    id: z.uuid(),
    serverUrl: z.string(),
    label: z.string().openapi({ description: 'The account\'s name here ("Stripe (Acme)", "Stripe 2").' }),
    accountLabel: z.string().nullable().openapi({
      description: "The account as the provider names it, when it says (refreshed when tools are listed).",
    }),
    authType: z.enum(["oauth", "api_key"]),
    headerNames: z.array(z.string()).openapi({
      description:
        "The request headers typed for it (ADR 0186), by name: their values are never returned. Empty when it has none, and for a reader who doesn't manage connectors.",
    }),
    iconUrl: z
      .string()
      .nullable()
      .openapi({ description: "The server's own icon (`/api/app/connector-icons/…`); null = a monogram." }),
    via: z.literal("composio").optional().openapi({
      description: "A service through Composio (ADR 0107): its address means nothing to people, so the apps hide it.",
    }),
    status: z.enum(["active", "needs_reconnect"]).openapi({
      description:
        "`needs_reconnect`: its Composio account stopped working, and agents get no tool of it until Reconectar.",
    }),
    events: z.array(z.enum(CONNECTOR_EVENTS)).openapi({
      description: "What routines can wait on from it (ADR 0130): `millionsend.email.received`.",
    }),
    toolsError: z.string().nullable().openapi({
      description:
        "Why its tools couldn't be read the last time they were listed (short); null when they were. The apps say it with Tentar de novo (`…/refresh`).",
    }),
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        readOnlyHint: z.boolean().nullable(),
        suggestedAccess: Access.nullable().openapi({ description: "Our suggestion until an admin decides." }),
        access: Decision.nullable().openapi({ description: "Null = not classified yet: hidden from agents." }),
        level: Decision.openapi({ description: "The decision, else the suggestion." }),
        suggestionSource: z.enum(["annotation", "verb", "preset", "judge", "judge_failed"]).nullable().openapi({
          description: "Where the suggestion came from: the server's hints, the name's verb, or the judge.",
        }),
        suggestionReason: z
          .string()
          .nullable()
          .openapi({ description: "Why, as a code the web translates (`spends_money`, `unknown`…)." }),
        sensitive: z.boolean().openapi({ description: "May only ask for approval or be off." }),
        pending: z
          .boolean()
          .openapi({ description: "The name couldn't decide it and no one confirmed the suggestion yet." }),
        off: z.boolean(),
        nameParts: z
          .object({ verb: z.string().nullable(), words: z.array(z.string()) })
          .openapi({ description: "The readable name's parts (verb and words, English); the web localizes them." }),
        subject: z.string().openapi({ description: "The resource it is about (from the name): tools group by it." }),
        label: z.string(),
        firstSeenAt: z.string(),
      }),
    ),
    instructions: z
      .object({
        text: z.string(),
        cut: z.boolean().openapi({ description: "The server said more than agents read: `text` ends at `maxChars`." }),
        maxChars: z.number().int(),
      })
      .nullable()
      .openapi({
        description:
          "What the server said in `initialize` on how to use it (MCP's `instructions`), as agents read it. Null when it said nothing, and for a reader who doesn't manage connectors.",
      }),
    useInstructions: z.boolean().openapi({
      description: "Agents granted its tools get `instructions`, after their own (on unless turned off).",
    }),
    reviewedAt: z.string().nullable(),
    createdAt: z.string(),
    ownerUserId: z.string().nullable().openapi({
      description:
        "A personal connection's person (ADR 0099 addendum): only they see its details and give it to agents, and its tools serve runs that person is behind. Someone else's comes with its name, service and person only, to who manages connectors. Null: the team's.",
    }),
    agentIds: z.array(z.uuid()).optional().openapi({
      description: "A personal connection's agents (a grant of their own on it), in the list only.",
    }),
  })
  .openapi("CustomServer");

const ServerParams = OrgParams.extend({ serverId: z.uuid() });

const ConnectStart = z.union([
  z.object({ status: z.literal("connected"), server: CustomServer, outcome: Outcome }),
  z.object({ status: z.literal("oauth"), authorizeUrl: z.string() }),
  z.object({
    status: z.literal("needs_key"),
    reason: z.literal("not_approved").optional().openapi({
      description: "It has OAuth but only lets in apps it approved, and agentes.chat isn't one yet.",
    }),
    detail: z.string().optional().openapi({
      description:
        "With `not_approved`: how the server refused our registration, in its own words (`error: error_description`, at most 200 characters).",
    }),
  }),
]);
const ReconnectId = z.uuid().optional().openapi({
  description:
    "Reconectar: the account whose sign-in or key this replaces (same address; its name, tools and grants stay). Without it a new account comes in.",
});

/**
 * Custom MCP servers by URL (admins): MCP-native OAuth (discovery + dynamic
 * client registration + PKCE + resource) or an API key; tools stay hidden
 * until an admin classifies each as read, write or approval. Agents get
 * `custom:{serverId}:read` / `:write` scopes.
 */
export function customConnectorRoutes(deps: AppDeps) {
  const { db, config, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use("/connector-icons/*", requireSession(deps.auth));
  const composio = composioConnectorsOf(adapters.mail);
  const custom: CustomDeps = {
    db,
    keyWrappers: [adapters.keyWrapper, ...adapters.legacyKeyWrappers],
    oauthApps: connectorOAuthApps(config),
    publicUrl: config.PUBLIC_URL,
    http: deps.extras?.http,
    resolveHost: deps.extras?.resolveHost,
    connect: withComposio(deps.extras?.mcpConnect ?? connectOverHttp, composio),
    composio,
    judge: deps.extras?.context?.judge,
    blobs: adapters.platformBlobs,
    log: deps.log,
  };

  // A server's icon, for the org's members.
  app.get("/connector-icons/:orgId/:connectionId/:file", async (c) =>
    imageFile(
      await connectorIconFile(
        { db, blobs: adapters.platformBlobs },
        c.get("user").id,
        c.req.param("orgId"),
        c.req.param("connectionId"),
        c.req.param("file"),
      ),
    ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/connectors/custom",
      tags,
      security,
      summary: "Custom MCP servers and their tools",
      request: { params: OrgParams, query: OthersQuery },
      responses: { 200: json(z.object({ servers: z.array(CustomServer) })), ...errors },
    }),
    async (c) =>
      c.json(
        {
          servers: await listCustomServers(db, c.get("user").id, c.req.valid("param").orgId, {
            others: c.req.valid("query").others === "1",
          }),
        },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/custom",
      tags,
      security,
      summary: "Connect an https MCP server: connected, OAuth to finish, or an API key is needed",
      description:
        "A server's account is every agent's, whole (`connector:*`): its tools reach them once classified, and sensitive ones still ask for approval. The same address again is another account (\"Stripe 2\"), every agent's too; the same account again (the provider says) refreshes its sign-in (`outcome: same_account`). With `connectionId`, that account gets the new sign-in in place (`reconnected`); signing in to another account there is a 409 `connector.other_account`, and a sign-in whose account can't be checked a 409 `connector.account_unknown` (try again). `headers` (ADR 0186) are sent with every request to the server, the key's `Authorization` on top; without a key, a server that answers with them is connected by them alone, and one that asks for a sign-in is a 400 `connector.headers_with_sign_in`. A header that isn't taken is a 400 whose `params` name it (`header`, and `index`, its place in the list): `connector.header_name`, `connector.header_value`, `connector.header_reserved`, `connector.header_twice`, `connector.header_and_key` (`Authorization` beside a key), or `connector.headers_too_many`. With `connectionId` and no `headers`, saved ones that can no longer be read are a 400 `connector.headers_unreadable`: send them again, or `[]`.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            serverUrl: z.string().min(1).max(500),
            apiKey: z.string().max(2000).optional(),
            label: z.string().max(80).optional(),
            returnTo: z.string().max(500).optional(),
            connectionId: ReconnectId,
            personal: Personal,
            headers: z
              .array(z.object({ name: z.string(), value: z.string() }))
              .optional()
              .openapi({
                description:
                  "Request headers for a server by address: at most 10, each an HTTP token for a name (64 characters) and a one-line value of printable ASCII (2,000). With `connectionId`: absent keeps the ones the account has, an empty list removes them, a list replaces them.",
              }),
          }),
        ),
      },
      responses: { 200: json(ConnectStart), ...errors },
    }),
    async (c) => {
      const started = await connectCustomServer(
        custom,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json(started, 200);
    },
  );

  const Preset = z
    .object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      icon: z.string(),
      serverUrl: z.string(),
      soon: z.boolean().openapi({ description: "The vendor hasn't approved agentes.chat yet: it can't be connected." }),
    })
    .openapi("McpPreset");
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/connectors/presets",
      tags,
      security,
      summary: "One-click connectors: official MCP servers with OAuth and dynamic registration",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ presets: z.array(Preset) })), ...errors },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "read");
      const presets = MCP_PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        icon: p.icon,
        serverUrl: p.serverUrl,
        soon: p.soon === true,
      }));
      return c.json({ presets }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/presets/{presetId}/connect",
      tags,
      security,
      summary:
        "Connect a one-click connector (the team's by admins, a personal one by any member): returns the OAuth URL to open",
      description:
        "After the OAuth, our suggested classification is applied to its tools (admins can change it). No app registration needed. Accounts and `connectionId` as in `POST …/connectors/custom`. It connects by the way the catalog lists for it (the vendor's server, or Composio, ADR 0107). A `soon` one Composio doesn't serve here is refused (400 `connector.not_approved`): its vendor hasn't approved agentes.chat yet.",
      request: {
        params: OrgParams.extend({ presetId: z.string().max(60) }),
        body: body(
          z.object({ returnTo: z.string().max(500).optional(), connectionId: ReconnectId, personal: Personal }),
        ),
      },
      responses: { 200: json(ConnectStart), ...errors },
    }),
    async (c) => {
      const { orgId, presetId } = c.req.valid("param");
      const preset = mcpPreset(presetId);
      if (!preset) throw new NotFoundError("Unknown connector");
      const way = connectorListing({ oauthApps: custom.oauthApps ?? {}, composio }).find((e) => e.id === preset.id);
      if (way?.soon) {
        throw new ValidationError(`${preset.label} hasn't approved agentes.chat yet`, "connector.not_approved", {
          connector: preset.id,
        });
      }
      const { returnTo, connectionId, personal } = c.req.valid("json");
      const started = await connectCustomServer(custom, c.get("user").id, orgId, {
        serverUrl: way?.serverUrl ?? preset.serverUrl,
        label: preset.label,
        returnTo,
        connectionId,
        personal,
      });
      return c.json(started, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/custom/{serverId}/refresh",
      tags,
      security,
      summary: "List the server's tools again (new ones come back unclassified)",
      request: { params: ServerParams },
      responses: { 200: json(CustomServer), ...errors },
    }),
    async (c) => {
      const { orgId, serverId } = c.req.valid("param");
      return c.json(await refreshCustomServer(custom, c.get("user").id, orgId, serverId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/connectors/custom/{serverId}/tools",
      tags,
      security,
      summary: "Save the label and the classification of each tool",
      description:
        "Sensitive tools may only be `approval` or `off` (400 otherwise). `confirmed: false` applies a suggestion but leaves an ambiguous tool waiting for a decision. `useInstructions`, when given, turns the server's own instructions on or off for agents.",
      request: {
        params: ServerParams,
        body: body(
          z.object({
            label: z.string().max(80),
            useInstructions: z.boolean().optional(),
            tools: z
              .array(
                z.object({
                  name: z.string(),
                  access: Decision,
                  label: z.string().max(120),
                  confirmed: z.boolean().optional(),
                }),
              )
              .max(1000),
          }),
        ),
      },
      responses: { 200: json(CustomServer), ...errors },
    }),
    async (c) => {
      const { orgId, serverId } = c.req.valid("param");
      return c.json(await saveCustomTools(custom, c.get("user").id, orgId, serverId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/custom/{serverId}/accept-suggestion",
      tags,
      security,
      summary: "Classify every pending tool as suggested, in one call; lists agents that could get access",
      request: { params: ServerParams },
      responses: {
        200: json(
          z.object({
            server: CustomServer,
            agentsWithoutAccess: z.array(z.object({ id: z.uuid(), name: z.string(), handle: z.string() })),
            suggestedGrant: z.object({ connectors: z.record(z.string(), z.boolean()) }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, serverId } = c.req.valid("param");
      return c.json(await acceptCustomSuggestion(custom, c.get("user").id, orgId, serverId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/connectors/custom/{serverId}",
      tags,
      security,
      summary: "Disconnect a custom server (agents lose its scopes)",
      request: { params: ServerParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, serverId } = c.req.valid("param");
      await revokeConnection(db, c.get("user").id, orgId, serverId, composio);
      return c.body(null, 204);
    },
  );

  const OwnClient = z
    .object({
      redirectUri: z.string().openapi({ description: "The redirect URI to register in the app: our OAuth callback." }),
      issuer: z.string().openapi({ description: "The authorization server the MCP server named." }),
      client: z
        .object({
          clientId: z.string(),
          hasSecret: z.boolean().openapi({ description: "A secret is saved (sealed: it is never returned)." }),
          scopes: z
            .string()
            .nullable()
            .openapi({ description: "What every sign-in asks for; null: what the server lists." }),
        })
        .nullable()
        .openapi({
          description:
            "The workspace's own client for that issuer; null: none (a registration of ours, or nothing yet).",
        }),
    })
    .openapi("OwnOAuthClient");
  const ownClientDoc =
    "A workspace's own OAuth client (ADR 0016 addendum 2026-11-21), for an MCP server that takes only clients it approved (`needs_key` with `not_approved`): one per authorization server, used by every sign-in there and never replaced by a registration of ours. Who manages connectors only. The server is asked (without credentials) which authorization server it uses; one that doesn't sign in with OAuth is a 400 `connector.no_oauth`, one whose OAuth details can't be read a 400 `connector.oauth_discovery`.";

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/connector-oauth-clients",
      tags,
      security,
      summary: "The workspace's own OAuth client for an MCP server, and the redirect URI to register",
      description: ownClientDoc,
      request: { params: OrgParams, query: z.object({ serverUrl: z.string().min(1).max(500) }) },
      responses: { 200: json(OwnClient), ...errors },
    }),
    async (c) =>
      c.json(
        await ownOAuthClient(custom, c.get("user").id, c.req.valid("param").orgId, c.req.valid("query").serverUrl),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/connector-oauth-clients",
      tags,
      security,
      summary: "Save the workspace's own OAuth client for an MCP server",
      description: `${ownClientDoc} The same \`clientId\` again keeps the saved secret unless one is sent. Another \`clientId\` while accounts sign in with the saved one is a 409 \`connector.oauth_client_in_use\` (their tokens belong to it); a client id that isn't printable ASCII is a 400 \`connector.oauth_client_id\`.`,
      request: {
        params: OrgParams,
        body: body(
          z.object({
            serverUrl: z.string().min(1).max(500),
            clientId: z.string().min(1).max(500),
            clientSecret: z.string().max(2000).optional(),
            scopes: z
              .string()
              .max(1000)
              .optional()
              .openapi({ description: "Space- or comma-separated; absent: what the server lists." }),
          }),
        ),
      },
      responses: { 200: json(OwnClient), ...errors },
    }),
    async (c) =>
      c.json(await setOwnOAuthClient(custom, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/connector-oauth-clients",
      tags,
      security,
      summary: "Remove the workspace's own OAuth client for an authorization server",
      description:
        "Refused with a 409 `connector.oauth_client_in_use` while accounts sign in with it: disconnect them first.",
      request: { params: OrgParams, query: z.object({ issuer: z.string().min(1).max(500) }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await removeOwnOAuthClient(custom, c.get("user").id, c.req.valid("param").orgId, c.req.valid("query").issuer);
      return c.body(null, 204);
    },
  );

  // A changed tool applies itself (ADR 0117, addendum), so nothing ever waits here. The three routes stay for
  // installed apps that still ask: the list is empty and accepting succeeds without doing anything.
  const changes = { tags, security, deprecated: true, description: "Nothing waits: a changed tool applies itself." };
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/connectors/tool-changes",
      ...changes,
      summary: "MCP tools waiting for a review of their change: always none",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ changes: z.array(z.unknown()) })), ...errors },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "manage_connectors");
      return c.json({ changes: [] }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/{connectionId}/tools/{toolName}/accept-change",
      ...changes,
      summary: "Accept a tool's change: does nothing",
      request: { params: OrgParams.extend({ connectionId: z.uuid(), toolName: z.string().min(1).max(200) }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "manage_connectors");
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/{connectionId}/tool-changes/accept",
      ...changes,
      summary: "Accept every change on a connection: does nothing",
      request: { params: OrgParams.extend({ connectionId: z.uuid() }) },
      responses: { 200: json(z.object({ accepted: z.number().int() })), ...errors },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "manage_connectors");
      return c.json({ accepted: 0 }, 200);
    },
  );

  return app;
}
