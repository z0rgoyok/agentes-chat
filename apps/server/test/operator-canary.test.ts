import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, type Database, eq, ne, rowsOf, schema, sql, tracingLogger } from "@agenteschat/db";
import {
  addRunStep,
  countComposio,
  countToolCall,
  enableOperatorEvents,
  grantScopes,
  type ToolSource,
} from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { poison } from "./canary";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/**
 * ADR 0056, "never content, never secrets", for every GET of the operator API at once.
 *
 * A workspace's history is made the way people make it, with "canary" in everything anyone wrote and in the secrets
 * seeded beside it. Every GET of the contract is then called with the read-only token, and no answer may say
 * "canary" or a secret the server made, nor name a field like one. Then every other text column of the database is
 * given a canary of its own, whatever its table, and the reads are called again: what an answer may carry is the
 * closed list in `KEPT`, so a read that starts returning another column fails here. So does a GET no call reaches,
 * and a table the reads query that this history leaves empty.
 */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const REVEAL = "operator-reveal-token-".padEnd(48, "x");
const UNKNOWN = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const WHY = "canary-why: the person asked for it and nothing else answers this.";
const CONFIDENTIAL_JOB_ERROR = "canary-confidential-job: what the run was writing";

/**
 * Stored text the reads return by design, as `table: columns` (`column.path` inside a JSON column): who and what
 * (names, addresses, handles), an error's first characters, and the kinds, states and codes the server itself
 * writes. Everything else that holds text gets a canary. Adding a column here says its text may leave the server.
 */
const KEPT: Record<string, string[]> = {
  users: ["email", "name", "blocked_reason"],
  sessions: ["ip_address", "user_agent"],
  organizations: [
    "name",
    "standing",
    "standing_reason",
    "standing_notice",
    "standing_note",
    "payer_user_id",
    "deletion_hold_reason",
  ],
  // `role` never comes back as stored: the reads work a member's role out from it. `outside_of`, here and on a join
  // request, is who an outside collaborator works for: only this API writes it, never the workspace (ADR 0191).
  organization_members: ["handle", "role", "outside_of"],
  // Not returned either: the database holds both to three words, which decide who may talk to an agent.
  channel_permission_overrides: ["allow", "deny"],
  organization_invitations: ["email"],
  organization_join_requests: ["email", "name", "status", "outside_of"],
  channels: ["name"],
  agents: [
    "name",
    "handle",
    "previous_handles",
    "builtin",
    "brain",
    "model",
    "brain_model",
    "approvals_level",
    "audience_mode",
    "operator_hold_reason",
  ],
  provider_credentials: ["provider"],
  machines: ["name", "kind", "runner_version", "executors.claude.version", "executors.browser.version"],
  machine_accounts: [
    "kind",
    "label",
    "provider",
    "auth_method",
    "plan",
    "status",
    "last_failure_cause",
    "usage.source",
  ],
  machine_provisioning: ["state", "step", "stage", "reason"],
  agent_runs: [
    "brain",
    "error",
    "transcript.waitingForBrain.code",
    "transcript.waitingForBrain.source",
    // The stages of a run's profile: named by the code that times them, counted by the work analytics.
    "profiles.stages.stage",
  ],
  agent_run_steps: [
    "data.name",
    "data.connector",
    "data.service",
    "data.code",
    "data.reason",
    "data.model",
    "data.stopReason",
    "data.data.code",
    "data.data.refusal",
  ],
  // The people an ask is for and who answered it, by their ids.
  approvals: ["tool", "decided_by_user_id", "owner_user_id", "approvers.userIds"],
  agent_questions: ["answered_by_user_id", "requested_for_user_id"],
  secret_requests: ["requested_for_user_id"],
  browser_handoffs: ["kind", "status"],
  // Never `details`: who did what to what. The server's own code names both, except a target with no id of its
  // own: that one goes by the name its workspace knows it by (a tool, a repository, a wiki folder).
  audit_log: ["actor_type", "actor_id", "action", "target_type", "target_id", "outcome", "on_behalf_of_user_id"],
  // Never `name`: one nobody named is called by its instructions' first line.
  routines: ["trigger_type", "cron", "timezone", "event", "paused_reason", "target.type"],
  routine_runs: ["trigger", "status", "code"],
  routing_decisions: ["strategy", "error"],
  // Of a payload, only which email a job sends.
  outbox: ["kind", "locked_by", "last_error", "payload.template.kind"],
  // What a notification tells of, who caused it and the ids it points at: never its words.
  notifications: ["kind", "group_key", "actors.type", "actors.id", "source.userId"],
  push_devices: ["platform"],
  usage_records: ["provider", "model", "billed_to"],
  messages: ["mentioned_user_ids"],
  // The feed's `data` is returned whole: only the server's own code writes it, and never what anyone wrote.
  operator_events: ["type", "user_id", "data"],
  waitlist_entries: ["email"],
  early_access_invitations: ["email"],
  signup_settings: ["mode"],
  claude_auth_settings: ["method", "rollout"],
  connector_usage_days: ["connector", "via", "tool"],
  composio_usage_days: ["toolkit", "action"],
  // A connection is the service it is of, what its workspace named it, its state and its last error's start.
  connector_connections: ["connector", "label", "auth_type", "status", "last_error"],
  mail_accounts: ["provider", "via", "preset", "label", "status", "last_error"],
  db_connections: ["label", "status", "last_error"],
  // A registered host and its look: only this API writes them, never a workspace (ADR 0194).
  hosts: ["host", "name", "accent"],
  // A server process's own vitals: only the process writes them, from its role, its release, its snapshot's name and
  // the patterns of its routes (as registered, ids left out).
  server_processes: ["role", "version", "heap_snapshot_file", "routes.route"],
};

