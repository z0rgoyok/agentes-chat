import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  CONFIDENTIAL_OUTBOUND,
  createAgentStyleToolSource,
  createApprovalRequestToolSource,
  createChannel,
  createCoAuthorToolSource,
  createFeedbackToolSource,
  createReleaseAsksToolSource,
  createSetStatusToolSource,
  createSetupToolSource,
  createTeamStatusToolSource,
  createToolGateway,
  createUsageToolSource,
  createWebToolSource,
  createWithdrawRequestToolSource,
  createWorkspaceToolSource,
  decideApproval,
  grantScopes,
  markThreadConfidential,
  postPersonMessage,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
} from "../src";
import type { RunAuthority } from "../src/authority";
import { onlySafetyRefusals, SAFETY_TAG, triedCalls } from "../src/continuation";
import { asksOutside, confidentialLockAllows } from "../src/tools/confidential-lock";
import { closeWorlds } from "./autonomy/harness";
import { CANARY, type VaultWorld, vaultWorld } from "./confidential-fixtures";

// ADR 0190: after a run read a confidential result, it and every later run of its thread keep a short list of tools
// by name and are refused every other, with a code the turn's judge reads as final.

afterEach(closeWorlds);

const READ = { name: "vault_read_record", input: { id: "r1" } };

/** A tool nobody listed anywhere: what a tool added later looks like to the lock. */
const brandNew: ToolSource = {
  name: "new",
  tools: async () => [
    {
      name: "brand_new_tool",
      description: "A tool added after the lock's list was written.",
      inputSchema: { type: "object" },
      scope: "",
      execute: async () => ({ content: "ran" }),
    },
  ],
};

/** Every tool source that needs nothing a test can't give, beside the ones the fixture's options add. */
const extraSources = (): ToolSource[] => [
  createWebToolSource({ fetch: async () => new Response("page"), resolveHost: async () => ["93.184.216.34"] }),
  createSetStatusToolSource(),
  createWithdrawRequestToolSource(),
  createReleaseAsksToolSource(),
  createApprovalRequestToolSource(),
  createUsageToolSource(),
  createWorkspaceToolSource({}),
  createAgentStyleToolSource(),
  createCoAuthorToolSource(),
  createTeamStatusToolSource(),
  createSetupToolSource({}),
  createFeedbackToolSource({ to: "feedback@example.com" } as Parameters<typeof createFeedbackToolSource>[0]),
  brandNew,
];

const EVERY_TOOL = {
  contextTools: true,
  permissionTools: true,
  mediaTools: true,
  artifactTools: true,
  blockTools: true,
  calendarTools: true,
  skillTools: true,
  wikiTools: true,
  machines: true,
  missionTools: true,
  workTools: true,
} as const;

const SCOPES = ["sandbox:run", "browser:use", "desktop:use", "issues:write", "setup:write"];

async function grantAll(w: VaultWorld) {
  await grantScopes(
    w.db,
    w.org.id,
    w.agents.kai?.id ?? "",
    SCOPES.map((scope) => ({ connectionId: null, scope })),
  );
}

/** What the lock keeps of the tools this fixture lists, by name. Adding a name here is a decision, not a fix. */
const KEPT = [
  // In the run's own conversation.
  "ask_choices",
  "ask_user",
  "cancel_follow_up",
  "follow_up",
  "react",
  "release_waiting_agent",
  "send_sticker",
  "show_block",
  "start_poll",
  // On the run or its agent alone.
  "commit_co_author",
  "set_reply_style",
  // Built-in reads whose words stay on the server or the agent's own computer.
  "computer_status",
  "expand",
  "find_agent",
  "get_my_usage",
  "get_summary",
  "list_artifacts",
  "list_files",
  "list_issues",
  "list_reminders",
  "list_routines",
  "load_skill",
  "read_artifact",
  "read_conversation",
  "read_file",
  "read_skill_file",
  "read_wiki_page",
  "search_context",
  // Every tool of the connection that set the mark, its write too.
  "vault_change_record",
  "vault_list_records",
  "vault_read_record",
];

