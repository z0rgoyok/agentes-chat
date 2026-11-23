import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { waitsForComputer } from "../src/lib/machine-outages";
import { serverBody } from "../src/lib/message-body";
import { modelLimitText, modelStandInKey, modelStandInText, usageWhen } from "../src/lib/plan-usage";
import { accountMovedText, chainWaitText, planLimitNote, usageCheckedText, usageWaitFix } from "../src/lib/usage-pause";

/** Says the key and its values, so a test reads which words were picked. */
const t = ((key: string, values: Record<string, unknown> = {}) => {
  const { defaultValue: _, ...rest } = values;
  return `${key} ${JSON.stringify(rest)}`;
}) as unknown as TFunction;

test("a note about a plan's limit or the budget says when, in the reader's zone", () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 60_000).toISOString();
  const body = serverBody(
    t,
    "fallback",
    { bodyCode: "plan_limit_cut", bodyParams: { plan: "Claude" }, usageWait: { code: "plan_limit", resetsAt: soon } },
    "en",
  );
  expect(body.startsWith("chat.body.plan_limit_cut ")).toBe(true);
  expect(body).toContain('"plan":"Claude"');
  expect(body).toContain("chat.usageWhen.");
  // Not known: the note's own words, with no time.
  expect(serverBody(t, "x", { bodyCode: "plan_limit_wait_unknown", bodyParams: { plan: "Kimi" } }, "en")).toBe(
    'chat.body.plan_limit_wait_unknown {"plan":"Kimi","when":""}',
  );
  // An older note about the limit, sent as the computer being unavailable, says the plan's words.
  expect(
    serverBody(t, "x", {
      bodyCode: "brain_unavailable",
      bodyParams: { brain: "Codex" },
      brainUnavailable: { code: "plan_limit" },
    }),
  ).toBe('chat.body.plan_limit_wait_unknown {"plan":"ChatGPT"}');
});

test("usageWhen: the time today, the weekday this week, else the date", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  expect(usageWhen(t, "en", "2026-11-04T15:40:00Z", now)).toStartWith("chat.usageWhen.at");
  expect(usageWhen(t, "pt-BR", "2026-11-06T13:00:00Z", now)).toStartWith("chat.usageWhen.on");
  expect(usageWhen(t, "pt-BR", "2026-11-06T13:00:00Z", now)).not.toContain("-feira");
  expect(usageWhen(t, "pt-BR", "2026-12-01T12:00:00Z", now)).toContain("1º de dezembro");
});

test("a plan's limit never becomes the waiting card that says the computer is back", () => {
  expect(waitsForComputer({ machineId: "m1", code: "machine_offline" })).toBe(true);
  expect(waitsForComputer({ machineId: "m1", code: "plan_limit" })).toBe(false);
  expect(waitsForComputer({ machineId: "m1", code: "busy" })).toBe(false);
  expect(waitsForComputer({ machineId: null, code: "machine_offline" })).toBe(false);
});

test("a catch-up skipped as already handled says why in place of its promise, and who asked for an answer anyway", () => {
  const usageWait = {
    code: "plan_limit",
    runId: "r1",
    ended: true,
    closed: { reason: "solved", who: { name: "Nina" }, askers: ["u1"], at: new Date().toISOString() },
  };
  const meta = { bodyCode: "plan_limit_wait", bodyParams: { plan: "Claude" }, usageWait };
  expect(serverBody(t, "x", meta, "en")).toBe('chat.body.usage_wait_closed_solved {"name":"Nina"}');
  expect(
    serverBody(t, "x", { ...meta, usageWait: { ...usageWait, continuedByUserId: "u1", continuedByName: "Ana" } }, "en"),
  ).toBe('chat.body.usage_wait_closed_solved {"name":"Nina"}\n\n_chat.body.usage_wait_anyway {"name":"Ana"}_');
  // A reason the app doesn't know: the note keeps its own words.
  const odd = { ...meta, usageWait: { ...usageWait, closed: { reason: "weird" } } };
  expect(serverBody(t, "x", odd, "en").startsWith("chat.body.plan_limit_wait ")).toBe(true);
});

