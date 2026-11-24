import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { currentOf } from "../src/api/ai-hub";
import type { AccountAudience, AiHub, AiHubAccount, AiHubKey, BrainOption, Model } from "../src/api/types";
import { accountChain } from "../src/lib/ai-accounts";
import {
  type AiChoiceContext,
  aiChoiceBrainInput,
  aiChoiceEfforts,
  aiChoiceModels,
  aiChoiceOf,
  aiChoiceRows,
  aiChoiceSetup,
} from "../src/lib/ai-choice";

const t = ((key: string) => key) as TFunction;
const all: AccountAudience = { mode: "everyone", userIds: [], roleIds: [] };
const only: AccountAudience = { mode: "owner", userIds: [], roleIds: [] };

const account = (id: string, over: Partial<AiHubAccount> = {}): AiHubAccount => ({
  id,
  kind: "claude_code",
  label: `Conta ${id}`,
  email: null,
  plan: "max",
  status: "active",
  ownerId: "u_walter",
  ownerName: "Walter",
  mine: false,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  shared: true,
  useOrder: null,
  sameAs: id,
  movable: true,
  machineId: "m1",
  computer: "MacBook",
  permissions: { manage: { mode: "admins", userIds: [], roleIds: [] }, use: all, reply: only },
  rights: { canManage: false, canSetManage: false, canUse: true, canReplyAll: false },
  ...over,
});

const key = (id: string, over: Partial<AiHubKey> = {}): AiHubKey => ({
  id,
  provider: "anthropic",
  label: `Chave ${id}`,
  keyHint: "AbCd",
  isDefault: false,
  ...over,
});

const hub = (accounts: AiHubAccount[], keys: AiHubKey[] = []): AiHub => ({
  accounts,
  keys,
  order: [],
  keyFallback: false,
  canManageKeys: false,
  canConfigure: false,
});

const ctx = (over: Partial<AiChoiceContext> = {}): AiChoiceContext => ({
  target: { kind: "agent", agentId: "a1" },
  viewerId: "u_ana",
  current: null,
  ...over,
});

describe("aiChoiceRows: one list for every picker", () => {
  test("the viewer's own first, then others', then keys; by maker, then the order of use", () => {
    const h = hub(
      [
        account("w1", { useOrder: 1 }),
        account("x1", { kind: "codex" }),
        account("w0", { useOrder: 0 }),
        account("a1", { ownerId: "u_ana", ownerName: "Ana", mine: true }),
      ],
      [key("k1", { isDefault: true }), key("k2", { provider: "openai" })],
    );
    const rows = aiChoiceRows(h, ctx());
    expect(rows.map((r) => [r.key, r.group])).toEqual([
      ["a1", "yours"],
      ["w0", "others"],
      ["w1", "others"],
      ["x1", "others"],
      ["key:k1", "keys"],
      ["key:k2", "keys"],
    ]);
  });

  test("an agent's computer only, and the server's word on what may think for it; unusable rows stay, dimmed with why", () => {
    const h = hub([
      account("w1"),
      account("w2", {
        rights: { canManage: false, canSetManage: false, canUse: false, useReason: "owner_only", canReplyAll: false },
      }),
      account("gone", { status: "signed_out" }),
      account("far", { machineId: "m2" }),
    ]);
    const rows = aiChoiceRows(h, ctx({ machineId: "m1", usable: new Set(["w1"]) }));
    expect(rows.map((r) => [r.key, r.usable, r.reason ?? null])).toEqual([
      ["w1", true, null],
      ["w2", false, "owner_only"],
      ["gone", false, "signed_out"],
    ]);
  });

  test("the logins of one account are one row, the one thinking selected", () => {
    const h = hub([account("l1", { sameAs: "l1" }), account("l2", { sameAs: "l1" })]);
    const rows = aiChoiceRows(h, ctx({ current: { brain: "claude_code", account: "l2" } }));
    expect(rows.map((r) => [r.key, r.selected])).toEqual([["l2", true]]);
  });

  test("Lodi: A do workspace first for the viewer's own, no keys there; the workspace's takes only accounts everyone uses", () => {
    const h = hub(
      [account("w1"), account("w2", { permissions: { manage: only, use: only, reply: only } })],
      [key("k1")],
    );
    const mine = aiChoiceRows(h, ctx({ target: { kind: "lodi", agentId: "l", scope: "mine" } }));
    expect(mine.map((r) => [r.key, r.selected])).toEqual([
      ["workspace", true],
      ["w1", false],
      ["w2", false],
    ]);
    const workspace = aiChoiceRows(h, ctx({ target: { kind: "lodi", agentId: "l", scope: "workspace" } }));
    expect(workspace.map((r) => [r.key, r.usable])).toEqual([
      ["w1", true],
      ["w2", false],
      ["key:k1", true],
    ]);
  });

  test("a mission picks a brain; an Automático tier its provider's keys", () => {
    const options: BrainOption[] = [
      { kind: "claude_code", available: true, models: [], defaultModel: null },
      { kind: "model", available: false, models: [], defaultModel: null },
    ];
    const mission = aiChoiceRows(hub([account("w1")]), {
      ...ctx({ target: { kind: "mission", missionId: "m" }, current: { brain: "claude_code" } }),
      brains: options,
    });
    expect(mission.map((r) => [r.key, r.type, r.usable, r.selected])).toEqual([
      ["claude_code", "brain", true, true],
      ["model", "brain", false, false],
    ]);
    const tier = aiChoiceRows(hub([account("w1")], [key("k1"), key("or", { provider: "openrouter" })]), {
      ...ctx({ target: { kind: "autoTier", provider: "openrouter", tier: "small" } }),
    });
    expect(tier.map((r) => r.key)).toEqual(["key:or"]);
  });

  test("an older server without the hub: no rows, nothing breaks", () => {
    expect(aiChoiceRows(null, ctx())).toEqual([]);
  });
});