describe("the list", () => {
  test("of every tool an agent is listed, a run of a confidential thread keeps exactly these names; one added with no entry is refused", async () => {
    const w = await vaultWorld({ agents: ["kai"], setup: { ...EVERY_TOOL, toolSources: extraSources() } });
    await grantAll(w);
    const asked = await w.say("x");
    const [run] = await w.db
      .insert(schema.agentRuns)
      .values({
        orgId: w.org.id,
        agentId: w.agents.kai?.id ?? "",
        channelId: w.channelId,
        threadRootId: asked.id,
        triggerMessageId: asked.id,
        trigger: "mention",
        hop: 1,
        status: "running",
        brain: "model",
      })
      .returning();
    const ctx: ToolContext = {
      db: w.db,
      orgId: w.org.id,
      agentId: w.agents.kai?.id ?? "",
      runId: run?.id ?? "",
      channelId: w.channelId,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
    };
    const listed = (await w.f.tools?.granted(ctx)) ?? [];
    const names = listed.map((t) => t.name);
    // The fixture really lists the tools this test is about.
    for (const name of ["post_message", "remember", "run_code", "web_fetch", "set_status", "brand_new_tool"])
      expect(names).toContain(name);
    expect(listed.length).toBeGreaterThan(80);
    const kept = listed
      .filter((t) => confidentialLockAllows(t, { own: !t.connectionId, marking: [w.connectionId], asksOutside: false }))
      .map((t) => t.name)
      .sort();
    expect(kept).toEqual([...KEPT].sort());
  });

  const tool = (name: string, scope = "", more: Partial<ToolDefinition> = {}): ToolDefinition => ({
    name,
    scope,
    description: name,
    inputSchema: { type: "object" },
    execute: async () => ({ content: "" }),
    ...more,
  });
  const other = { connectionId: "5f0e0f9e-0000-4000-8000-000000000001" };
  const marking = "5f0e0f9e-0000-4000-8000-000000000002";
  const at = (asksOut = false) => ({ own: false, marking: [marking], asksOutside: asksOut });
  const routine = (channelId: string, threadId: string | null = null) =>
    ({ kind: "routine", brief: { deliverTo: { channelId, threadId } } }) as unknown as RunAuthority;

  test("tools whose sources a test can't build, by the names and scopes they are listed with", () => {
    const refused: ToolDefinition[] = [
      tool("send_gif"),
      tool("offer_answers", "setup:write"),
      tool("browser_ask_person"),
      tool("desktop_ask_person"),
      tool("browser_open", "browser:use"),
      tool("desktop_read", "desktop:use"),
      tool("start_task", "sandbox:run"),
      tool("propose_event"),
      tool("update_widget"),
      tool("permission_prompt"),
      tool("steer_work"),
      tool("stop_work"),
      // Someone's mailbox and a workspace's own database: whoever runs them reads a read's arguments.
      tool("mail_search", "mail:read", other),
      tool("mail_send", "mail:send", other),
      tool("pg_sales_query", "database:read", other),
      // A custom server by address and one reached through a connections broker.
      tool("crm_search_contacts", `custom:${other.connectionId}:read`, other),
      tool("crm_list_contacts", `custom:${other.connectionId}:read`, { ...other, connector: undefined }),
      // A catalog connector's write, and a listed server's when it isn't the one that set the mark.
      tool("github_create_issue", "github:issues.write", { ...other, server: "catalog" }),
      tool("ops_restart", `custom:${other.connectionId}:write`, { ...other, server: "vouched" }),
      // A read an admin marked to ask is no read.
      tool("github_search_code", "github:repo.read", { ...other, server: "catalog", sensitive: true }),
    ];
    for (const t of refused) expect([t.name, confidentialLockAllows(t, at())]).toEqual([t.name, false]);
    // Our own Git tools carry a connection only for its credential: judged as ours.
    expect(confidentialLockAllows(tool("git_clone", "github:git.read", other), { ...at(), own: true })).toBe(false);

    const kept: ToolDefinition[] = [
      tool("pass"),
      tool("wait_for_device"),
      tool("withdraw_request"),
      tool("github_search_code", "github:repo.read", { ...other, server: "catalog" }),
      tool("ops_read_log", `custom:${other.connectionId}:read`, { ...other, server: "vouched" }),
      tool("vault_change_record", `custom:${marking}:write`, { connectionId: marking }),
    ];
    for (const t of kept) expect([t.name, confidentialLockAllows(t, at())]).toEqual([t.name, true]);
  });

  test("hand_off is refused: a routine's report is kept as its record, which its next run is handed elsewhere", () => {
    expect(confidentialLockAllows(tool("hand_off"), at())).toBe(false);
  });

  test("a question is kept only where its card lands in the run's own thread", () => {
    for (const name of ["ask_user", "ask_choices"]) {
      expect([name, confidentialLockAllows(tool(name), at())]).toEqual([name, true]);
      expect([name, confidentialLockAllows(tool(name), at(true))]).toEqual([name, false]);
    }
    const run = { channelId: "c1", threadRootId: "t1" };
    // A run asks where it answers.
    expect(asksOutside(run, null, null)).toBe(false);
    // A routine's own run asks where the routine reports: another conversation, or another thread of this one.
    expect(asksOutside(run, routine("c1"), null)).toBe(false);
    expect(asksOutside(run, routine("c1", "t1"), null)).toBe(false);
    expect(asksOutside(run, routine("c1", "t2"), null)).toBe(true);
    expect(asksOutside(run, routine("c2"), null)).toBe(true);
    // A run another agent asked puts its cards where the person behind that agent is.
    expect(asksOutside(run, null, { channelId: "c2", threadRootId: "t9" })).toBe(true);
    expect(asksOutside(run, null, { channelId: "c1", threadRootId: "t1" })).toBe(false);
  });
});