test("a model's own limit: the note names the model and the way out, the brain card says it under the plan's meters", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const until = "2026-11-05T05:44:00.000Z";
  const note = serverBody(
    t,
    "x",
    {
      bodyCode: "plan_model_limit_wait",
      bodyParams: { plan: "OpenCode Go", model: "DeepSeek V4.1 Flash", agent: "Lia" },
      usageWait: { code: "plan_limit", resetsAt: until },
    },
    "en",
  );
  expect(note.startsWith("chat.body.plan_model_limit_wait ")).toBe(true);
  expect(note).toContain('"model":"DeepSeek V4.1 Flash","agent":"Lia"');
  expect(serverBody(t, "x", { bodyCode: "plan_model_region_wait", bodyParams: { model: "DeepSeek V4.1 Flash" } })).toBe(
    'chat.body.plan_model_region_wait {"model":"DeepSeek V4.1 Flash","when":""}',
  );
  const at = now.toISOString();
  const models = { "deepseek-v4.1-flash": { at, until } };
  const usage = { models };
  expect(modelLimitText(t, "en", usage, "opencode", "deepseek-v4.1-flash", now)).toStartWith("brain.modelLimit ");
  expect(modelLimitText(t, "en", usage, "opencode", "glm-5.3", now)).toBeNull();
  // Only a plan whose models have their own limits, and only while the limit holds.
  expect(modelLimitText(t, "en", usage, "zai", "deepseek-v4.1-flash", now)).toBeNull();
  expect(modelLimitText(t, "en", usage, "opencode", "deepseek-v4.1-flash", new Date(until))).toBeNull();
  const region = { models: { "deepseek-v4.1-flash": { at, region: true as const } } };
  expect(modelLimitText(t, "en", region, "opencode", "deepseek-v4.1-flash", now)).toBe(
    'brain.modelRegion {"model":"DeepSeek V4.1 Flash"}',
  );
  // The region holds until something changes: the key, the model chosen again, a turn on it going through.
  expect(modelLimitText(t, "en", region, "opencode", "deepseek-v4.1-flash", new Date(now.getTime() + 86_400_000))).toBe(
    'brain.modelRegion {"model":"DeepSeek V4.1 Flash"}',
  );
  // Refused for the key: the model or the account switched off in OpenCode.
  const off = { models: { "minimax-m3": { at, off: true as const } } };
  expect(modelLimitText(t, "en", off, "opencode", "sonnet", now)).toBe('brain.modelOff {"model":"MiniMax M3"}');
  expect(
    serverBody(t, "x", { bodyCode: "plan_model_off_wait", bodyParams: { model: "MiniMax M3", agent: "Lia" } }),
  ).toBe('chat.body.plan_model_off_wait {"model":"MiniMax M3","agent":"Lia","when":""}');
  // No active Go subscription on the key's account: the account's words, and no other model offered.
  const inactive = { models: { "minimax-m3": { at, inactive: true as const } } };
  expect(modelLimitText(t, "en", inactive, "opencode", "sonnet", now)).toBe("brain.planInactive {}");
  expect(serverBody(t, "x", { bodyCode: "plan_inactive_wait", bodyParams: { model: "MiniMax M3" } })).toBe(
    'chat.body.plan_inactive_wait {"model":"MiniMax M3","when":""}',
  );
  expect(usageWaitFix({ bodyCode: "plan_inactive_wait" }, { admin: true, owner: true })).toBeNull();
  // Automático answered with another model: the line under the reply, and nothing for a malformed or absent one.
  const standIn = { modelStandIn: { plan: "OpenCode Go", from: "MiniMax M3", to: "GLM-5.3" } };
  expect(modelStandInText(t, standIn)).toBe(
    'chat.modelStandIn.text {"plan":"OpenCode Go","from":"MiniMax M3","to":"GLM-5.3"}',
  );
  expect(modelStandInText(t, { modelStandIn: { plan: "x", from: 1, to: "y" } })).toBeNull();
  expect(modelStandInText(t, {})).toBeNull();
  // Its key, for "Usar o GLM-5.3 em todos": only on a reply that says which computer and account it ran on.
  expect(modelStandInKey(standIn)).toBeNull();
  expect(
    modelStandInKey({ modelStandIn: { ...standIn.modelStandIn, model: "glm-5.3", machineId: "m1", account: "a1" } }),
  ).toEqual({ machineId: "m1", account: "a1", model: "glm-5.3", to: "GLM-5.3" });
});