/** The places the proof is about: each holds a canary before any read, and after every column got one. */
const PLACES: [what: string, table: string, value: string, where?: string][] = [
  ["a message's body", "messages", "body"],
  ["a step's tool input", "agent_run_steps", "data->>'input'", "kind = 'tool_call'"],
  ["a step's tool result", "agent_run_steps", "data->>'content'", "kind = 'tool_result'"],
  ["a memory", "context_items", "content"],
  ["an agent's instructions", "agents", "instructions"],
  ["a job's payload with a link", "outbox", "payload->'template'->>'url'"],
  ["an audit entry's details", "audit_log", "details::text"],
  ["an approval's parameters", "approvals", "params::text"],
  ["a question's text", "agent_questions", "text"],
  ["a routine's instructions", "routines", "prompt"],
  ["a routine's name", "routines", "name"],
  ["a credential", "provider_credentials", "secret_ciphertext"],
  ["a connection's credential", "connector_connections", "secret_ciphertext"],
  ["a session", "sessions", "token"],
  ["a verification code", "verifications", "value"],
  ["a push token", "push_devices", "token"],
  ["a notification's words", "notifications", "latest::text"],
  ["what a member wrote to ask for help", "support_requests", "text"],
  ["what the thing they reported says", "support_requests", "about"],
  [
    "the operator's reply to them, in the job of its email",
    "outbox",
    "payload->'template'->>'text'",
    "payload->'template'->>'kind' = 'support_reply'",
  ],
];

const TABLES = `
  select c.relname as "name" from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1`;

const tools: ToolSource = {
  name: "test-tools",
  tools: async () => [
    {
      name: "lookup",
      description: "Looks something up",
      scope: "test:read",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      describe: (input) => ({ title: `canary-title ${input.q}` }),
      execute: async () => ({ content: "canary-tool-result" }),
    },
    {
      name: "ship",
      description: "Ships it",
      scope: "test:write",
      sensitive: true,
      inputSchema: {
        type: "object",
        properties: { what: { type: "string" }, why: { type: "string" } },
        required: ["what"],
      },
      describe: () => ({ title: "canary-approval-title" }),
      execute: async () => ({ content: "canary-shipped" }),
    },
  ],
};

type Call = [path: string, status?: number];

let t: TestServer;
let owner: Browser;
let org: { orgId: string; channelId: string; agentId: string };
/** A GET with the read-only token. */
let get: (path: string) => Promise<Response>;
/** A call with another token: the full one's review blocks, the reveal token's door. */
let as: (token: string) => (path: string, json?: unknown) => Promise<Response>;
/** A failed run of a confidential thread (ADR 0190), the task it started, and a member's request for help. */
const confidential = { runId: "", taskId: "", requestId: "" };
/** Every GET of the committed contract, as its path's template. */
let contract: string[];
let calls: Call[];
/** What no answer may say, beside "canary": an address, a key, and the secrets the server made itself. */
const hidden = ["203.0.113.7", "sk-ant-api-secret-9876"];

