import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  type ApprovalsLevel,
  askingPermissions,
  asksOf,
  createAgent,
  ensureRightHand,
  ForbiddenError,
  getOrgSettings,
  grantScopes,
  insertMessage,
  type RoutineBrief,
  type RunAuthority,
  setWorkspaceApprovalsLevel,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
  toolPolicy,
  unaskedAtNever,
  updateAgent,
  ValidationError,
} from "../src";
import { approvalsLine, HOW_YOU_WORK, howYouWork } from "../src/context";
import { runPermissionPrompt } from "../src/mission-commands";
import { approvalsLevelOf } from "../src/tools/run-policy";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "The customer asked for this twice today and the order is already closed on our side.";
const CONNECTION = "00000000-0000-4000-8000-0000000000aa";
const LEVELS: ApprovalsLevel[] = ["always", "risky", "never"];
const ran: string[] = [];

/** What each call's tool was given: whether it ran the approved way. */
const approved: boolean[] = [];

const shopTool = (name: string, scope: string, sensitive = false): ToolDefinition => ({
  name,
  description: name,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  scope,
  connectionId: CONNECTION,
  connectorLabel: "Shop",
  ...(sensitive ? { sensitive: true } : {}),
  execute: async () => {
    ran.push(name);
    return { content: "done" };
  },
});

const READ = shopTool("shop_get_order", "shop:orders.read");
/** An ordinary write: nothing marks it sensitive. */
const WRITE = shopTool("shop_update_order", "shop:orders.write");
/** Marked sensitive (its level, a delete): asks unless the agent never asks. */
const SENSITIVE = shopTool("shop_delete_customer", "shop:customers.delete", true);
/** What asks by its name, whatever a connector says. */
const MERGE = shopTool("shop_merge_branch", "shop:code.write", true);
const DEPLOY = shopTool("shop_deploy_site", "shop:sites.write");
/** Someone's mailbox: its owner answers for a send. */
const MAILBOX: ToolDefinition = {
  ...shopTool("shop_send_from_ana", "shop:mail.send", true),
  approvers: async () => ({ ok: true, approvers: null }),
};
/** Every way to open a pull request, and the merge that stays apart. */
const OPEN_PR = shopTool("open_pull_request", "github:pr.write");
const CREATE_PR = shopTool("github_create_pull_request", "github:pr.write");
const CUSTOM_PR = shopTool("forge_create_a_pull_request", `custom:${CONNECTION}:write`);
const MERGE_PR = shopTool("github_merge_pull_request", "github:pr.merge", true);

/** One of ours: no connection. */
const ours = (name: string, scope = "", extra: Partial<ToolDefinition> = {}): ToolDefinition => {
  const { connectionId: _c, connectorLabel: _l, ...tool } = shopTool(name, scope);
  return { ...tool, ...extra };
};
const CREATE_ISSUE = ours("create_issue", "issues:write");
const LIST_ISSUES = ours("list_issues", "issues:read");
const POST_MESSAGE = ours("post_message");
const UNKNOWN = ours("brand_new_tool");
const REQUEST_APPROVAL = ours("request_approval", "", { sensitive: true });

const HELD =
  "Not run: This is a merge: a person approves it first. To ask them, make the same call again with why set to your reason: it waits for their decision in the chat.";
const SECRET = "Not run: This reads a secret, which agents never do.";
/** The computer's `run_code`: it holds a merge and refuses a secret read until the call comes the approved way. */
const RUN_CODE = ours("run_code", "sandbox:run", {
  whyAsks: true,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, why: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  rememberCommand: () => "gh pr merge 12 --squash",
  execute: async (input, ctx) => {
    approved.push(ctx.approved === true);
    if (ctx.approved) return { content: "merged", data: { merge: { repo: "example/app", pr: 12, ref: null } } };
    const content = input.id === "secret" ? SECRET : HELD;
    return { content, isError: true, data: { code: "command.approval_needed" } };
  },
});

const GITLAB_MR = shopTool("gitlab_create_merge_request", `custom:${CONNECTION}:write`);
/** Runs other actions by slug, as Composio's executor does. */
const EXECUTOR: ToolDefinition = {
  ...shopTool("shop_execute", `custom:${CONNECTION}:write`),
  inputSchema: { type: "object", properties: { slugs: { type: "array" } }, required: ["slugs"] },
  actions: (input) => (Array.isArray(input.slugs) ? input.slugs.map(String) : null),
};
/** One of our own tools that asks at every level but never. */
const CLOSE_ISSUES = ours("close_issues", "issues:write", { sensitive: true });
const PROPOSE_MEMBERS = ours("propose_member_changes", "setup:write");
const PROPOSE_INSTRUCTIONS = ours("propose_instruction_change", "memory:write");
const WORKSPACE_ACTION = ours("workspace_action", "setup:write", {
  inputSchema: { type: "object", properties: { find: { type: "string" }, action: { type: "string" } } },
  looksOnly: (input) => Boolean(input.find) && !input.action,
});

const shop: ToolSource = {
  name: "shop",
  tools: async () => [
    GITLAB_MR,
    EXECUTOR,
    CLOSE_ISSUES,
    PROPOSE_MEMBERS,
    PROPOSE_INSTRUCTIONS,
    WORKSPACE_ACTION,
    READ,
    WRITE,
    SENSITIVE,
    MERGE,
    DEPLOY,
    MAILBOX,
    OPEN_PR,
    CREATE_PR,
    CUSTOM_PR,
    MERGE_PR,
    CREATE_ISSUE,
    LIST_ISSUES,
    POST_MESSAGE,
    UNKNOWN,
    REQUEST_APPROVAL,
    RUN_CODE,
  ],
};