describe("what a row chooses and saves", () => {
  test("the model and effort stay while the brain stays; a key by its id, the default as null", () => {
    const [plan, def, other] = aiChoiceRows(hub([account("w1")], [key("k1", { isDefault: true }), key("k2")]), ctx());
    if (!plan || !def || !other) throw new Error("rows");
    const current = { brain: "claude_code" as const, account: "w0", model: "opus", effort: "high" as const };
    expect(aiChoiceOf(plan, current)).toEqual({
      brain: "claude_code",
      account: "w1",
      machineId: "m1",
      model: "opus",
      effort: "high",
    });
    expect(aiChoiceOf(def, current)).toEqual({ brain: "model", key: null, model: null, effort: null });
    expect(aiChoiceOf(other, null)).toMatchObject({ brain: "model", key: "k2" });
    expect(aiChoiceBrainInput(aiChoiceOf(plan, current), "mine")).toEqual({
      scope: "mine",
      brain: "claude_code",
      account: "w1",
      model: "opus",
      effort: "high",
    });
    expect(aiChoiceSetup(aiChoiceOf(other, null))).toEqual({ brain: "model", model: null, key: "k2", effort: null });
    expect(aiChoiceSetup(aiChoiceOf(plan, current))).toMatchObject({ machineId: "m1", account: "w1" });
  });

  test("models: a key's from its provider's catalog with Automático first; efforts by brain", () => {
    const [k] = aiChoiceRows(hub([], [key("k1")]), ctx());
    if (!k) throw new Error("row");
    const models: Model[] = [
      { id: "claude-a", label: "Claude A", provider: "anthropic", inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
      { id: "gpt-b", label: "GPT B", provider: "openai", inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
    ];
    const rows = aiChoiceModels(t, k, { current: { brain: "model", model: "claude-a" }, options: [], models });
    expect(rows.map((r) => [r.value, r.checked])).toEqual([
      ["auto", false],
      ["claude-a", true],
    ]);
    expect(aiChoiceEfforts(k)).toEqual(["low", "medium", "high"]);
  });

  test("the current choice as each target's own view says it", () => {
    expect(
      currentOf(
        { kind: "agent", agentId: "a" },
        {
          brain: { brain: "claude_code", account: "w1", model: null, effort: "auto", computer: { machineId: "m1" } },
        },
      ),
    ).toEqual({ brain: "claude_code", account: "w1", machineId: "m1", model: null, effort: "auto" });
    expect(
      currentOf(
        { kind: "autoTier", provider: "openrouter", tier: "large" },
        { autoModels: { openrouter: { large: "x/y" } } },
      ),
    ).toEqual({ brain: "model", model: "x/y" });
    expect(currentOf({ kind: "agents", agentIds: ["a"] }, {})).toBeNull();
  });
});

describe("accountChain follows the one order and the server's word", () => {
  test("its owner's first, then by place; an account that can't serve the agent's owner is skipped", () => {
    const own = account("own", { ownerId: "u_ana", mine: true });
    const chain = accountChain(
      [
        own,
        account("w1", { useOrder: 1 }),
        account("w0", { useOrder: 0 }),
        account("no", { usable: false }),
        account("a2", { ownerId: "u_ana" }),
      ],
      { id: "agent", ownerId: "u_ana", account: "own" },
    );
    expect(chain.map((a) => a.id)).toEqual(["own", "a2", "w0", "w1"]);
  });
});