/** Posts in #general, and the jobs it queued run (the agent answers). */
async function post(body: string) {
  const res = await owner(`/api/app/organizations/${org.orgId}/channels/${org.channelId}/messages`, { json: { body } });
  expect(res.status).toBe(201);
  await t.drain();
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  t = await createTestServer({
    env: { OPERATOR_API_TOKEN: TOKEN },
    toolSources: [tools],
    reply: (request) => {
      const last = JSON.stringify(request.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["canary-reply after its tool"] };
      if (last.includes("canary-ship")) {
        return { chunks: [], toolUses: [{ name: "ship", input: { what: "canary-ship-input", why: WHY } }] };
      }
      if (last.includes("canary-ask")) {
        return {
          chunks: [],
          toolUses: [{ name: "ask_user", input: { why: WHY, question: "canary-question?", choices: ["sim", "nao"] } }],
        };
      }
      if (last.includes("canary-look")) {
        return { chunks: [], toolUses: [{ name: "lookup", input: { q: "canary-tool-input" } }] };
      }
      return { chunks: ["canary-reply"] };
    },
  });
  // A server that provisions computers lists the workspaces waiting for one: the only read its setting changes.
  const config = { ...t.config, MACHINE_PROVISIONING: "external" as const };
  const app = createOperatorApp(
    { db: t.db, config, version: "test", log: createLogger("error"), emails: true },
    TOKEN,
    READ,
    REVEAL,
  );
  as = (token) => async (path, json) =>
    app.request(`/api/operator/v1${path}`, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(json ? { method: "POST", body: JSON.stringify(json) } : {}),
    });
  get = as(READ);
  const db = t.db;
  enableOperatorEvents();

  // The history: a mention answered with a tool, a question answered in the conversation, a message naming nobody,
  // a run left waiting on an approval, someone who joined by invitation and someone still invited.
  owner = browser(t);
  await signUp(owner, "owner@acme.test");
  org = await seedOrg(owner);
  const { orgId, agentId, channelId } = org;
  await grantScopes(db, orgId, agentId, [
    { connectionId: null, scope: "test:read" },
    { connectionId: null, scope: "test:write" },
  ]);
  const look = await post("@dev canary-look this up");
  await post("@dev canary-ask me first");
  await post("canary-yes");
  await post("canary-plain words for whoever");
  await post("@dev canary-ship it");
  await joinByInvitation(t, owner, orgId, "member@acme.test", { role: "admin" });
  const invited = await owner(`/api/app/organizations/${orgId}/invitations`, {
    json: { email: "invited@acme.test", roleIds: [] },
  });
  const link = ((await invited.json()) as { url: string }).url.split("/invite/")[1] ?? "";
  expect(link.length).toBeGreaterThan(20);
  hidden.push(link);
  const [run] = await db
    .select({ id: schema.agentRuns.id, orgId: schema.agentRuns.orgId })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.triggerMessageId, look));
  if (!run) throw new Error("no run for the first message");
  // What the time per task reads beside the runs: the ask's kind as Jev read it, and the long work it stepped into.
  await db.insert(schema.askKinds).values({ messageId: look, orgId, kind: "canary-kind words", p: 0.9 });
  const [work] = await db
    .insert(schema.agentWorks)
    .values({
      orgId,
      agentId,
      channelId,
      anchorMessageId: look,
      ownThread: true,
      title: "canary-work title",
      status: "live",
      how: "agent",
      lastUpdateAt: new Date(),
      lastUpdateText: "canary-work update",
    })
    .returning({ id: schema.agentWorks.id });
  await db
    .update(schema.agentRuns)
    .set({ workId: work?.id ?? null })
    .where(eq(schema.agentRuns.id, run.id));
  // Content, read the one way the API gives it: its `content.viewed` is in the feed the reads return.
  expect((await as(TOKEN)(`/review/run/${run.id}?reason=a%20report&operator=someone`)).status).toBe(200);

  // Steps the fake provider's turns don't write: a connector's call the gateway refused, and a provider's error.
  await addRunStep(db, run, "tool_call", {
    toolUseId: "call-1",
    name: "get_issue",
    input: { q: "canary-connector-input" },
    detail: "canary-detail",
    command: "canary-command",
    connector: "GitHub",
    service: "github",
  });
  await addRunStep(db, run, "tool_result", {
    toolUseId: "call-1",
    name: "get_issue",
    isError: true,
    content: "canary-refusal words",
    data: { code: "tool.not_allowed", refusal: "policy", note: "canary-result-data" },
  });
  await addRunStep(db, run, "error", {
    reason: "transient",
    code: "run.provider_rate_limit",
    message: "canary-error message",
  });
  // What the reads work facts out of: a failed result with a status, a pause's reading, a hand-on. Each holds words
  // where a number, a listed word or an id belongs.
  await addRunStep(db, run, "tool_call", { toolUseId: "call-3", name: "get_issue", input: "canary-input words" });
  await addRunStep(db, run, "tool_result", {
    toolUseId: "call-3",
    name: "get_issue",
    isError: true,
    content: "Tool failed: canary-failure words",
    data: { code: "tool.failed", status: "canary-status" },
  });
  await addRunStep(db, run, "error", {
    reason: "usage_wait",
    code: "usage_pause",
    message: "canary-pause words",
    pause: { source: "plan", used: "canary-used", window: "canary-window" },
  });
  await addRunStep(db, run, "error", { reason: "no_ai", code: "canary_reason" });
  await addRunStep(db, run, "context", {
    redispatchedMessageIds: [look],
    reason: "canary_reason",
    toRunId: "canary-run",
  });
  // A run parked on its plan's limit. An error's first characters are returned by design: a credential in them never.
  const failed = "connect failed: postgres://app:canary-pass@db.example.com/main";
  await db.update(schema.routingDecisions).set({ error: failed });
  await db.insert(schema.agentRuns).values({
    orgId,
    agentId,
    channelId,
    threadRootId: UNKNOWN,
    triggerMessageId: UNKNOWN,
    trigger: "mention",
    hop: 1,
    status: "waiting_input",
    error: failed,
    transcript: {
      system: "canary-prompt",
      waitingForBrain: {
        kind: "claude_code",
        machineId: "",
        code: "usage_pause",
        source: "plan",
        waitKey: "plan:canary-computer:claude_code:canary-account",
        resetsAt: new Date(Date.now() + 3600_000).toISOString(),
        plan: "canary-plan words",
        model: "canary-model",
      },
    },
  });
  // A run of a confidential thread (ADR 0190) that failed on what it read: its error's words are not returned, nor
  // what its steps hold, nor its job's error.
  const confidentialRoot = crypto.randomUUID();
  await db.insert(schema.confidentialThreads).values({ orgId, channelId, rootMessageId: confidentialRoot });
  const [confidentialRun] = await db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      threadRootId: confidentialRoot,
      triggerMessageId: confidentialRoot,
      trigger: "mention",
      hop: 1,
      status: "failed",
      error: "canary-confidential: what the run read",
    })
    .returning({ id: schema.agentRuns.id, orgId: schema.agentRuns.orgId });
  if (!confidentialRun) throw new Error("no confidential run");
  confidential.runId = confidentialRun.id;
  await addRunStep(db, confidentialRun, "tool_call", {
    toolUseId: "call-4",
    name: "get_issue",
    input: { q: "canary-confidential-input" },
  });
  await addRunStep(db, confidentialRun, "tool_result", {
    toolUseId: "call-4",
    name: "get_issue",
    isError: true,
    content: "canary-confidential-result",
  });
  await addRunStep(db, confidentialRun, "model_call", { narration: "canary-confidential-narration" });
  await addRunStep(db, confidentialRun, "error", { reason: "transient", message: "canary-confidential-message" });
  // Its job failed on a write: what a database answers then names the values the run was writing.
  await db.insert(schema.outbox).values({
    orgId,
    kind: "agent_run.execute",
    payload: { runId: confidentialRun.id },
    status: "failed",
    dedupeKey: `agent_run.execute:${confidentialRun.id}`,
    lastError: CONFIDENTIAL_JOB_ERROR,
  });

  // What the conversation didn't write, each with its canary.
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "owner@acme.test"));
  const ownerId = user?.id ?? "";
  const soon = new Date(Date.now() + 3600_000);
  await db.update(schema.organizations).set({ context: "canary context" }).where(eq(schema.organizations.id, orgId));
  await db.insert(schema.contextItems).values({
    orgId,
    agentId,
    kind: "note",
    scopeType: "agent",
    title: "canary memory title",
    content: "canary memory",
  });
  await db.insert(schema.hosts).values({ host: "app.northwind.example", name: "Northwind Studio", accent: "#7c3aed" });
  await db.insert(schema.serverProcesses).values({
    id: crypto.randomUUID(),
    role: "all",
    version: "test",
    startedAt: new Date(),
    seenAt: new Date(),
    rssBytes: 1,
    heapUsedBytes: 1,
    heapTotalBytes: 1,
    heapSnapshotAt: new Date(),
    heapSnapshotFile: "heap-all.heapsnapshot",
  });
  await db.insert(schema.auditLog).values({
    orgId,
    actorType: "agent",
    actorId: agentId,
    action: "tool.call",
    targetType: "tool",
    targetId: "lookup",
    details: { input: { q: "canary audit details" } },
  });
  // The three actions whose details the audit read looks into: words in every place it reads, and beside them.
  const changed = { orgId, actorType: "system" as const, targetType: "agent", targetId: agentId };
  await db.insert(schema.auditLog).values([
    {
      ...changed,
      action: "agent.audience_changed",
      details: {
        from: { mode: "canary-mode", userIds: ["canary-person"], roleIds: [] },
        to: { mode: "people", userIds: ["canary-other-person"], roleIds: ["canary-role"] },
        planOwner: "canary-owner",
        via: "canary-via",
      },
    },
    {
      ...changed,
      action: "connector.tool_definitions_changed",
      details: {
        connection: "canary-connection",
        tools: [{ tool: "canary_tool", descriptionBefore: "canary-before", descriptionAfter: "canary-after" }],
      },
    },
    {
      ...changed,
      action: "run.canceled",
      details: { agentId: "canary-agent", from: "canary-status", reason: "canary-reason words" },
    },
  ]);
  const sealed = { secretCiphertext: "canary-ciphertext", wrappedDataKey: "canary-wrapped", kekId: "local:v1" };
  await db
    .insert(schema.providerCredentials)
    .values({ ...sealed, orgId, provider: "openai", label: "canary credential label", keyHint: "canary-hint" });
  // What a workspace connected: a custom server (only its host is ever told) and its tools, a mailbox and a
  // database. A connection's label and its last error's first characters are returned by design.
  const [server] = await db
    .insert(schema.connectorConnections)
    .values({
      ...sealed,
      orgId,
      connector: "custom:canary-server",
      label: "Billing server",
      serverUrl: "https://mcp.example.com/canary-path?access=canary-access",
      authType: "api_key",
      toolPrefix: "canary_prefix",
      accountLabel: "canary account",
      lastError: failed,
    })
    .returning({ id: schema.connectorConnections.id });
  await db.insert(schema.customTools).values({
    orgId,
    connectionId: server?.id ?? "",
    name: "canary_tool",
    description: "canary tool description",
    label: "canary tool label",
    access: "read",
  });
  await db.insert(schema.mailAccounts).values({
    ...sealed,
    orgId,
    provider: "gmail",
    via: "composio",
    address: "canary-mailbox@example.com",
    label: "Support",
    status: "active",
    lastError: failed,
    username: "canary-user",
  });
  await db.insert(schema.dbConnections).values({
    ...sealed,
    orgId,
    label: "Production",
    host: "canary-db.example.com",
    database: "canary_db",
    username: "canary_user",
    lastError: failed,
  });
  await db.insert(schema.secretRequests).values({
    orgId,
    runId: run.id,
    agentId,
    channelId,
    toolUseId: "call-2",
    requestedForUserId: ownerId,
    name: "CANARY_NAME",
    label: "canary secret label",
    purpose: "canary purpose",
    targetKind: "env",
    publicKey: "canary-public",
    expiresAt: soon,
  });
  await db
    .insert(schema.sessions)
    .values({ id: "canary-session-id", token: "canary-session", userId: ownerId, expiresAt: soon });
  await db.insert(schema.verifications).values({
    id: "canary-verification-id",
    identifier: "canary-identifier",
    value: "canary-code",
    expiresAt: soon,
  });
  await db.insert(schema.pushDevices).values({ userId: ownerId, token: "canary-push", platform: "ios", locale: "en" });
  await db.insert(schema.outbox).values({
    orgId,
    kind: "email.send",
    payload: {
      key: "canary-email",
      to: ["canary@example.com"],
      template: { kind: "invitation", orgName: "canary org", url: "https://example.com/invite/canary-link" },
    },
    dedupeKey: "email:canary-address",
    lastError: failed,
    nextAttemptAt: soon,
  });
  await db.insert(schema.organizationJoinRequests).values({
    orgId,
    email: "ask@example.com",
    name: "Asker",
    note: "canary request note",
    passwordHash: "canary-password-hash",
    claimHash: "canary-claim-hash",
    expiresAt: soon,
  });
  // Outside collaborators (ADR 0191): one waiting for an answer, one in.
  await db.insert(schema.organizationJoinRequests).values({
    orgId,
    userId: ownerId,
    email: "outside@example.com",
    name: "Outsider",
    note: "canary outside note",
    outsideOf: "Example Consulting",
    expiresAt: soon,
  });
  await db
    .update(schema.organizationMembers)
    .set({ outsideOf: "Example Consulting" })
    .where(and(eq(schema.organizationMembers.orgId, orgId), ne(schema.organizationMembers.userId, ownerId)));
  await db
    .insert(schema.waitlistEntries)
    .values({ email: "waiting@example.com", confirmedAt: new Date(), confirmTokenHash: "canary-confirm-hash" });
  await db
    .insert(schema.earlyAccessInvitations)
    .values({ email: "early@example.com", tokenHash: "canary-early-hash", sentAt: new Date(), expiresAt: soon });

  // The agent's computer and what is on it, its sign-in to a plan, and what the agent has.
  const [box] = await db
    .insert(schema.machines)
    .values({
      orgId,
      kind: "managed",
      name: "Box",
      tokenHash: "canary-machine-hash",
      hostKey: "canary-host-mark",
      hostname: "canary-host",
      workspace: "/home/canary/agents",
      runnerVersion: "1.2.3",
      protocol: 50,
      online: true,
      lastSeenAt: new Date(),
      executors: {
        claude: { version: "2.0.31 (Claude Code)", loggedIn: true, authMethod: "canary-auth", plan: "canary-plan" },
        browser: { available: true, version: "0.9.1", reason: "canary reason" },
      },
      access: {
        folders: [{ path: "/canary/folder", agents: [] }],
        tools: { claude: true, codex: true, commands: true },
      },
      egress: { ip: "203.0.113.7", at: new Date().toISOString() },
    })
    .returning({ id: schema.machines.id });
  const machineId = box?.id ?? "";
  const accountId = crypto.randomUUID();
  await db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId,
    machineId,
    kind: "claude_code",
    label: "Work plan",
    email: "canary-plan@example.com",
    keyHint: "canary-hint",
    orgName: "canary org name",
    providerOrgId: "canary-provider-org",
    plan: "max",
    authMethod: "setup_token",
    lastFailureCause: "auth_rejected",
    lastFailureAt: new Date(),
    usage: {
      windows: [{ kind: "five_hour", label: "canary window", usedPercent: 40 }],
      source: "turn",
      at: new Date().toISOString(),
      answered: "canary-answered",
    },
  });
  await db.insert(schema.machineProvisioning).values({
    orgId,
    state: "ready",
    since: new Date(),
    specs: { cpus: 4, memoryGb: 8, diskGb: 100 },
  });
  await db.insert(schema.machineTasks).values({
    orgId,
    agentId,
    machineId,
    channelId,
    title: "canary task",
    executor: "claude",
    command: "canary command",
    prompt: "canary prompt",
    lastLine: "canary line",
    status: "running",
  });
  const [confidentialTask] = await db
    .insert(schema.machineTasks)
    .values({
      orgId,
      agentId,
      machineId,
      channelId,
      runId: confidential.runId,
      title: "canary confidential task",
      executor: "claude",
      command: "canary confidential command",
      prompt: "canary confidential prompt",
      result: "canary confidential result",
      lastLine: "canary confidential line",
      recentLines: ["canary confidential lines"],
      files: ["canary/confidential.txt"],
      status: "done",
    })
    .returning({ id: schema.machineTasks.id });
  confidential.taskId = confidentialTask?.id ?? "";
  await db
    .insert(schema.machineHolds)
    .values({ orgId, agentId, machineId, what: "canary hold", why: "canary hold reason" });
  await db
    .update(schema.agents)
    .set({
      instructions: "canary instructions",
      machineId,
      brainAccountId: accountId,
      operatorHoldAt: new Date(),
      operatorHoldReason: "spam",
    })
    .where(eq(schema.agents.id, agentId));
  const [skill] = await db
    .insert(schema.skills)
    .values({
      orgId,
      slug: "deploys",
      name: "canary skill",
      description: "canary skill description",
      body: "canary skill body",
      source: "manual",
    })
    .returning({ id: schema.skills.id });
  await db.insert(schema.agentSkills).values({ orgId, agentId, skillId: skill?.id ?? "" });
  // Routines made the way people make them, nobody naming one: the server calls each by its instructions' first line.
  const unnamed = await owner(`/api/app/organizations/${orgId}/routines`, {
    json: {
      agentId,
      prompt: "canary routine nobody named",
      target: { type: "channel", channelId },
      trigger: { type: "once", at: soon.toISOString() },
    },
  });
  const reminder = await owner(`/api/app/organizations/${orgId}/reminders`, {
    json: { channelId, agentId, at: soon.toISOString(), text: "canary reminder" },
  });
  expect([unnamed.status, reminder.status]).toEqual([201, 201]);
  // Never a routine's name, its instructions, the words of its schedule nor its firings' reports.
  const [routine] = await db
    .insert(schema.routines)
    .values({
      orgId,
      agentId,
      name: "canary routine name",
      prompt: "canary routine prompt",
      target: { type: "dm", note: "canary target" },
      triggerType: "schedule",
      phrase: "canary every morning",
      description: "canary schedule",
      cron: "0 9 * * *",
      timezone: "America/Sao_Paulo",
      rule: { freq: "daily", timezone: "America/Sao_Paulo", note: "canary rule" },
      pausedReason: "creator_no_access",
    })
    .returning({ id: schema.routines.id });
  await db.insert(schema.routineRuns).values({
    orgId,
    routineId: routine?.id ?? "",
    at: new Date(),
    trigger: "event",
    status: "failed",
    code: "error",
    summary: "canary summary",
    event: { body: "canary event" },
    dedupeKey: "canary-delivery",
    agentRunId: run.id,
  });
  await db.insert(schema.agentConsultations).values({
    orgId,
    askerRunId: run.id,
    askerAgentId: agentId,
    targetAgentId: agentId,
    channelId,
    messageId: crypto.randomUUID(),
    waitId: "canary-wait",
    question: "canary consultation",
    chain: [agentId],
    answer: "canary consultation answer",
    expiresAt: soon,
  });
  const person = { createdByType: "person", createdById: ownerId } as const;
  const [task] = await db
    .insert(schema.issues)
    .values({ ...person, orgId, number: 7, title: "canary task title", description: "canary task description" })
    .returning({ id: schema.issues.id });
  const [file] = await db
    .insert(schema.artifacts)
    .values({
      ...person,
      orgId,
      kind: "document",
      title: "canary file title",
      excerpt: "canary excerpt",
      channelId,
      updatedByType: "person",
      updatedById: ownerId,
    })
    .returning({ id: schema.artifacts.id });
  // What a workspace's meters, the connectors' counts and its computer's activity read, and the operator's settings.
  await db.insert(schema.artifactVersions).values({
    orgId,
    artifactId: file?.id ?? "",
    version: 1,
    blobKey: "canary-blob",
    contentType: "text/plain",
    size: 12,
    sha256: "canary-digest",
    fileName: "canary-file.txt",
    note: "canary version note",
    authorType: "person",
    authorId: ownerId,
  });
  // A live file's document and a picture in it (ADR 0196): its meters read their sizes, never what they hold.
  await db.insert(schema.liveDocs).values({
    orgId,
    artifactId: file?.id ?? "",
    kind: "document",
    state: "canary-live-state",
    stateBytes: 17,
    editedByType: "person",
    editedById: ownerId,
  });
  await db.insert(schema.liveAssets).values({
    id: crypto.randomUUID(),
    orgId,
    artifactId: file?.id ?? "",
    blobKey: "canary-live-blob",
    contentType: "image/png",
    size: 12,
    sha256: "canary-live-digest",
    source: "upload",
    origin: { url: "https://example.com/canary-live-picture.png", credit: "canary credit" },
    createdByType: "person",
    createdById: ownerId,
  });
  await db.insert(schema.skillFiles).values({
    orgId,
    skillId: skill?.id ?? "",
    version: 1,
    path: "canary/notes.md",
    size: 5,
    mime: "text/markdown",
    status: "stored",
    blobKey: "canary-skill-blob",
  });
  await db.insert(schema.storageConfigs).values({
    ...sealed,
    orgId,
    kind: "s3",
    options: { bucket: "canary-bucket", endpoint: "https://canary.example.com" },
    accessKeyHint: "canary-hint",
    secretHint: "canary-hint",
    fingerprint: "canary-fingerprint",
    status: "inactive",
  });
  await db.insert(schema.voiceClips).values({
    orgId,
    channelId,
    userId: ownerId,
    clientId: "canary-client",
    blobKey: "canary-voice-blob",
    contentType: "audio/webm",
    size: 10,
    durationMs: 1000,
    peaks: [1, 2],
  });
  await db.insert(schema.browserHandoffs).values({
    orgId,
    agentId,
    machineId,
    kind: "ask",
    instructions: "canary handoff instructions",
    note: "canary handoff note",
    expiresAt: soon,
  });
  await db.insert(schema.notifications).values({
    orgId,
    userId: ownerId,
    kind: "mention",
    groupKey: `mention:${look}`,
    actors: [{ type: "user", id: ownerId }],
    source: { channelId, messageId: look, userId: ownerId, label: "canary source label" },
    latest: { text: "canary notification", title: "canary notification title" },
  });
  await db.insert(schema.deviceAccessRequests).values({
    orgId,
    machineId,
    requesterUserId: ownerId,
    agentId,
    reason: "canary device reason",
    expiresAt: soon,
  });
  // A member's request for help, with its words kept as on a server that lets its operator read them.
  const [asked] = await db
    .insert(schema.supportRequests)
    .values({
      orgId,
      userId: ownerId,
      source: "form",
      ref: "canary-ref",
      aboutKind: "message",
      messageId: look,
      text: "canary request words",
      about: "canary reported words",
    })
    .returning({ id: schema.supportRequests.id });
  confidential.requestId = asked?.id ?? "";
  await db
    .insert(schema.githubAppInstallations)
    .values({ orgId, installationId: 1, accountLogin: "canary-login", accountType: "Organization" });
  await db.insert(schema.channelPermissionOverrides).values({ orgId, channelId, userId: ownerId, deny: ["post"] });
  await db.insert(schema.signupSettings).values({ mode: "invite" });
  await db.insert(schema.claudeAuthSettings).values({ method: "setup_token" });
  await countToolCall(db, { orgId, agentId, connector: { key: "github", via: "mcp", tool: "get_issue" }, calls: 2 });
  await countComposio(db, { orgId, toolkit: "gmail", action: "GMAIL_FETCH_EMAILS", executions: 1 });

  // A workspace its owner is deleting and the operator holds, and one still waiting for its computer.
  await db.insert(schema.organizations).values({
    name: "Leaving",
    deletionDueAt: soon,
    deletionRequestedAt: new Date(),
    deletionRequestedBy: ownerId,
    deletionHoldAt: new Date(),
    deletionHoldReason: "a report",
  });
  const [waiting] = await db
    .insert(schema.organizations)
    .values({ name: "Waiting" })
    .returning({ id: schema.organizations.id });
  await db.insert(schema.organizationMembers).values({ orgId: waiting?.id ?? "", userId: ownerId, role: "owner" });
  await db
    .insert(schema.machineProvisioning)
    .values({ orgId: waiting?.id ?? "", state: "preparing", step: "installing", stage: "apps", since: new Date() });

  // The operator answered that request in its own words: until the email goes out, its job holds them.
  const replied = await as(REVEAL)(`/reveal/orgs/${orgId}/replies`, {
    requestId: confidential.requestId,
    text: "canary reply words",
    operator: "someone",
    assistedByAi: true,
  });
  expect(replied.status).toBe(200);

  // The secrets the server made itself, as it stored them.
  for (const s of await db.select({ token: schema.sessions.token }).from(schema.sessions)) hidden.push(s.token);
  for (const a of await db.select({ password: schema.accounts.password }).from(schema.accounts)) {
    if (a.password) hidden.push(a.password);
  }
  hidden.push(t.config.AGENTES_SECRET, TOKEN);

  const doc = (await (await as(TOKEN)("/openapi.json")).json()) as { paths: Record<string, { get?: unknown }> };
  contract = Object.entries(doc.paths).flatMap(([path, methods]) => (methods.get ? [path] : []));

  const ids = async (rows: PromiseLike<{ id: string }[]>) => (await rows).map((r) => r.id);
  const [orgs, users, agents, machines, runs, messages] = await Promise.all([
    ids(db.select({ id: schema.organizations.id }).from(schema.organizations)),
    ids(db.select({ id: schema.users.id }).from(schema.users)),
    ids(db.select({ id: schema.agents.id }).from(schema.agents)),
    ids(db.select({ id: schema.machines.id }).from(schema.machines)),
    ids(db.select({ id: schema.agentRuns.id }).from(schema.agentRuns)),
    ids(db.select({ id: schema.messages.id }).from(schema.messages)),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const days = `from=${today}&to=${today}`;
  const hours = `from=${new Date(Date.now() - 3600_000).toISOString()}&to=${new Date(Date.now() + 3600_000).toISOString()}`;
  const ref = (text: string, inOrg = true) =>
    `/resolve?ref=${encodeURIComponent(text)}${inOrg ? `&orgId=${orgId}` : ""}`;
  const review = "reason=a%20report&operator=someone";
  const paths = [
    "/openapi.json",
    "/health",
    "/vitals",
    "/storage",
    "/orgs?limit=200",
    "/orgs?q=acme",
    "/events",
    "/machine-requests?limit=200",
    "/signup",
    "/waitlist",
    "/waitlist/next?limit=200",
    "/early-access/invitations?limit=200",
    `/analytics?${days}`,
    `/analytics/connectors/github?${days}`,
    `/analytics/connectors/gmail?${days}`,
    `/analytics/work?${days}`,
    ...["brain", "model"].map((by) => `/analytics/run-timings?${hours}&by=${by}`),
    `/analytics/run-timings?${hours}&orgId=${orgId}&agentId=${agentId}`,
    ...["hour", "day"].map((bucket) => `/analytics/reply-times?${hours}&bucket=${bucket}`),
    `/analytics/asks?${hours}&bucket=hour`,
    `/analytics/asks?${hours}&orgId=${orgId}`,
    `/analytics/stage-breakdown?${hours}`,
    `/analytics/stage-breakdown?${hours}&orgId=${orgId}`,
    `/cli-runs?${hours}`,
    `/analytics/ai-accounts?${days}`,
    "/ai-accounts?limit=200",
    "/claude-auth",
    "/hosts",
    "/users?q=acme&limit=200",
    "/users?email=owner%40acme.test",
    "/jobs?limit=200",
    "/jobs?summary=true",
    "/jobs?stuck=true",
    `/jobs?orgId=${orgId}&kind=email.send`,
    // By the address as it was written, and as it reads once every text column holds a canary.
    "/email-jobs?to=canary%40example.com",
    "/email-jobs?to=canary.outbox.payload.to&limit=200",
    "/usage",
    ...["agent", "day", "hour", "model", "provider", "payer"].map((by) => `/usage?orgId=${orgId}&groupBy=${by}`),
    `/usage?agentId=${agentId}`,
    ...orgs.flatMap((id) => [
      `/orgs/${id}`,
      `/orgs/${id}/members?limit=200`,
      `/orgs/${id}/outside-access`,
      `/orgs/${id}/channels?limit=200`,
      `/orgs/${id}/agents?limit=200`,
      `/orgs/${id}/machines`,
      `/orgs/${id}/claude-auth`,
      `/orgs/${id}/runs?limit=200`,
      `/orgs/${id}/runs?groupBy=error`,
      `/orgs/${id}/tool-calls?limit=200`,
      ...["tool", "agent", "outcome"].map((by) => `/orgs/${id}/tool-calls?groupBy=${by}`),
      ...["connections", "audit", "asks", "routines", "unanswered", "support-requests"].map(
        (list) => `/orgs/${id}/${list}?limit=200`,
      ),
      `/orgs/${id}/unanswered?summary=true`,
      `/analytics/work/orgs/${id}?${days}`,
    ]),
    // Each person's notifications, and whether they reach one thing of each kind.
    ...users.flatMap((id) => [
      `/orgs/${orgId}/notifications?userId=${id}&limit=200`,
      ...Object.entries({
        agent: agentId,
        channel: channelId,
        task: task?.id,
        file: file?.id,
        computer: machineId,
      }).map(([kind, target]) => `/orgs/${orgId}/access?userId=${id}&targetKind=${kind}&targetId=${target}`),
    ]),
    `/orgs/${orgId}/notifications?userId=${ownerId}&kind=mention&from=2020-01-01T00:00:00Z`,
    `/orgs/${orgId}/unanswered?channelId=${channelId}&outcome=nobody_picked`,
    ...users.flatMap((id) => [`/users/${id}`, ref(id, false)]),
    ...agents.map((id) => `/agents/${id}`),
    ...machines.map((id) => `/machines/${id}`),
    ...runs.flatMap((id) => [`/runs/${id}/trace`, `/usage?runId=${id}`, `/jobs?runId=${id}`, ref(id)]),
    `/orgs/${orgId}/tool-calls?runId=${run.id}&tool=get`,
    `/orgs/${orgId}/audit?action=tool.&actorType=agent&actorId=${agentId}&targetType=tool&targetId=lookup`,
    `/orgs/${orgId}/audit?runId=${run.id}&from=2020-01-01T00:00:00Z`,
    `/orgs/${orgId}/asks?open=true&agentId=${agentId}`,
    ...["approval", "question", "secret", "handoff", "consultation"].map((kind) => `/orgs/${orgId}/asks?kind=${kind}`),
    `/orgs/${orgId}/asks?runId=${run.id}&open=false`,
    `/orgs/${orgId}/routines?agentId=${agentId}`,
    ...messages.map((id) => `/messages/${id}/explain`),
    `/orgs/${orgId}/timeline?channelId=${channelId}&limit=200`,
    `/orgs/${orgId}/timeline?messageId=${look}`,
    // What a report quotes, in each form it is read.
    ref(`/org/${orgId}/c/${channelId}?m=${look}`, false),
    ref(`https://example.com/org/${orgId}/drive?artifact=${file?.id}`, false),
    ref("@dev"),
    ref("@owner"),
    ref("#general"),
    ref("#7"),
    ref(agentId.slice(0, 8)),
    ...[orgId, agentId, channelId, look, task?.id, file?.id, machineId, accountId].map((id) => ref(id ?? "", false)),
  ];
  calls = [
    ...paths.map((path): Call => [path]),
    // The read-only token never opens content.
    ...["run", "task", "session"].map((kind): Call => [`/review/${kind}/${run.id}?${review}`, 403]),
    // Refusals answer in words of their own, never with what is stored.
    [`/orgs/${UNKNOWN}`, 404],
    ["/users/nobody", 404],
    [`/agents/${UNKNOWN}`, 404],
    [`/machines/${UNKNOWN}`, 404],
    [`/runs/${UNKNOWN}/trace`, 404],
    [`/messages/${UNKNOWN}/explain`, 404],
    [`/orgs/${orgId}/timeline?messageId=${UNKNOWN}`, 404],
    [`/orgs/${orgId}/timeline`, 400],
    [`/orgs/${orgId}/tool-calls?runId=${UNKNOWN}`, 404],
    [`/orgs/${orgId}/tool-calls?outcome=maybe`, 400],
    ...["connections", "audit", "asks", "routines", "support-requests", "outside-access"].map(
      (list): Call => [`/orgs/${UNKNOWN}/${list}`, 404],
    ),
    [`/orgs/${orgId}/support-requests?cursor=nope`, 400],
    [`/orgs/${orgId}/connections?cursor=nope`, 400],
    [`/orgs/${orgId}/audit?from=yesterday`, 400],
    [`/orgs/${orgId}/asks?kind=wish`, 400],
    [`/orgs/${orgId}/routines?agentId=nope`, 400],
    [`/orgs/${UNKNOWN}/notifications?userId=${ownerId}`, 404],
    [`/orgs/${orgId}/notifications?userId=nobody`, 404],
    [`/orgs/${orgId}/notifications`, 400],
    [`/orgs/${orgId}/access?userId=${ownerId}&targetKind=agent&targetId=${UNKNOWN}`, 404],
    [`/orgs/${orgId}/access?userId=${ownerId}&targetKind=wiki&targetId=${agentId}`, 400],
    [`/orgs/${UNKNOWN}/unanswered`, 404],
    [`/orgs/${orgId}/unanswered?outcome=run`, 400],
    ["/email-jobs", 400],
    ["/users", 400],
    [ref("two words"), 400],
    [ref("@dev", false), 400],
    ["/usage?from=2020-01-01T00:00:00Z", 400],
    ["/jobs?stuck=maybe", 400],
    ["/events?after=nope", 400],
    ["/analytics", 400],
    [`/analytics/run-timings?${days}`, 400],
    [`/analytics/reply-times?${days}`, 400],
    [`/cli-runs?${days}`, 400],
    ["/nope", 404],
  ];
});