const person: RunAuthority = { kind: "person", personId: "user_ana" };
const own: RunAuthority = { kind: "unattended", personId: null, reason: "agent" };
/** Nobody behind it, woken by a routine's report: what the routine read feeds it. */
const fed: RunAuthority = { kind: "unattended", personId: null, reason: "routine_report", brief: null };
const routine: RunAuthority = { kind: "routine", personId: null, brief: null };

describe("the policy, by level", () => {
  const action = (authority: RunAuthority, tool: ToolDefinition, level: ApprovalsLevel) =>
    toolPolicy(authority, tool, level).action;

  test("always: everything that changes something asks, on every kind of run", () => {
    for (const authority of [person, own, fed, routine]) {
      for (const tool of [WRITE, SENSITIVE, MERGE, CREATE_ISSUE, POST_MESSAGE, OPEN_PR, CREATE_PR, RUN_CODE]) {
        expect({ tool: tool.name, action: action(authority, tool, "always") }).toEqual({
          tool: tool.name,
          action: "approve",
        });
      }
      expect(action(authority, READ, "always")).toBe("allow");
      expect(action(authority, LIST_ISSUES, "always")).toBe("allow");
    }
    // A tool the table doesn't know is still never a routine's.
    for (const authority of [person, own]) expect(action(authority, UNKNOWN, "always")).toBe("approve");
    for (const authority of [fed, routine]) expect(action(authority, UNKNOWN, "always")).toBe("refuse");
  });

  test("always: a click or typing in the browser asks, looking at a page doesn't", () => {
    const browser = (name: string) => ours(name, "browser:use");
    const acts = ["browser_do", "browser_click", "browser_fill", "browser_press", "browser_upload"];
    const looks = ["browser_open", "browser_read", "browser_screenshot", "browser_scroll", "browser_tabs"];
    for (const authority of [person, routine]) {
      expect(acts.filter((name) => action(authority, browser(name), "always") === "approve")).toEqual(acts);
      expect(looks.filter((name) => action(authority, browser(name), "always") === "allow")).toEqual(looks);
    }
    expect(action(person, ours("desktop_do", "desktop:use"), "always")).toBe("approve");
    expect(action(person, ours("desktop_read", "desktop:use"), "always")).toBe("allow");
  });

  test("always: what would be asking about asking, or would keep the run from ending, never asks", () => {
    const exempt = [
      ours("pass"),
      ours("set_status"),
      ours("withdraw_request"),
      ours("work_in_background"),
      REQUEST_APPROVAL,
      ours("ask_user"),
      ours("ask_choices"),
      ours("propose_agent"),
      ours("offer_invites"),
      ours("react"),
      ours("start_poll"),
      ours("permission_prompt"),
      ours("run_approved_action"),
      ours("request_secret"),
      ours("request_permission"),
      ours("propose_event", "calendar:write"),
      ours("schedule_action", "schedule:write"),
      ours("team_status"),
    ];
    for (const tool of exempt) {
      expect({ tool: tool.name, action: action(person, tool, "always") }).toEqual({ tool: tool.name, action: "allow" });
    }
    // The mission's own tools, and a widget's answer on its refresh run.
    expect(action(person, ours("update_plan"), "always")).toBe("allow");
    const widgetRun: RunAuthority = { kind: "routine", personId: null, brief: { widget: {} } as RoutineBrief };
    expect(action(widgetRun, ours("update_widget"), "always")).toBe("allow");
    expect(action(routine, ours("hand_off"), "always")).toBe("allow");
  });

  test("a skill's update is a change, not a read", () => {
    for (const name of ["update_skill", "update_skill_from_source"]) {
      expect(action(person, ours(name, "skills:read"), "always")).toBe("approve");
      expect(action(person, ours(name, "skills:read"), "risky")).toBe("allow");
    }
    expect(action(person, ours("load_skill", "skills:read"), "always")).toBe("allow");
  });

  test("risky and never leave the policy as it was: the tools' own marks decide", () => {
    for (const level of ["risky", "never"] as const) {
      for (const tool of [READ, WRITE, SENSITIVE, MERGE, CREATE_ISSUE, POST_MESSAGE, UNKNOWN]) {
        expect(action(person, tool, level)).toBe("allow");
      }
    }
    expect(toolPolicy(person, WRITE)).toEqual(toolPolicy(person, WRITE, "risky"));
  });

  test("a routine's run and one its reading feeds answer approve for a connected app's write at every level", () => {
    for (const level of LEVELS) {
      for (const authority of [fed, routine]) {
        expect(action(authority, WRITE, level)).toBe("approve");
        expect(action(authority, SENSITIVE, level)).toBe("approve");
        expect(action(authority, MERGE, level)).toBe("approve");
        expect(action(authority, READ, level)).toBe("allow");
      }
    }
  });

  test("opening a pull request is the agent's own work on every run, by every tool that opens one; a merge isn't", () => {
    for (const authority of [person, own, fed, routine]) {
      for (const tool of [OPEN_PR, CREATE_PR, CUSTOM_PR]) {
        expect({ tool: tool.name, action: action(authority, tool, "risky") }).toEqual({
          tool: tool.name,
          action: "allow",
        });
      }
    }
    for (const authority of [fed, routine]) expect(action(authority, MERGE_PR, "risky")).toBe("approve");
    // A review can approve a pull request, and a read scope only reads: neither opens one.
    expect(action(routine, shopTool("github_create_pull_request_review", "github:pr.write"), "risky")).toBe("approve");
    expect(action(routine, shopTool("github_update_pull_request", "github:pr.write"), "risky")).toBe("approve");
  });
});