test("a wait's way out: another model for its owner or an admin, a higher budget for an admin, none for a plan's limit", () => {
  const anyone = { admin: false, owner: false };
  const owner = { admin: false, owner: true };
  const admin = { admin: true, owner: false };
  for (const bodyCode of [
    "plan_model_limit_wait",
    "plan_model_limit_wait_unknown",
    "plan_model_region_wait",
    "plan_model_off_wait",
  ]) {
    expect(usageWaitFix({ bodyCode }, owner)).toBe("changeModel");
    expect(usageWaitFix({ bodyCode }, admin)).toBe("changeModel");
    expect(usageWaitFix({ bodyCode }, anyone)).toBeNull();
  }
  expect(usageWaitFix({ bodyCode: "budget_wait" }, admin)).toBe("raiseBudget");
  expect(usageWaitFix({ bodyCode: "budget_wait" }, owner)).toBeNull();
  expect(usageWaitFix({ bodyCode: "plan_limit_wait" }, admin)).toBeNull();
});

test("a plan limit's note says when the plan was last checked; no other note does", () => {
  const now = Date.parse("2030-01-01T12:00:00.000Z");
  const four = new Date(now - 4 * 60_000).toISOString();
  expect(usageCheckedText(t, { bodyCode: "plan_limit_wait" }, four, now)).toBe(
    'usageCard.checked {"when":"format.minutesAgo {\\"count\\":4}"}',
  );
  expect(usageCheckedText(t, { bodyCode: "plan_model_off_wait" }, four, now)).toBeNull();
  expect(usageCheckedText(t, { bodyCode: "plan_limit_wait" }, null, now)).toBeNull();
  expect(planLimitNote({ bodyCode: "plan_limit_cut_unknown" })).toBe(true);
  expect(planLimitNote({ bodyCode: "budget_wait" })).toBe(false);
});

test("every account of the order at its limit: how many and when the first resets, as a plan limit's note", () => {
  const soon = new Date(Date.now() + 60_000).toISOString();
  const body = serverBody(
    t,
    "fallback",
    {
      bodyCode: "plan_limit_all_wait",
      bodyParams: { plan: "Claude", accounts: "3" },
      usageWait: { code: "plan_limit", resetsAt: soon },
    },
    "en",
  );
  expect(body.startsWith("chat.body.plan_limit_all_wait ")).toBe(true);
  expect(body).toContain('"accounts":"3"');
  expect(body).toContain("chat.usageWhen.");
  expect(planLimitNote({ bodyCode: "plan_limit_all_wait_unknown" })).toBe(true);
  // The line of a move says which accounts, in the reader's words.
  expect(serverBody(t, "x", { bodyCode: "plan_account_moved", bodyParams: { from: "Trabalho", to: "Pessoal" } })).toBe(
    'chat.body.plan_account_moved {"from":"Trabalho","to":"Pessoal"}',
  );
});

test("an agent's line with every account of the order at its limit: the note's words, with when the first resets", () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 60_000).toISOString();
  const all = chainWaitText(t, "en", { plan: "Claude", resetsAt: soon, chain: 3 }, now);
  expect(all?.startsWith('chat.body.plan_limit_all_wait {"accounts":"3","plan":"Claude","when":"chat.usageWhen.')).toBe(
    true,
  );
  expect(chainWaitText(t, "en", { plan: "Claude", resetsAt: null, chain: 2 })).toBe(
    'chat.body.plan_limit_all_wait_unknown {"accounts":"2","plan":"Claude"}',
  );
  // One account waiting, or an older server: nothing to say about the order.
  expect(chainWaitText(t, "en", { plan: "Claude", resetsAt: soon, chain: null })).toBeNull();
  expect(chainWaitText(t, "en", { plan: "Claude", resetsAt: soon })).toBeNull();
  expect(accountMovedText(t, { from: "Trabalho", to: "Pessoal" })).toBe(
    'chat.body.plan_account_moved {"from":"Trabalho","to":"Pessoal"}',
  );
});
