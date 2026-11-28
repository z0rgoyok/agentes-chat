import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentBrain } from "../src/api/types";
import { brainLine, engineOfBrain, engineOfExecutor, engineStateOfOption, thinksWith } from "../src/lib/brain";
import {
  ADVANCED_DEFAULTS,
  advancedContents,
  advancedDefaults,
  advancedParts,
  effortLevelsFor,
  effortLevelsOf,
  effortOf,
  effortTextOf,
  isAdvancedDefault,
  shownEffort,
  viewSpeedFits,
} from "../src/lib/brain-advanced";
import { autoContextLine } from "../src/lib/context-limits";

describe("the engine an agent thinks with", () => {
  test("agents.brain maps to its engine; the API and anything unknown is the agent itself", () => {
    expect(engineOfBrain("claude_code")).toBe("claude_code");
    expect(engineOfBrain("codex")).toBe("codex");
    expect(engineOfBrain("model")).toBe("agent");
    expect(engineOfBrain("something_new")).toBe("agent");
    expect(engineOfBrain(null)).toBe("agent");
    expect(engineOfBrain(undefined)).toBe("agent");
  });

  test("a mission's executor maps to the same engines", () => {
    expect(engineOfExecutor("claude")).toBe("claude_code");
    expect(engineOfExecutor("codex")).toBe("codex");
    expect(engineOfExecutor("agent")).toBe("agent");
    expect(engineOfExecutor(null)).toBe("agent");
  });

  test("an option is off when it can't run now or its computer is offline; the API never is", () => {
    const online = { online: true };
    const offline = { online: false };
    expect(engineStateOfOption({ kind: "claude_code", available: true }, online)).toBe("idle");
    expect(engineStateOfOption({ kind: "claude_code", available: true }, offline)).toBe("off");
    expect(engineStateOfOption({ kind: "codex", available: false }, online)).toBe("off");
    expect(engineStateOfOption({ kind: "codex", available: true }, null)).toBe("idle");
    expect(engineStateOfOption({ kind: "model", available: true }, offline)).toBe("idle");
    expect(engineStateOfOption({ kind: "model", available: false })).toBe("idle");
  });
});

describe("what thinks, in one sentence", () => {
  const WORDS: Record<string, string> = {
    "brain.line.claude": "{{model}} pelo plano do Claude",
    "brain.line.chatgpt": "{{model}} pelo plano do ChatGPT",
    "brain.line.coding": "{{model}} pelo {{plan}}",
    "brain.line.claudeOf": "{{model}} pelo plano do Claude de {{owner}}",
    "brain.line.chatgptOf": "{{model}} pelo plano do ChatGPT de {{owner}}",
    "brain.line.codingOf": "{{model}} pelo {{plan}} de {{owner}}",
    "aiAccounts.connect.claude_code": "Claude",
    "aiAccounts.connect.codex": "ChatGPT",
    "brain.line.chatgptAuto": "Plano do ChatGPT",
    "brain.line.on": "{{line}} no {{computer}}",
  };
  const t = ((key: string, o: Record<string, string> = {}) =>
    (WORDS[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k: string) => o[k] ?? "")) as unknown as TFunction;

  test("the model by the plan that pays for it, and whose plan for someone who doesn't see its computer", () => {
    expect(thinksWith(t, "claude", "Sonnet")).toBe("Sonnet pelo plano do Claude");
    expect(thinksWith(t, "chatgpt", "GPT-6.1 Terra")).toBe("GPT-6.1 Terra pelo plano do ChatGPT");
    expect(thinksWith(t, "opencode", "DeepSeek V4.1 Flash")).toBe("DeepSeek V4.1 Flash pelo OpenCode Go");
    expect(thinksWith(t, "claude", "Sonnet", "João")).toBe("Sonnet pelo plano do Claude de João");
    expect(thinksWith(t, "chatgpt", "GPT-6 Sol", "João")).toBe("GPT-6 Sol pelo plano do ChatGPT de João");
    expect(thinksWith(t, "zai", "GLM-5.3", "João")).toBe("GLM-5.3 pelo GLM Coding de João");
  });

  test("an agent's line names the computer only beside another; the maker's mark stays, the API is its model's label", () => {
    expect(brainLine(t, { kind: "claude_code", model: "Sonnet", computer: "MacBook" }, "", { owner: "João" })).toEqual({
      text: "Sonnet pelo plano do Claude",
      kind: "claude_code",
      mark: "claude_code",
    });
    expect(brainLine(t, { kind: "claude_code", model: "Sonnet" }, "", { owner: "João" }).text).toBe(
      "Sonnet pelo plano do Claude de João",
    );
    expect(
      brainLine(
        t,
        { kind: "claude_code", model: "DeepSeek V4.1 Flash", provider: "opencode", computer: "MacBook" },
        "",
      ),
    ).toEqual({ text: "DeepSeek V4.1 Flash pelo OpenCode Go", kind: "claude_code", mark: "opencode" });
    expect(brainLine(t, { kind: "codex", model: "auto" }, "").text).toBe("Plano do ChatGPT");
    const two = [{ brain: { computer: "MacBook" } }, { brain: { computer: "Servidor" } }];
    expect(brainLine(t, { kind: "claude_code", model: "Sonnet", computer: "MacBook" }, "", { agents: two }).text).toBe(
      "Sonnet pelo plano do Claude no MacBook",
    );
    expect(brainLine(t, { kind: "model", model: null }, "Claude Sonnet 5.5")).toEqual({
      text: "Claude Sonnet 5.5",
      kind: "agent",
      mark: null,
    });
    // Automático on the API: the maker its models come from, never a generic mark.
    expect(brainLine(t, { kind: "model", model: null, maker: "openai" }, "Automático").mark).toBe("openai");
  });
});