describe("what never stops asking for", () => {
  const covers = (tool: ToolDefinition, authority: RunAuthority | null = person, level: ApprovalsLevel = "never") =>
    unaskedAtNever(level, tool, authority);

  test("everything, on every kind of run that has one", () => {
    for (const authority of [person, own, fed, routine]) expect(covers(SENSITIVE, authority)).toBe(true);
    // A mission task's call has no run: the mission's own setting decides it.
    expect(covers(SENSITIVE, null)).toBe(false);
  });

  test("only at never", () => {
    expect(covers(SENSITIVE, person, "risky")).toBe(false);
    expect(covers(SENSITIVE, person, "always")).toBe(false);
  });

  test("merge, deploy, rollback, what starts them under another name and what runs anything", () => {
    const names = [
      "shop_merge_branch",
      "shop_deploy_site",
      "shop_rollback_release",
      "shop_promote_build",
      "shop_trigger_workflow",
      "shop_run_script",
      "shop_execute_sql",
    ];
    expect(names.filter((name) => covers({ ...SENSITIVE, name }))).toEqual(names);
    expect(covers({ ...SENSITIVE, name: "shop_create_site", scope: "shop:deployments.write" })).toBe(true);
    // A tool that runs other actions, whatever they are, read or not.
    expect(covers({ ...SENSITIVE, actions: () => null })).toBe(true);
  });

  test("someone's mailbox, and our own tools that act", () => {
    expect(covers(MAILBOX)).toBe(true);
    expect(covers({ ...RUN_CODE, sensitive: true })).toBe(true);
    expect(covers(ours("desktop_do", "desktop:use", { sensitive: true }))).toBe(true);
  });

  test("not the tools whose job is asking: the agent chose to ask", () => {
    for (const name of ["request_approval", "request_permission", "send_feedback"]) {
      expect({ name, covers: covers(ours(name, "", { sensitive: true })) }).toEqual({ name, covers: false });
    }
    expect(covers(shopTool("request_branch_push", "github:git.write", true))).toBe(false);
    // A connected app's tool that only shares one of those names is that app's action.
    expect(covers(shopTool("request_approval", "shop:orders.write", true))).toBe(true);
  });
});

// ── Through the gateway ──────────────────────────────────────────────────────

type Kind = "person" | "fed" | "routine";

async function world(level: ApprovalsLevel, scopes = [{ connectionId: null, scope: "*" }]) {
  ran.length = 0;
  approved.length = 0;
  f = await setup({ toolSources: [shop] });
  await grantScopes(f.db, f.org.id, f.agent.id, [...scopes, { connectionId: null, scope: "sandbox:run" }]);
  if (level !== "risky") await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { approvalsLevel: level });
}

/** A run of the agent in #general: a person's, one a routine's report woke (`fed`), or a routine's own. */
async function runAs(kind: Kind): Promise<ToolContext> {
  const brief: RoutineBrief | null =
    kind === "routine"
      ? {
          routineId: "00000000-0000-4000-8000-000000000001",
          routineRunId: "00000000-0000-4000-8000-000000000002",
          name: "Pedidos do dia",
          creatorUserId: f.owner.id,
          deliverTo: { channelId: f.general.id, threadId: null },
          access: "act",
          report: "when_new",
          trigger: "schedule",
          dueAt: new Date().toISOString(),
        }
      : null;
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author:
      kind === "fed"
        ? { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null }
        : { type: "person", userId: f.owner.id },
    body: "hi",
    meta: brief
      ? { routineBrief: brief }
      : kind === "fed"
        ? { notice: { kind: "routine_handoff", text: "hi", from: "Routine", refs: { runId: crypto.randomUUID() } } }
        : undefined,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      ...(brief ? { background: true } : {}),
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    ...(brief ? { background: true } : {}),
  };
}

const tools = () => {
  if (!f.tools) throw new Error("no tools");
  return f.tools;
};
/** What a call does: `ran`, `asked` (an approval card) or the refusal's text. */
async function outcome(ctx: ToolContext, tool: ToolDefinition, input: Record<string, unknown> = { id: "1", why: WHY }) {
  const result = await tools().invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: tool.name, input });
  if (result.type === "approval") return "asked";
  if (result.type !== "result") return result.type;
  return result.output.isError ? result.output.content : "ran";
}
const requiresWhy = (t: ToolDefinition | undefined) =>
  Array.isArray(t?.inputSchema.required) && (t.inputSchema.required as string[]).includes("why");
const toolCalls = async (tool: string) =>
  (
    await f.db
      .select({ details: schema.auditLog.details, outcome: schema.auditLog.outcome })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "tool.call"), eq(schema.auditLog.targetId, tool)))
  ).map((row) => ({ outcome: row.outcome, level: (row.details as Record<string, unknown>).approvalsLevel ?? null }));

