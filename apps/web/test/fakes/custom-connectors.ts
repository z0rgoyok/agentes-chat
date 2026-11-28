/**
 * Test fake — custom MCP servers ("Outro servidor MCP" in "Adicionar conector").
 * Mirrors these endpoints:
 * - GET    /api/app/organizations/{orgId}/connectors/custom
 * - POST   /api/app/organizations/{orgId}/connectors/custom { serverUrl, apiKey?, label?, returnTo, connectionId?, headers? }
 *          → { status: "connected", server, outcome } | { status: "oauth", authorizeUrl } | { status: "needs_key" }
 *          (the same address again is another account, "Name 2", which no agent uses; `connectionId`
 *          reconnects that account in place; `headers` alone connect, are refused with a sign-in, and on a
 *          reconnect stay when absent, go with `[]` and are replaced by a list)
 * - POST   /api/app/organizations/{orgId}/connectors/custom/{id}/refresh (re-list tools)
 * - PUT    /api/app/organizations/{orgId}/connectors/custom/{id}/tools { label, tools: [{ name, access, label, confirmed? }], useInstructions? }
 *          (`access`: read | write | approval | off; sensitive tools only approval | off)
 * - DELETE /api/app/organizations/{orgId}/connectors/custom/{id}
 * - GET/PUT/DELETE /api/app/organizations/{orgId}/connector-oauth-clients (the workspace's own OAuth app, one per
 *          issuer: here one per server's origin; the secret is never returned)
 * The mock never talks to the URL: it pretends the server offers a ticket
 * tool set, needs an API key unless the URL contains "oauth", sends its own
 * instructions when the URL contains "rules" (the worst ones with "worst"),
 * and gains one new tool on the first refresh. Tools come classified as the backend does
 * (annotations, the verb; `close_ticket` is ambiguous: the judge suggests
 * "write" and it waits for a decision; `delete_customer` is sensitive).
 */
import {
  type ApiClient,
  ApiError,
  type CustomServer,
  type CustomTool,
  type OwnOAuthClient,
  type ToolAccess,
} from "@agenteschat/client";
import { partsOf } from "@agenteschat/client/lib/tool-review";
import { clone, type MockContext, MockNotFoundError, mockId } from "./context";

const TOOLS: [name: string, description: string, readOnly: boolean | null][] = [
  ["list_tickets", "List support tickets, filtered by status or customer.", true],
  ["get_ticket", "Read one ticket with its messages.", true],
  ["create_ticket", "Open a new ticket for a customer.", false],
  ["close_ticket", "Close a ticket with a resolution note.", null],
  ["delete_customer", "Permanently delete a customer and their data.", false],
];
const LATER: [string, string, boolean | null] = ["export_tickets", "Export tickets as CSV.", true];
/** What a server whose address says "rules" answers `initialize` with (MCP's `instructions`). */
export const MOCK_INSTRUCTIONS = "Call get_ticket before close_ticket.\nAsk the person before delete_customer.";

/**
 * The worst instructions a real server sends (an address that says "worst"): Markdown, an address and a token with no
 * place to break, what would be a mention, an internal id's chip and a link anywhere else, a table, other scripts,
 * emoji, runs of blank lines, and more than agents read, so the screen shows its first 4,000 characters, cut.
 */
export const WORST_INSTRUCTIONS = [
  "# Northwind Industries Holdings — Billing & Subscriptions MCP server (v2026.07.28-rc.3)",
  "",
  "## Before you call anything",
  "",
  "1. Always call `billing_get_customer_subscription_summary_with_invoices` before `billing_apply_subscription_change_immediately`.",
  "2. Ask the person to confirm **every** destructive call (cancel, refund, delete) in the conversation, quoting the exact customer id, e.g. `cus_01HZX8Q7M3V5N9K2P4R6T8W0Y2A4C6E8G0J2L4N6Q8S0U2W4Y6`.",
  "3. Full policy: https://docs.northwind-industries-holdings.example.com/integrations/mcp/billing-and-subscriptions/instructions/v2026-07-28/confirmation-before-destructive-calls?utm_source=mcp&utm_medium=instructions",
  "4. Escalations go to @ada; the case is artifact 0193b1c2-3d4e-7f50-8a6b-1c2d3e4f5a6b, see [the runbook](https://runbook.example.com/billing).",
  "",
  "",
  "",
  "| Tool | Reads | Writes | Asks |",
  "| --- | --- | --- | --- |",
  "| billing_list_invoices | yes | no | no |",
  "| billing_refund_invoice | no | yes | always |",
  "",
  "Mehrwertsteuer-Rückerstattungsbearbeitungsgebühren apply to EU refunds. 請求書の払い戻しは必ず確認してください。 الرجاء تأكيد كل عملية استرداد. 🧾💳✅",
  "",
  "```json",
  '{"customer":"cus_01HZX8Q7M3V5N9K2P4R6T8W0Y2A4C6E8G0J2L4N6Q8S0U2W4Y6","amount_cents":1284000,"currency":"EUR"}',
  "```",
  "",
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `- Rule ${i + 1}: when a customer on the ${i % 2 ? "annual" : "monthly"} plan asks for a change, read their open invoices first, never prorate by hand, and say which invoice the change lands on.`,
  ),
].join("\n");