describe("Velocidade (ADR 0149)", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  type Fits = Parameters<typeof viewSpeedFits>[0];
  const view = (over: Partial<Fits> = {}): Fits => ({
    brain: "codex",
    effectiveModel: "gpt-6.1-sol",
    account: null,
    accounts: [],
    ...over,
  });

  test("shows on a ChatGPT sign-in with a model that has it, Automático included", () => {
    expect(viewSpeedFits(view())).toBe(true);
    expect(viewSpeedFits(view({ effectiveModel: "auto" }))).toBe(true);
    expect(
      viewSpeedFits(view({ account: "a", accounts: [{ id: "a", provider: null } as AgentBrain["accounts"][number]] })),
    ).toBe(true);
  });

  test("hides on any other model, brain or sign-in, and on the right hand", () => {
    expect(viewSpeedFits(view({ effectiveModel: "gpt-5.5" }))).toBe(false);
    expect(viewSpeedFits(view({ brain: "claude_code", effectiveModel: "sonnet" }))).toBe(false);
    expect(viewSpeedFits(view({ brain: "model", effectiveModel: null }))).toBe(false);
    expect(viewSpeedFits(view({ scope: "workspace" }))).toBe(false);
    expect(viewSpeedFits(view({ scope: "mine" }))).toBe(false);
  });

  test("the advanced settings hold no API switch: nothing says it waits for the computer", () => {
    expect(ADVANCED_DEFAULTS).not.toHaveProperty("fallback");
    expect(advancedParts(t, "pt-BR", { kind: "claude_code", autoModel: false, now: ADVANCED_DEFAULTS })).toEqual([]);
    expect(isAdvancedDefault("claude_code", ADVANCED_DEFAULTS)).toBe(true);
  });

  test("Só esta conta counts as a change from the defaults, and Voltar ao padrão turns it off", () => {
    const pinned = { ...ADVANCED_DEFAULTS, accountPinned: true };
    expect(advancedParts(t, "pt-BR", { kind: "claude_code", autoModel: false, now: pinned })).toEqual([
      "agentPage.work.brain.pinned",
    ]);
    expect(isAdvancedDefault("claude_code", pinned)).toBe(false);
    expect(advancedDefaults("claude_code", pinned)).toEqual({ ...ADVANCED_DEFAULTS, accountPinned: false });
    expect(isAdvancedDefault("claude_code", { ...ADVANCED_DEFAULTS, accountPinned: false })).toBe(true);
  });

  test("Rápida counts as a change from the defaults and is named wherever they are", () => {
    const now = { ...ADVANCED_DEFAULTS, speed: "fast" as const };
    expect(isAdvancedDefault("codex", now)).toBe(false);
    expect(advancedParts(t, "pt-BR", { kind: "codex", autoModel: false, now })).toEqual([
      "agentPage.work.brain.advanced.speed",
    ]);
    expect(advancedParts(t, "pt-BR", { kind: "codex", autoModel: false, now: ADVANCED_DEFAULTS })).toEqual([]);
    expect(advancedContents(t, { kind: "codex", autoModel: false, speed: true })).toBe(
      "agentPage.work.brain.advanced.contents.fixedSpeed",
    );
    expect(advancedContents(t, { kind: "codex", autoModel: true, speed: true })).toBe(
      "agentPage.work.brain.advanced.contents.autoSpeed",
    );
    expect(advancedContents(t, { kind: "codex", autoModel: false })).toBe(
      "agentPage.work.brain.advanced.contents.fixed",
    );
  });

  test("an API key with a fixed model has an effort; on Automático only its context", () => {
    const high = { ...ADVANCED_DEFAULTS, effort: "high" as const };
    expect(advancedContents(t, { kind: "model", autoModel: false })).toBe(
      "agentPage.work.brain.advanced.contents.modelFixed",
    );
    expect(advancedContents(t, { kind: "model", autoModel: true })).toBe(
      "agentPage.work.brain.advanced.contents.model",
    );
    expect(advancedParts(t, "pt-BR", { kind: "model", autoModel: false, now: high })).toEqual([
      "agentPage.work.brain.advanced.effort",
    ]);
    expect(advancedParts(t, "pt-BR", { kind: "model", autoModel: true, now: high })).toEqual([]);
    expect(isAdvancedDefault("model", high)).toBe(false);
    // "Voltar ao padrão" on a key: no effort, the provider's default; a chosen medium is a level there, said as one.
    expect(advancedDefaults("model", high).effort).toBeNull();
    expect(isAdvancedDefault("model", { ...ADVANCED_DEFAULTS, effort: null })).toBe(true);
    const medium = { ...ADVANCED_DEFAULTS, effort: "medium" as const };
    expect(advancedParts(t, "pt-BR", { kind: "model", autoModel: false, now: medium })).toEqual([
      "agentPage.work.brain.advanced.effort",
    ]);
    expect(advancedParts(t, "pt-BR", { kind: "claude_code", autoModel: false, now: medium })).toEqual([]);
  });

  test("each model offers the levels its catalog row lists, else up to high; a stored level shows as stored", () => {
    expect(effortLevelsOf("model", "claude-sonnet-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsOf("claude_code", "claude-opus-5-5[1m]")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsOf("model", "gpt-6.2-sol")).toEqual(["low", "medium", "high"]);
    expect(effortLevelsOf("claude_code", "some-plan-model")).toEqual(["low", "medium", "high"]);
    expect(effortLevelsOf("codex", "gpt-6.2-sol")).toEqual(["low", "medium", "high"]);
    expect(effortLevelsOf("antigravity", "gemini-4-argon-high")).toEqual([]);
    expect(effortLevelsOf("cursor", "claude-opus-5-5")).toEqual([]);
    // The pickers before the one AI choice name no model: their fixed lists.
    expect(effortLevelsOf("claude_code")).toEqual(["low", "medium", "high", "max"]);
    expect(effortLevelsOf("model")).toEqual(["low", "medium", "high"]);
    // A brain's default and its aliases go by their catalog id.
    const claude = [
      {
        kind: "claude_code" as const,
        models: [{ value: "sonnet", label: "Sonnet", modelId: "claude-sonnet-5-5" }],
        defaultModel: "sonnet",
      },
    ];
    expect(effortLevelsFor("claude_code", null, claude)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // A Devin family takes the levels its account listed for it, past high too.
    const devin = [
      {
        kind: "devin" as const,
        models: [{ value: "swe-2", label: "SWE-2", efforts: ["medium" as const, "high" as const, "max" as const] }],
        defaultModel: null,
      },
    ];
    expect(effortLevelsFor("devin", "swe-2", devin)).toEqual(["medium", "high", "max"]);
    expect(shownEffort("max", ["low", "medium", "high"])).toBe("high");
    expect(shownEffort("xhigh", ["low", "medium", "high", "xhigh", "max"])).toBe("xhigh");
    expect([null, "auto", "low", "medium", "high", "xhigh", "max"].map((e) => effortOf("model", e))).toEqual([
      null,
      null,
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect([null, "auto", "max"].map((e) => effortOf("codex", e))).toEqual(["medium", "medium", "max"]);
    expect(([null, "medium", "high"] as const).map((e) => effortTextOf("model", e))).toEqual([
      "none",
      "mediumKey",
      "high",
    ]);
    expect(effortTextOf("codex", "medium")).toBe("medium");
  });
});

describe("the line under Automático for the context", () => {
  const t = ((key: string, o: Record<string, string> = {}) =>
    o.size ? `${key} ${o.size}` : key) as unknown as TFunction;

  test("Claude Code and Codex say they summarise at 200K; other programs and a key, the model's window", () => {
    expect(autoContextLine(t, "claude_code")).toBe("agentPage.work.brain.contextText.autoSummarizes 200K");
    expect(autoContextLine(t, "codex")).toBe("agentPage.work.brain.contextText.autoSummarizes 200K");
    for (const kind of ["model", "cursor", "opencode", "antigravity", null])
      expect(autoContextLine(t, kind)).toBe("agentPage.work.brain.contextText.auto");
  });
});