describe("the gateway, a person's run", () => {
  const table: [ApprovalsLevel, Record<"read" | "write" | "sensitive" | "merge" | "deploy", string>][] = [
    ["always", { read: "ran", write: "asked", sensitive: "asked", merge: "asked", deploy: "asked" }],
    ["risky", { read: "ran", write: "ran", sensitive: "asked", merge: "asked", deploy: "asked" }],
    ["never", { read: "ran", write: "ran", sensitive: "ran", merge: "ran", deploy: "ran" }],
  ];
  for (const [level, expected] of table) {
    test(level, async () => {
      await world(level);
      const ctx = await runAs("person");
      expect({
        read: await outcome(ctx, READ, { id: "1" }),
        write: await outcome(ctx, WRITE),
        sensitive: await outcome(ctx, SENSITIVE),
        merge: await outcome(ctx, MERGE),
        deploy: await outcome(ctx, DEPLOY),
      }).toEqual(expected);
    });
  }
});

describe("the gateway, a routine's run and one a routine's reading feeds", () => {
  for (const kind of ["fed", "routine"] as const) {
    for (const level of ["always", "risky"] as const) {
      test(`${kind}, ${level}: every write to a connected app asks`, async () => {
        await world(level);
        const ctx = await runAs(kind);
        expect({
          read: await outcome(ctx, READ, { id: "1" }),
          write: await outcome(ctx, WRITE),
          sensitive: await outcome(ctx, SENSITIVE),
          merge: await outcome(ctx, MERGE),
        }).toEqual({ read: "ran", write: "asked", sensitive: "asked", merge: "asked" });
        expect(ran).toEqual([READ.name]);
      });
    }

    test(`${kind}, never: nothing asks`, async () => {
      await world("never");
      const ctx = await runAs(kind);
      expect({
        read: await outcome(ctx, READ, { id: "1" }),
        write: await outcome(ctx, WRITE, { id: "1" }),
        sensitive: await outcome(ctx, SENSITIVE, { id: "1" }),
        merge: await outcome(ctx, MERGE, { id: "1" }),
      }).toEqual({ read: "ran", write: "ran", sensitive: "ran", merge: "ran" });
      expect(ran).toEqual([READ.name, WRITE.name, SENSITIVE.name, MERGE.name]);
      expect(await f.db.select().from(schema.approvals)).toEqual([]);
      // The write asked only because of the run: the audit says the level let it through.
      expect(await toolCalls(WRITE.name)).toEqual([{ outcome: "done", level: "never" }]);
    });
  }
});

describe("never", () => {
  test("the call needs no why, and the audit says it ran unasked because of the level", async () => {
    await world("never");
    const ctx = await runAs("person");
    const listed = new Map((await tools().list(ctx)).map((t) => [t.name, t]));
    expect(requiresWhy(listed.get(SENSITIVE.name))).toBe(false);
    expect(requiresWhy(listed.get(MERGE.name))).toBe(false);
    expect(await outcome(ctx, SENSITIVE, { id: "1" })).toBe("ran");
    expect(await outcome(ctx, MERGE, { id: "1" })).toBe("ran");
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(await toolCalls(SENSITIVE.name)).toEqual([{ outcome: "done", level: "never" }]);
    expect(await toolCalls(MERGE.name)).toEqual([{ outcome: "done", level: "never" }]);
    // An ordinary write never asked: nothing to say about the level.
    expect(await outcome(ctx, WRITE, { id: "1" })).toBe("ran");
    expect(await toolCalls(WRITE.name)).toEqual([{ outcome: "done", level: null }]);
  });

  test("someone's mailbox sends without asking its owner", async () => {
    await world("never");
    const ctx = await runAs("person");
    expect(await outcome(ctx, MAILBOX, { id: "1" })).toBe("ran");
    expect(ran).toEqual([MAILBOX.name]);
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(await toolCalls(MAILBOX.name)).toEqual([{ outcome: "done", level: "never" }]);
  });

  test("a command the computer held runs the approved way, with no card", async () => {
    await world("never");
    const ctx = await runAs("person");
    expect(await outcome(ctx, RUN_CODE, { id: "1" })).toBe("ran");
    expect(approved).toEqual([false, true]);
    // Said with its reason, as the computer tells an agent to ask: the same, and still no card.
    expect(await outcome(ctx, RUN_CODE, { id: "1", why: WHY })).toBe("ran");
    expect(approved).toEqual([false, true, false, true]);
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(await toolCalls(RUN_CODE.name)).toEqual([
      { outcome: "done", level: "never" },
      { outcome: "done", level: "never" },
    ]);
  });

  test("what the computer refuses is not run again: the level lifts asking only", async () => {
    await world("never");
    const ctx = await runAs("person");
    expect(await outcome(ctx, RUN_CODE, { id: "secret" })).toBe(SECRET);
    expect(approved).toEqual([false]);
  });

  test("at the default level the same command asks", async () => {
    await world("risky");
    const ctx = await runAs("person");
    expect(await outcome(ctx, RUN_CODE, { id: "1" })).toBe("asked");
    expect(approved).toEqual([false]);
  });

  test("a merge by command leaves the audit line and the receipt a connector's merge leaves", async () => {
    await world("never");
    const ctx = await runAs("person");
    expect(await outcome(ctx, RUN_CODE, { id: "1" })).toBe("ran");
    const merged = await f.db
      .select({ target: schema.auditLog.targetId, details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.merged_without_asking"));
    expect(merged).toEqual([{ target: "example/app", details: { pr: 12, ref: null, tool: RUN_CODE.name } }]);
    const receipts = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.kind, "pr.merged"));
    expect(receipts.map((r) => r.params)).toEqual([{ repo: "example/app", number: 12 }]);
  });

  test("a tool whose job is asking still asks", async () => {
    await world("never");
    const ctx = await runAs("person");
    const listed = new Map((await tools().list(ctx)).map((t) => [t.name, t]));
    expect(requiresWhy(listed.get(REQUEST_APPROVAL.name))).toBe(true);
    expect(await outcome(ctx, REQUEST_APPROVAL)).toBe("asked");
    expect(ran).toEqual([]);
  });

  test("it gives no tool the agent's scopes don't", async () => {
    await world("never", [{ connectionId: null, scope: "issues:read" }]);
    const ctx = await runAs("person");
    expect(await outcome(ctx, SENSITIVE)).toMatch(/^Not allowed/);
    expect(ran).toEqual([]);
  });

  test("narrowed back, the next call asks", async () => {
    await world("never");
    const ctx = await runAs("person");
    expect(await outcome(ctx, SENSITIVE)).toBe("ran");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { approvalsLevel: "risky" });
    expect(await outcome(ctx, SENSITIVE)).toBe("asked");
  });
});