/** How the backend classifies each (classify.ts): level, source, reason, sensitive. */
const CLASS: Record<string, [ToolAccess, NonNullable<CustomTool["suggestionSource"]>, string, boolean]> = {
  list_tickets: ["read", "annotation", "read_only_hint", false],
  get_ticket: ["read", "annotation", "read_only_hint", false],
  create_ticket: ["write", "verb", "verb_write", false],
  close_ticket: ["write", "judge", "changes_undoable", false],
  delete_customer: ["approval", "verb", "verb_sensitive", true],
  export_tickets: ["read", "annotation", "read_only_hint", false],
};

const tool = ([name, description, readOnly]: [string, string, boolean | null], now: Date): CustomTool => {
  const [level, source, reason, sensitive] = CLASS[name] ?? ["approval", "judge_failed", "unknown", false];
  const { subject, ...nameParts } = partsOf(name);
  return {
    name,
    description,
    readOnlyHint: readOnly,
    suggestedAccess: level,
    access: null,
    level,
    suggestionSource: source,
    suggestionReason: reason,
    sensitive,
    pending: source === "judge" || source === "judge_failed",
    off: false,
    nameParts,
    subject,
    label: "",
    firstSeenAt: now.toISOString(),
  };
};

export function createMockCustomConnectors(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void = () => {},
  /** An account connected (the backend gives it to every agent). */
  onConnected: (orgId: string, serverId: string) => Promise<void> = async () => {},
  /** Who is asking: lists hold the team's servers and theirs, and everyone's with `others`, as the backend's do. */
  meId: () => string | null = () => null,
): ApiClient["customConnectors"] & {
  rename(orgId: string, id: string, label: string): CustomServer | null;
} {
  const byOrg = new Map<string, CustomServer[]>();
  const ownClients = new Map<string, NonNullable<OwnOAuthClient["client"]>>();
  const issuerOf = (serverUrl: string) => new URL(serverUrl).origin;
  const ownView = (orgId: string, serverUrl: string): OwnOAuthClient => ({
    redirectUri: "https://chat.example.com/api/app/connectors/oauth/callback",
    issuer: issuerOf(serverUrl),
    client: clone(ownClients.get(`${orgId}|${issuerOf(serverUrl)}`) ?? null),
  });
  const refreshed = new Set<string>();
  const list = (orgId: string) => {
    let l = byOrg.get(orgId);
    if (!l) {
      l = [];
      byOrg.set(orgId, l);
    }
    return l;
  };
  const find = (orgId: string, id: string) => {
    const s = list(orgId).find((x) => x.id === id);
    if (!s) throw new MockNotFoundError("Server not found");
    return s;
  };
  return {
    list: async (orgId, options) =>
      clone(list(orgId).filter((s) => options?.others || !s.ownerUserId || s.ownerUserId === meId())),
    connect: async (orgId, input) => {
      log("customConnectors.connect", orgId, {
        ...input,
        apiKey: input.apiKey ? "[redacted]" : undefined,
        ...(input.headers ? { headers: input.headers.map((h) => ({ name: h.name, value: "[redacted]" })) } : {}),
      });
      // Through Composio: its page signs in, back to the callback.
      if (input.serverUrl.startsWith("https://backend.composio.dev/")) {
        return { status: "oauth", authorizeUrl: "https://composio.example/connect/ca_1?state=s" };
      }
      const oauth = input.serverUrl.includes("oauth");
      const target = input.connectionId ? find(orgId, input.connectionId) : null;
      const headerNames = input.headers?.map((h) => h.name) ?? target?.headerNames ?? [];
      if (oauth && !input.apiKey && headerNames.length > 0) {
        throw new ApiError(400, "connector.headers_with_sign_in", "This server asks for a sign-in");
      }
      if (!oauth && !input.apiKey && headerNames.length === 0) return { status: "needs_key" };
      if (target) {
        target.headerNames = headerNames;
        return { status: "connected", server: clone(target), outcome: "reconnected" };
      }
      const now = ctx.now();
      const base = input.label?.trim() || new URL(input.serverUrl).hostname;
      const taken = new Set(list(orgId).map((s) => s.label.toLowerCase()));
      let label = base;
      for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${base} ${n}`;
      const server: CustomServer = {
        id: mockId("mcp"),
        serverUrl: input.serverUrl,
        label,
        accountLabel: null,
        authType: oauth ? "oauth" : "api_key",
        headerNames,
        tools: TOOLS.map((t) => tool(t, now)),
        instructions: input.serverUrl.includes("worst")
          ? { text: WORST_INSTRUCTIONS.slice(0, 4000), cut: WORST_INSTRUCTIONS.length > 4000, maxChars: 4000 }
          : input.serverUrl.includes("rules")
            ? { text: MOCK_INSTRUCTIONS, cut: false, maxChars: 4000 }
            : null,
        useInstructions: true,
        reviewedAt: null,
        createdAt: now.toISOString(),
        ...(input.personal ? { ownerUserId: meId() } : {}),
      };
      list(orgId).push(server);
      await onConnected(orgId, server.id);
      // A real OAuth flow leaves for the provider; the mock connects at once.
      return { status: "connected", server: clone(server), outcome: "connected" };
    },
    rename: (orgId, id, label) => {
      const s = list(orgId).find((x) => x.id === id);
      if (s) s.label = label;
      return s ? clone(s) : null;
    },
    refresh: async (orgId, id) => {
      log("customConnectors.refresh", orgId, id);
      const s = find(orgId, id);
      if (!refreshed.has(id)) {
        refreshed.add(id);
        s.tools.push(tool(LATER, ctx.now()));
      }
      return clone(s);
    },
    saveTools: async (orgId, id, input) => {
      log("customConnectors.saveTools", orgId, id, structuredClone(input));
      const s = find(orgId, id);
      s.label = input.label;
      if (input.useInstructions !== undefined) s.useInstructions = input.useInstructions;
      for (const t of input.tools) {
        const existing = s.tools.find((x) => x.name === t.name);
        if (existing) {
          if (existing.sensitive && (t.access === "read" || t.access === "write")) {
            throw new Error(`${t.name} is sensitive: it can only ask for approval or be off`);
          }
          existing.access = t.access;
          existing.level = t.access;
          existing.off = t.access === "off";
          existing.label = t.label;
          if (t.confirmed !== false) existing.pending = false;
        }
      }
      s.reviewedAt = ctx.now().toISOString();
      return clone(s);
    },
    disconnect: async (orgId, id) => {
      log("customConnectors.disconnect", orgId, id);
      byOrg.set(
        orgId,
        list(orgId).filter((x) => x.id !== id),
      );
    },
    ownClient: async (orgId, serverUrl) => ownView(orgId, serverUrl),
    setOwnClient: async (orgId, input) => {
      log("customConnectors.setOwnClient", orgId, {
        ...input,
        clientSecret: input.clientSecret ? "[redacted]" : undefined,
      });
      const key = `${orgId}|${issuerOf(input.serverUrl)}`;
      const before = ownClients.get(key);
      ownClients.set(key, {
        clientId: input.clientId,
        hasSecret: Boolean(input.clientSecret) || (before?.clientId === input.clientId && before.hasSecret),
        scopes:
          input.scopes
            ?.split(/[\s,]+/)
            .filter(Boolean)
            .join(" ") || null,
      });
      return ownView(orgId, input.serverUrl);
    },
    removeOwnClient: async (orgId, issuer) => {
      log("customConnectors.removeOwnClient", orgId, issuer);
      if (!ownClients.delete(`${orgId}|${issuer}`)) throw new MockNotFoundError("No client of yours for it");
    },
  };
}