afterAll(async () => {
  enableOperatorEvents(false);
  await t.close();
});

/** The places of `PLACES` that hold no canary. */
async function unmarked() {
  const none: string[] = [];
  for (const [what, table, value, where] of PLACES) {
    const found = `select 1 from ${table} where ${value} like '%canary%'${where ? ` and ${where}` : ""} limit 1`;
    if (rowsOf(await t.db.execute(sql.raw(found))).length === 0) none.push(what);
  }
  return none;
}

function* keysOf(value: unknown): Generator<string> {
  if (!value || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    if (!Array.isArray(value)) yield key;
    yield* keysOf(inner);
  }
}

const SECRET_NAME = /token|password|secret|hash|cipher|key/i;
// Counts, named after what they count: tokens spent, and sign-ins by their method.
const COUNTED = new Set(["tokens", "setup_token", "api_key"]);

/**
 * Calls every read: which answered another status than its own, what was said that is hidden (and by which call
 * first), which fields are named like a secret, which GET of the contract no call reached, and which tables the
 * reads queried that hold no row.
 */
async function readEverything() {
  const wrong: Record<string, number> = {};
  const said: Record<string, string> = {};
  const named: Record<string, string> = {};
  const reached: string[] = [];
  const read = new Set<string>();
  const counts = tracingLogger.logQuery;
  tracingLogger.logQuery = (query?: string) => {
    for (const [, name] of (query ?? "").matchAll(/\b(?:from|join)\s+"?(\w+)/gi)) if (name) read.add(name);
    counts();
  };
  try {
    for (const [path, status = 200] of calls) {
      const res = await get(path);
      const text = await res.text();
      if (res.status !== status) wrong[path] = res.status;
      else if (status === 200 || status === 403) reached.push(path.split("?")[0] ?? "");
      for (const word of [...(text.match(/canary[^"\\\s]*/gi) ?? []), ...hidden.filter((h) => text.includes(h))]) {
        said[word.replace(/\.r\d+$/, "")] ??= path;
      }
      // The contract itself names its fields' types, not anyone's data.
      if (path === "/openapi.json") continue;
      for (const key of keysOf(JSON.parse(text))) if (SECRET_NAME.test(key) && !COUNTED.has(key)) named[key] ??= path;
    }
  } finally {
    tracingLogger.logQuery = counts;
  }
  const uncalled = contract.filter(
    (template) => !reached.some((p) => new RegExp(`^${template.replace(/\{\w+\}/g, "[^/]+")}$`).test(p)),
  );
  // A table the reads query and this history leaves empty is under no canary: whoever reads it seeds it here.
  const unseeded: string[] = [];
  for (const { name } of rowsOf<{ name: string }>(await t.db.execute(sql.raw(TABLES)))) {
    if (read.has(name) && rowsOf(await t.db.execute(sql.raw(`select 1 from "${name}" limit 1`))).length === 0) {
      unseeded.push(name);
    }
  }
  return { wrong, said, named, uncalled, unseeded };
}

const NOTHING = { wrong: {}, said: {}, named: {}, uncalled: [], unseeded: [] };

test("no GET says what anyone wrote or a secret, as the history was written", async () => {
  expect(contract.length).toBeGreaterThan(25);
  expect(await unmarked()).toEqual([]);
  expect(await readEverything()).toEqual(NOTHING);
});

test("a confidential thread's run: what its steps and the task it started hold is in no review block and behind no proof of the reveal door", async () => {
  const review = "reason=a%20report&operator=someone";
  const blocks = [`/review/run/${confidential.runId}?${review}`, `/review/task/${confidential.taskId}?${review}`];
  const asking = { reason: "Check what the run was doing when it failed", operator: "someone", assistedByAi: true };
  const records = [
    ...["input", "result", "narration", "error"].map((field, n) => ({
      kind: "run_step",
      id: confidential.runId,
      seq: n + 1,
      field,
    })),
    ...["command", "prompt", "result"].map((field) => ({ kind: "task", id: confidential.taskId, field })),
  ];
  const proofs = [
    { purpose: "fault", runId: confidential.runId },
    { purpose: "member_request", requestId: confidential.requestId },
  ];
  const said = (text: string) => text.match(/canary[^"\\\s]*/gi) ?? [];
  const answers: Record<string, unknown> = {};
  for (const path of blocks) {
    const res = await as(TOKEN)(path);
    answers[path] = [res.status, said(await res.text())];
  }
  for (const proof of proofs) {
    for (const record of records) {
      const res = await as(REVEAL)(`/reveal/orgs/${org.orgId}`, { ...asking, ...record, ...proof });
      const text = await res.text();
      const code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
      answers[`${proof.purpose} ${record.kind}.${record.field}`] = [res.status, code, said(text)];
    }
  }
  expect(answers).toEqual({
    ...Object.fromEntries(blocks.map((path) => [path, [200, []]])),
    ...Object.fromEntries(
      proofs.flatMap((proof) =>
        records.map((record) => [`${proof.purpose} ${record.kind}.${record.field}`, [403, "reveal.confidential", []]]),
      ),
    ),
  });
});

test("no GET says anything else the database holds: a canary in every other text column, and none comes back", async () => {
  expect(await poison(t.db, KEPT)).toBeGreaterThan(500);
  // A run's job is its run's by its name alone, and its name is text: the confidential run's job gets its own back.
  await t.db
    .update(schema.outbox)
    .set({ dedupeKey: `agent_run.execute:${confidential.runId}` })
    .where(eq(schema.outbox.lastError, CONFIDENTIAL_JOB_ERROR));
  expect(await unmarked()).toEqual([]);
  expect(await readEverything()).toEqual(NOTHING);
});