describe("Aprovar sempre on a command the computer holds", () => {
  test("offers the command's kind, and once kept the same kind runs the approved way with its receipt", async () => {
    await world("risky");
    const ctx = await runAs("person");
    const first = await tools().invoke(ctx, { toolUseId: "tu_held", name: RUN_CODE.name, input: { id: "1" } });
    expect(first.type === "approval" && first.approval.approveAlways).toEqual({
      tool: "command",
      actions: ["gh pr merge"],
    });
    await f.db
      .insert(schema.approvalRules)
      .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: null, tool: "command", action: "gh pr merge" });
    approved.length = 0;
    expect(await outcome(ctx, RUN_CODE, { id: "1" })).toBe("ran");
    expect(await outcome(ctx, RUN_CODE, { id: "1", why: WHY })).toBe("ran");
    expect(approved).toEqual([false, true, false, true]);
    // A routine's run and one its reading feeds are covered by the same rule.
    expect(await outcome(await runAs("routine"), RUN_CODE, { id: "1" })).toBe("ran");
    expect(await outcome(await runAs("fed"), RUN_CODE, { id: "1" })).toBe("ran");
    const merged = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.merged_without_asking"));
    expect(merged).toHaveLength(4);
    // What the computer refuses stays refused.
    expect(await outcome(ctx, RUN_CODE, { id: "secret" })).toBe(SECRET);
  });

  test("every card offers it at the default level, on every kind of run; never where the agent chose to ask", async () => {
    for (const kind of ["person", "routine", "fed"] as const) {
      await world("risky");
      const ctx = await runAs(kind);
      const offered = async (tool: ToolDefinition) => {
        const result = await tools().invoke(ctx, {
          toolUseId: `tu_${crypto.randomUUID()}`,
          name: tool.name,
          input: { id: "1", why: WHY },
        });
        return result.type === "approval" ? result.approval.approveAlways : "no card";
      };
      expect({
        kind,
        sensitive: await offered(SENSITIVE),
        merge: await offered(MERGE_PR),
        deploy: await offered(DEPLOY),
      }).toEqual({
        kind,
        sensitive: { tool: SENSITIVE.name, actions: [] },
        merge: { tool: MERGE_PR.name, actions: [] },
        deploy: { tool: DEPLOY.name, actions: [] },
      });
      if (kind !== "person") expect(await offered(WRITE)).toEqual({ tool: WRITE.name, actions: [] });
      if (kind === "person") expect(await offered(REQUEST_APPROVAL)).toBeNull();
      // Kept, it holds on this run too.
      expect(await offered(CLOSE_ISSUES)).toEqual({ tool: CLOSE_ISSUES.name, actions: [] });
      await f.db
        .insert(schema.approvalRules)
        .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: null, tool: CLOSE_ISSUES.name, action: "" });
      expect(await outcome(ctx, CLOSE_ISSUES, { id: "1" })).toBe("ran");
      await f.close();
    }
    f = undefined as unknown as Fixture;
  });

  test("an agent that always asks is offered none and no kept rule runs for it", async () => {
    await world("always");
    const ctx = await runAs("person");
    await f.db
      .insert(schema.approvalRules)
      .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: null, tool: CLOSE_ISSUES.name, action: "" });
    const result = await tools().invoke(ctx, {
      toolUseId: "tu_w",
      name: CLOSE_ISSUES.name,
      input: { id: "1", why: WHY },
    });
    expect(result.type === "approval" && result.approval.approveAlways).toBeNull();
    expect(ran).toEqual([]);
  });
});