describe("in a run", () => {
  const OUTWARD = [
    { name: "post_message", input: { channel: "general", text: `it says ${CANARY}` } },
    { name: "send_dm", input: { to: "@ana", text: `it says ${CANARY}` } },
    { name: "ask_agent", input: { agent: "@dev", question: `what is ${CANARY}?` } },
    { name: "remember", input: { content: `The record says ${CANARY}` } },
    { name: "create_issue", input: { title: CANARY } },
    { name: "create_wiki_page", input: { title: CANARY, content: CANARY } },
    { name: "create_artifact", input: { kind: "document", title: CANARY, content: CANARY } },
    { name: "run_code", input: { language: "bash", code: `echo ${CANARY}` } },
    { name: "web_fetch", input: { url: `https://example.com/?q=${CANARY}` } },
    { name: "web_search", input: { query: CANARY } },
    { name: "set_status", input: { text: CANARY } },
    { name: "request_approval", input: { title: CANARY, why: CANARY.repeat(5) } },
    { name: "offer_feedback", input: { text: CANARY } },
    { name: "propose_agent", input: { name: CANARY } },
    { name: "brand_new_tool", input: {} },
  ];
  const INWARD = [
    { name: "vault_list_records", input: {} },
    { name: "vault_change_record", input: { id: "r1", note: "seen" } },
    { name: "search_context", input: { query: `${CANARY} invoice` } },
    { name: "read_conversation", input: {} },
  ];

  const codes = async (w: VaultWorld, runId: string) =>
    (await w.steps([runId]))
      .filter((s) => s.kind === "tool_result")
      .map((s) => [s.data.name, (s.data.data as { code?: string } | undefined)?.code ?? null]);

  async function locked(level?: "never") {
    const w = await vaultWorld({
      agents: ["kai"],
      setup: { ...EVERY_TOOL, embeddings: true, toolSources: extraSources() },
      script: {
        kai: ({ n }) =>
          n === 1
            ? { calls: [READ] }
            : n === 2
              ? { calls: [...OUTWARD, ...INWARD] }
              : { text: "Here is what I found." },
      },
    });
    await grantAll(w);
    if (level) {
      await w.db
        .update(schema.agents)
        .set({ approvalsLevel: level })
        .where(eq(schema.agents.id, w.agents.kai?.id ?? ""));
    }
    return w;
  }

  test("everything outward is refused with the lock's code; reads, the marking connection's tools and the search by words still run", async () => {
    const w = await locked();
    await w.say("@kai read record r1 and tell everyone");
    await w.settle();
    const [run] = await w.runs("kai");
    const results = new Map((await codes(w, run?.id ?? "")).map(([name, code]) => [String(name), code]));
    for (const call of OUTWARD) expect([call.name, results.get(call.name)]).toEqual([call.name, CONFIDENTIAL_OUTBOUND]);
    for (const call of INWARD) expect([call.name, results.get(call.name)]).toEqual([call.name, null]);
    const calls = await w.calls("kai");
    expect(calls.filter((c) => INWARD.some((i) => i.name === c.name)).map((c) => c.isError)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // Nothing went out: no message outside the thread, no issue, page, file, memory or status line.
    const messages = await w.stored();
    expect(messages.filter((m) => m.authorType === "agent").map((m) => m.threadId)).toEqual([messages[0]?.id ?? null]);
    expect(await w.db.select().from(schema.issues)).toEqual([]);
    expect(await w.db.select().from(schema.contextItems)).toEqual([]);
    expect(await w.db.select().from(schema.artifacts)).toEqual([]);
    // The audit log, kept for good, says which tools were refused and never what they were called with.
    const audit = await w.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.runId, run?.id ?? ""));
    expect(audit.filter((a) => a.action === "tool.call").length).toBeGreaterThan(OUTWARD.length);
    expect(JSON.stringify(audit)).not.toContain(CANARY);
    // The search's words went to no embeddings provider.
    expect(JSON.stringify(w.f.embeddings.calls)).not.toContain(CANARY);
    // Final for the turn's judge: each refusal reads as one for safety, so nothing nudges another way.
    const tried = await triedCalls(w.db, { id: run?.id ?? "", orgId: w.org.id });
    const refusedLines = tried.filter((l) => l.includes("→ failed: "));
    expect(refusedLines.length).toBeGreaterThan(0);
    expect(refusedLines.filter((line) => !line.startsWith(SAFETY_TAG))).toEqual([]);
    expect(onlySafetyRefusals(tried)).toBe(true);
    // And no reader of the run's calls is handed the confidential result's words.
    expect(tried.join("\n")).not.toContain(`customer wrote "${CANARY}`);
  });

  test("an agent set to never ask is refused all the same: a refusal, never a card", async () => {
    const w = await locked("never");
    await w.say("@kai read record r1 and tell everyone");
    await w.settle();
    const [run] = await w.runs("kai");
    const results = new Map((await codes(w, run?.id ?? "")).map(([name, code]) => [String(name), code]));
    for (const name of ["post_message", "create_issue", "run_code", "request_approval"])
      expect([name, results.get(name)]).toEqual([name, CONFIDENTIAL_OUTBOUND]);
    expect(await w.db.select().from(schema.approvals)).toEqual([]);
    expect(run?.status).toBe("done");
  });

  test("a tool reached through a directory's use_tool is judged as itself", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      setup: { toolsOnDemand: true },
      script: {
        kai: [
          { calls: [READ] },
          {
            calls: [
              { name: "use_tool", input: { tool: "post_message", arguments: { channel: "general", text: CANARY } } },
              { name: "use_tool", input: { tool: "vault_list_records", arguments: {} } },
            ],
          },
          { text: "Done." },
        ],
      },
    });
    await w.say("@kai read record r1");
    await w.settle();
    const [run] = await w.runs("kai");
    expect((await codes(w, run?.id ?? "")).slice(1)).toEqual([
      ["post_message", CONFIDENTIAL_OUTBOUND],
      ["vault_list_records", null],
    ]);
  });

  test("a run outside the thread searches with embeddings as before", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      setup: { contextTools: true, embeddings: true },
      script: { kai: [{ calls: [{ name: "search_context", input: { query: "quarterly invoice" } }] }, { text: "ok" }] },
    });
    await w.say("@kai search");
    await w.settle();
    expect(JSON.stringify(w.f.embeddings.calls)).toContain("quarterly invoice");
  });

  test("a second run of the thread is locked from its first call; a run asked by another message of the channel, or in another channel, is free", async () => {
    const POST = { name: "post_message", input: { channel: "general", text: "hello there" } };
    const w = await vaultWorld({
      agents: ["kai"],
      script: {
        kai: ({ n }) => (n === 1 ? { calls: [READ] } : n % 2 === 0 ? { text: "Done." } : { calls: [POST] }),
      },
    });
    const asked = await w.say("@kai read record r1");
    await w.settle();

    await w.say("@kai now post it in general", { threadId: asked.id });
    await w.settle();
    await w.say("@kai post hello in general");
    await w.settle();
    const elsewhere = await createChannel(w.db, w.owner.id, w.org.id, { name: "outro" });
    await addChannelMember(w.db, w.owner.id, w.org.id, elsewhere.id, { agentId: w.agents.kai?.id ?? "" });
    await postPersonMessage({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, elsewhere.id, {
      body: "@kai post hello in general",
    });
    await w.settle();

    const runs = await w.runs("kai");
    expect(runs).toHaveLength(4);
    const posts = await Promise.all(
      runs.slice(1).map(async (r) => (await codes(w, r.id)).find(([name]) => name === "post_message")?.[1]),
    );
    expect(posts).toEqual([CONFIDENTIAL_OUTBOUND, null, null]);
  });

  test("show_block replaces a block of the thread and no other: one shown elsewhere keeps its words and its place in the index", async () => {
    let elsewhere = "";
    const w = await vaultWorld({
      agents: ["kai"],
      setup: { blockTools: true },
      script: {
        kai: ({ n }) => {
          const block = (title: string, label: string, id?: string) => ({
            name: "show_block",
            input: { title, spec: { parts: [{ type: "stat", label, value: "1" }] }, ...(id ? { block_id: id } : {}) },
          });
          if (n === 1) return { calls: [block("Plan", "steps")] };
          if (n === 3) return { calls: [READ] };
          if (n === 4) return { calls: [block(`Plan ${CANARY}`, `label ${CANARY}`, elsewhere)] };
          return { text: "Done." };
        },
      },
    });
    await w.say("@kai show the plan");
    await w.settle();
    elsewhere = (await w.db.select().from(schema.artifacts))[0]?.id ?? "";
    expect(elsewhere).not.toBe("");
    await w.say("@kai read record r1 and update the plan");
    await w.settle();
    await w.advance(10);
    const [, run] = await w.runs("kai");
    expect((await codes(w, run?.id ?? "")).at(-1)).toEqual(["show_block", CONFIDENTIAL_OUTBOUND]);
    const [block] = await w.db.select().from(schema.artifacts);
    expect([block?.title, block?.threadId, block?.currentVersion]).toEqual(["Plan", null, 1]);
    expect(await w.tablesHolding(CANARY)).not.toEqual(expect.arrayContaining(["artifacts"]));
    expect(JSON.stringify(await w.db.select().from(schema.searchDocuments))).not.toContain(CANARY);
  });

  test("withdraw_request takes back nothing outside the thread: the run that waits elsewhere is told nothing", async () => {
    let question = "";
    const w = await vaultWorld({
      agents: ["kai"],
      people: ["bia"],
      setup: { toolSources: [createWithdrawRequestToolSource()] },
      script: {
        kai: ({ n }) => {
          if (n === 1)
            return {
              calls: [
                {
                  name: "ask_user",
                  input: { question: "Which plan?", why: "Only the person knows which plan they mean." },
                },
              ],
            };
          if (n === 2) return { calls: [READ] };
          if (n === 3)
            return { calls: [{ name: "withdraw_request", input: { id: question, reason: `it said ${CANARY}` } }] };
          return { text: "Done." };
        },
      },
    });
    // Asked inside a thread, so the next top-level message is a conversation of its own.
    const topic = await w.say("About the plans.");
    await w.say("@kai which plan do we use?", { threadId: topic.id });
    await w.settle();
    const [waiting] = await w.runs("kai");
    expect(waiting?.status).toBe("waiting_input");
    question = (await w.db.select().from(schema.agentQuestions))[0]?.id ?? "";
    await w.say("@kai read record r1", { as: "bia" });
    await w.settle();
    const [, locked] = await w.runs("kai");
    expect((await codes(w, locked?.id ?? "")).at(-1)).toEqual(["withdraw_request", CONFIDENTIAL_OUTBOUND]);
    // The first run still waits on its question, and holds no word of the record.
    const [still] = await w.runs("kai");
    expect(still?.status).toBe("waiting_input");
    expect((await w.db.select().from(schema.agentQuestions))[0]?.status).toBe("open");
    expect(JSON.stringify([still, await w.steps([still?.id ?? ""])])).not.toContain(CANARY);
  });

  test("withdraw_request in the thread carries no reason: the run that waits is told only that it was withdrawn", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      people: ["bia"],
      script: {
        kai: [
          {
            calls: [
              {
                name: "ask_user",
                input: { question: "Which plan?", why: "Only the person knows which plan they mean." },
              },
            ],
          },
        ],
      },
    });
    const topic = await w.say("About the plans.");
    await w.say("@kai which plan do we use?", { threadId: topic.id });
    await w.settle();
    const [waiting] = await w.runs("kai");
    const [question] = await w.db.select().from(schema.agentQuestions);
    if (!waiting || !question) throw new Error("no question");
    expect([waiting.status, waiting.threadRootId]).toEqual(["waiting_input", topic.id]);
    // The thread is confidential by now, and a newer run of the agent there takes the question back.
    await w.db.transaction((tx) =>
      markThreadConfidential(tx, { orgId: w.org.id, channelId: w.channelId, rootId: topic.id }),
    );
    const [again] = await w.db
      .insert(schema.messages)
      .values({
        orgId: w.org.id,
        channelId: w.channelId,
        threadId: topic.id,
        authorType: "person",
        authorUserId: w.people.bia?.id,
        body: "@kai never mind the plan",
      })
      .returning();
    const [newer] = await w.db
      .insert(schema.agentRuns)
      .values({
        ...waiting,
        id: crypto.randomUUID(),
        triggerMessageId: again?.id ?? "",
        status: "running",
        transcript: null,
        createdAt: new Date(),
      })
      .returning();
    const ctx: ToolContext = {
      db: w.db,
      orgId: w.org.id,
      agentId: waiting.agentId,
      runId: newer?.id ?? "",
      channelId: w.channelId,
      threadRootId: topic.id,
      triggerMessageId: again?.id ?? "",
    };
    const out = await createToolGateway({ sources: [createWithdrawRequestToolSource()] }).invoke(ctx, {
      toolUseId: "t1",
      name: "withdraw_request",
      input: { id: question.id, reason: `it said ${CANARY}` },
    });
    expect(out).toMatchObject({ type: "result", output: { content: expect.stringContaining("Withdrawn") } });
    expect((await w.db.select().from(schema.agentQuestions))[0]?.status).not.toBe("open");
    // What the waiting run's call reads says it was withdrawn, and nothing of why.
    const [told] = await w.runs("kai");
    expect(JSON.stringify(told?.transcript)).toContain("You withdrew this question yourself");
    expect(JSON.stringify(told)).not.toContain(CANARY);
  });

  test("an action of another tool approved before the mark does not run after it", async () => {
    const recorded: string[] = [];
    const goals: ToolSource = {
      name: "goals",
      tools: async () => [
        {
          name: "goal_upsert",
          description: "Record a monthly goal",
          scope: "",
          sensitive: true,
          inputSchema: { type: "object", properties: { month: { type: "string" } } },
          describe: (input) => ({ title: `Goal of ${(input as { month: string }).month}` }),
          execute: async (input) => {
            recorded.push((input as { month: string }).month);
            return { content: "recorded" };
          },
        },
      ],
    };
    const w = await vaultWorld({
      agents: ["kai"],
      setup: { toolSources: [goals] },
      script: {
        kai: ({ n }) =>
          n === 1
            ? {
                calls: [
                  {
                    name: "goal_upsert",
                    input: { month: "2026-11", why: "The person asked to record the goal for November just now." },
                  },
                ],
              }
            : n === 2
              ? { calls: [READ] }
              : { text: "Done." },
      },
    });
    const asked = await w.say("@kai record the goal for November");
    await w.settle();
    const [approval] = await w.db.select().from(schema.approvals);
    expect(approval?.status).toBe("pending");
    // While it waits, another run of the same thread reads the record.
    await w.say("@kai read record r1", { threadId: asked.id });
    await w.settle();
    expect(await w.db.select().from(schema.confidentialThreads)).toHaveLength(1);
    await decideApproval({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await w.settle();
    expect(recorded).toEqual([]);
    const [first] = await w.runs("kai");
    expect(await codes(w, first?.id ?? "")).toEqual([["goal_upsert", CONFIDENTIAL_OUTBOUND]]);
  });
});