describe("always", () => {
  test("a write lists as one that asks and takes its why", async () => {
    await world("always");
    const ctx = await runAs("person");
    const listed = new Map((await tools().list(ctx)).map((t) => [t.name, t]));
    expect(requiresWhy(listed.get(WRITE.name))).toBe(true);
    expect(requiresWhy(listed.get(CREATE_ISSUE.name))).toBe(true);
    expect(requiresWhy(listed.get(READ.name))).toBe(false);
    expect(await outcome(ctx, WRITE, { id: "1" })).toMatch(/^Say why first/);
    expect(ran).toEqual([]);
  });

  test("an internal change, a post elsewhere and a tool nobody classified each ask on a person's run; a read doesn't", async () => {
    await world("always");
    const ctx = await runAs("person");
    expect({
      internal: await outcome(ctx, CREATE_ISSUE),
      elsewhere: await outcome(ctx, POST_MESSAGE),
      unknown: await outcome(ctx, UNKNOWN),
      command: await outcome(ctx, RUN_CODE),
      read: await outcome(ctx, LIST_ISSUES, { id: "1" }),
      appRead: await outcome(ctx, READ, { id: "1" }),
    }).toEqual({
      internal: "asked",
      elsewhere: "asked",
      unknown: "asked",
      command: "asked",
      read: "ran",
      appRead: "ran",
    });
    expect(ran).toEqual([LIST_ISSUES.name, READ.name]);
    expect(approved).toEqual([]);
  });

  test("on a routine's run too", async () => {
    await world("always");
    const ctx = await runAs("routine");
    expect({
      internal: await outcome(ctx, CREATE_ISSUE),
      elsewhere: await outcome(ctx, POST_MESSAGE),
      read: await outcome(ctx, LIST_ISSUES, { id: "1" }),
    }).toEqual({ internal: "asked", elsewhere: "asked", read: "ran" });
    // A tool the table doesn't know stays out of a routine's reach, asked or not.
    expect(await outcome(ctx, UNKNOWN)).toMatch(/routine's background work can't use this tool/);
    expect(ran).toEqual([LIST_ISSUES.name]);
  });

  test("the computer's own shell sends what isn't a read to run_code, whose call asks", () => {
    const scope = { cwd: "/work", folders: ["/work"] };
    const prompt = (command: string, asksFirst: boolean) =>
      JSON.parse(
        runPermissionPrompt({ tool_name: "Bash", input: { command }, scope }, { canRun: true, asksFirst }),
      ) as { behavior: string; message?: string; code?: string };
    expect(prompt("ls -la", true).behavior).toBe("allow");
    expect(prompt("touch notes.txt", false).behavior).toBe("allow");
    expect(prompt("touch notes.txt", true)).toMatchObject({ behavior: "deny", code: "asks" });
    expect(prompt("touch notes.txt", true).message).toContain("run the same command with run_code");
    // An edit of the brain's own is sent to the tool that makes it with a reason.
    const edit = JSON.parse(
      runPermissionPrompt(
        { tool_name: "Edit", input: { file_path: "/work/notes.txt", old_string: "a", new_string: "b" }, scope },
        { canRun: true, asksFirst: true },
      ),
    ) as { behavior: string; message?: string; code?: string };
    expect(edit).toMatchObject({ behavior: "deny", code: "asks" });
    expect(edit.message).toContain("with write_file");
    // Claude Code's PowerShell tool runs commands: judged as a `powershell -Command` body, asked the same way.
    const ps = (command: string, asksFirst: boolean) =>
      JSON.parse(
        runPermissionPrompt({ tool_name: "PowerShell", input: { command }, scope }, { canRun: true, asksFirst }),
      ) as { behavior: string; message?: string; code?: string };
    expect(ps("New-Item notes.txt", false).behavior).toBe("allow");
    expect(ps("Set-MpPreference -DisableRealtimeMonitoring 1", false)).toMatchObject({
      behavior: "deny",
      code: "system",
    });
    expect(ps("New-Item notes.txt", true).message).toContain("run the same command with run_code");
  });

  test("a Windows computer's folders reach the rules: its own folder's files are its work, the rest is judged", () => {
    const scope = { cwd: "C:\\Users\\ada\\work", folders: ["C:\\Users\\ada\\work"], home: "C:\\Users\\ada" };
    const prompt = (command: string) =>
      JSON.parse(runPermissionPrompt({ tool_name: "Bash", input: { command }, scope }, { canRun: true })) as {
        behavior: string;
        code?: string;
      };
    expect(prompt("icacls 'C:\\Users\\ada\\work\\build' //grant Everyone:F").behavior).toBe("allow");
    expect(prompt("icacls 'C:\\Users\\ada\\notes' //grant Everyone:F")).toMatchObject({
      behavior: "deny",
      code: "system",
    });
    expect(prompt("echo x > 'C:\\Users\\bob\\notes.txt'")).toMatchObject({ behavior: "deny", code: "otherUser" });
  });

  test("a search and a card that is itself the question open no approval in front of them", async () => {
    await world("always");
    const ctx = await runAs("person");
    expect({
      find: await outcome(ctx, WORKSPACE_ACTION, { find: "rename a channel" }),
      change: await outcome(ctx, WORKSPACE_ACTION, { action: "rename_channel", why: WHY }),
      members: await outcome(ctx, PROPOSE_MEMBERS, { id: "1" }),
      instructions: await outcome(ctx, PROPOSE_INSTRUCTIONS, { id: "1" }),
    }).toEqual({ find: "ran", change: "asked", members: "ran", instructions: "ran" });
  });

  test("a command's tools list their reason as required, as the call needs it", async () => {
    await world("always");
    const always = new Map((await tools().list(await runAs("person"))).map((t) => [t.name, t]));
    expect(requiresWhy(always.get(RUN_CODE.name))).toBe(true);
    await f.close();
    await world("risky");
    const risky = new Map((await tools().list(await runAs("person"))).map((t) => [t.name, t]));
    expect(requiresWhy(risky.get(RUN_CODE.name))).toBe(false);
  });
});

describe("opening a pull request", () => {
  test("no tool that opens one asks at the default level, on a routine's run or a fed one; a merge does", async () => {
    for (const kind of ["routine", "fed"] as const) {
      await world("risky");
      const ctx = await runAs(kind);
      expect({
        ours: await outcome(ctx, OPEN_PR, { id: "1" }),
        connector: await outcome(ctx, CREATE_PR, { id: "1" }),
        custom: await outcome(ctx, CUSTOM_PR, { id: "1" }),
        merge: await outcome(ctx, MERGE_PR),
      }).toEqual({ ours: "ran", connector: "ran", custom: "ran", merge: "asked" });
      expect(ran).toEqual([OPEN_PR.name, CREATE_PR.name, CUSTOM_PR.name]);
      await f.close();
    }
    f = undefined as unknown as Fixture;
  });

  test("a merge request is a pull request, and a tool that runs other actions is judged by the ones it runs", async () => {
    for (const authority of [routine, fed]) {
      expect(toolPolicy(authority, GITLAB_MR)).toEqual({ action: "allow" });
      expect(toolPolicy(authority, EXECUTOR)).toEqual({ action: "approve" });
    }
    await world("risky");
    const ctx = await runAs("routine");
    expect({
      gitlab: await outcome(ctx, GITLAB_MR, { id: "1" }),
      opens: await outcome(ctx, EXECUTOR, { slugs: ["GITHUB_CREATE_A_PULL_REQUEST", "GITLAB_CREATE_MERGE_REQUEST"] }),
      mixed: await outcome(ctx, EXECUTOR, { slugs: ["GITHUB_CREATE_A_PULL_REQUEST", "SHOP_UPDATE_ORDER"], why: WHY }),
      merge: await outcome(ctx, EXECUTOR, { slugs: ["GITHUB_MERGE_A_PULL_REQUEST"], why: WHY }),
    }).toEqual({ gitlab: "ran", opens: "ran", mixed: "asked", merge: "asked" });
  });

  test("an agent that always asks asks for it like any other change", async () => {
    await world("always");
    const ctx = await runAs("person");
    expect(await outcome(ctx, OPEN_PR)).toBe("asked");
    expect(await outcome(ctx, CREATE_PR)).toBe("asked");
    expect(ran).toEqual([]);
  });

  test("an agent that never asks merges too", async () => {
    await world("never");
    const ctx = await runAs("person");
    expect(await outcome(ctx, MERGE_PR, { id: "1" })).toBe("ran");
    expect(await toolCalls(MERGE_PR.name)).toEqual([{ outcome: "done", level: "never" }]);
  });
});

describe("what the agent is told", () => {
  test("the prompt's line on approvals follows the level: never a card it won't get, nor a change it won't be asked", () => {
    expect(approvalsLine("risky", false)).toContain("Actions marked sensitive (merge, deploy, rollback and similar)");
    const never = approvalsLine("never", false);
    expect(never).toContain("none of your tools waits for a person's approval");
    expect(never).toContain("don't ask before acting either, in words or with ask_user");
    expect(never).not.toContain("Actions marked sensitive");
    // A coding CLI's own shell still refuses these in its own words: the line says where the same command runs.
    expect(never).toContain("refuses a merge, a deploy or a publish, run the same command with run_code");
    const always = approvalsLine("always", false);
    expect(always).toContain("every call that changes something");
    expect(always).not.toContain("Actions marked sensitive");
  });

  test("an agent that never asks is not told to ask before a merge or a deploy by the rules every agent reads", () => {
    expect(HOW_YOU_WORK).toContain("before actions that can't be undone or leave the organization: merge, deploy");
    expect(howYouWork("risky", false)).toBe(HOW_YOU_WORK);
    expect(howYouWork("always", false)).toBe(HOW_YOU_WORK);
    for (const personal of [false, true]) {
      const never = howYouWork("never", personal);
      expect(never).not.toContain("before actions that can't be undone");
      expect(never).not.toContain("is asked with the action itself");
      expect(never).toContain("You are set to never ask before acting");
      expect(never).toContain("Never ask for a go first, in text or with `ask_user`");
      expect(never.split("\n")).toHaveLength(HOW_YOU_WORK.split("\n").length);
    }
  });
});

describe("a computer brain's turn", () => {
  test("carries the level when it isn't the default", () => {
    expect(LEVELS.map(asksOf)).toEqual([{ asks: "always" }, {}, { asks: "never" }]);
  });

  test("always: a brain whose own tools can't each reach our prompt, and an older runner, only read", () => {
    const work = { mode: "work" as const, branchPrefix: "agentes/dev/", asks: "always" as const };
    expect(askingPermissions(work, true)).toEqual(work);
    expect(askingPermissions(work, false)).toEqual({ ...work, mode: "plan" });
    // Never, the default level, and a turn that is already narrower stay as they are.
    for (const turn of [
      { mode: "work" as const, asks: "never" as const },
      { mode: "work" as const },
      { mode: "chat" as const, asks: "always" as const },
      undefined,
    ]) {
      expect(askingPermissions(turn, false)).toEqual(turn);
    }
  });
});

describe("who sets it", () => {
  test("a new agent asks for what is risky; whoever manages agents changes it, with a value we know", async () => {
    f = await setup();
    const defaults = { model: f.agent.model };
    const made = await createAgent(f.db, f.owner.id, f.org.id, { name: "Bia", handle: "bia" }, defaults);
    expect(made.approvalsLevel).toBe("risky");
    const member = await addMember(f.db, f.org.id, "member", "Caio");
    // Creating one's own agent is open to members; choosing how much it asks is not.
    await expect(
      createAgent(f.db, member.id, f.org.id, { name: "Edu", handle: "edu", approvalsLevel: "never" }, defaults),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateAgent(f.db, member.id, f.org.id, made.id, { approvalsLevel: "never" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      updateAgent(f.db, f.owner.id, f.org.id, made.id, { approvalsLevel: "sometimes" as ApprovalsLevel }),
    ).rejects.toBeInstanceOf(ValidationError);
    const admin = await addMember(f.db, f.org.id, "admin", "Davi");
    expect((await updateAgent(f.db, admin.id, f.org.id, made.id, { approvalsLevel: "never" })).approvalsLevel).toBe(
      "never",
    );
    const [audit] = await f.db
      .select({ details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "agent.updated"), eq(schema.auditLog.targetId, made.id)));
    expect(audit?.details).toMatchObject({ changed: ["approvalsLevel"], approvalsLevel: "never" });
  });
});

describe("the workspace's level", () => {
  const ownOf = async (agentId: string) =>
    (
      await f.db
        .select({ level: schema.agents.approvalsLevel, own: schema.agents.approvalsLevelOwn })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
    )[0];

  test("agents follow it until someone gives one its own choice, which a workspace change leaves alone", async () => {
    f = await setup();
    const defaults = { model: f.agent.model };
    const bia = await createAgent(f.db, f.owner.id, f.org.id, { name: "Bia", handle: "bia" }, defaults);
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).approvalsLevel).toBe("risky");
    expect(bia.approvalsLevelOwn).toBe(false);
    await updateAgent(f.db, f.owner.id, f.org.id, bia.id, { approvalsLevel: "always" });

    expect(await setWorkspaceApprovalsLevel(f.db, f.owner.id, f.org.id, "never")).toEqual({
      level: "never",
      ownAgents: 1,
    });
    expect(await approvalsLevelOf(f.db, f.org.id, f.agent.id)).toBe("never");
    expect(await ownOf(bia.id)).toEqual({ level: "always", own: true });
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).approvalsLevel).toBe("never");
    // A new agent starts where the workspace is, following it.
    const caio = await createAgent(f.db, f.owner.id, f.org.id, { name: "Caio", handle: "caio" }, defaults);
    expect({ level: caio.approvalsLevel, own: caio.approvalsLevelOwn }).toEqual({ level: "never", own: false });
    // Following it again (Desfazer after a first own choice) takes the workspace's level back.
    await updateAgent(f.db, f.owner.id, f.org.id, bia.id, { approvalsLevel: null });
    expect(await ownOf(bia.id)).toEqual({ level: "never", own: false });
  });

  test("the right hand starts where the workspace is, following it", async () => {
    f = await setup();
    await setWorkspaceApprovalsLevel(f.db, f.owner.id, f.org.id, "always");
    const id = await ensureRightHand(f.db, f.org.id);
    expect(id).toBeTruthy();
    expect(await ownOf(id ?? "")).toEqual({ level: "always", own: false });
  });

  test("for every agent, it also clears each agent's own choice", async () => {
    f = await setup();
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { approvalsLevel: "never" });
    expect(await setWorkspaceApprovalsLevel(f.db, f.owner.id, f.org.id, "always", { everyAgent: true })).toEqual({
      level: "always",
      ownAgents: 0,
    });
    expect(await ownOf(f.agent.id)).toEqual({ level: "always", own: false });
    const [audit] = await f.db
      .select({ details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "organization.approvals_level"));
    expect(audit?.details).toMatchObject({ approvalsLevel: "always", everyAgent: true, agents: 1 });
  });

  test("only who manages agents sets it, with a value we know", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "Caio");
    await expect(setWorkspaceApprovalsLevel(f.db, member.id, f.org.id, "never")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setWorkspaceApprovalsLevel(f.db, f.owner.id, f.org.id, "sometimes" as ApprovalsLevel),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(updateAgent(f.db, member.id, f.org.id, f.agent.id, { approvalsLevel: null })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await approvalsLevelOf(f.db, f.org.id, f.agent.id)).toBe("risky");
  });

  test("the migration keeps a level someone chose and lets the default one follow the workspace", async () => {
    f = await setup();
    const defaults = { model: f.agent.model };
    const bia = await createAgent(f.db, f.owner.id, f.org.id, { name: "Bia", handle: "bia" }, defaults);
    await f.db
      .update(schema.agents)
      .set({ approvalsLevel: "never", approvalsLevelOwn: false })
      .where(eq(schema.agents.id, bia.id));
    const file = await Bun.file(
      new URL("../../db/migrations/0278_workspace_approvals_level.sql", import.meta.url),
    ).text();
    const backfill = file.split("--> statement-breakpoint").at(-1) ?? "";
    await f.db.execute(sql.raw(backfill));
    expect(await ownOf(bia.id)).toEqual({ level: "never", own: true });
    expect(await ownOf(f.agent.id)).toEqual({ level: "risky", own: false });
  });
});
