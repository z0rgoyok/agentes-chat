import { describe, expect, test } from "bun:test";
import type { AccountAudience, AccountOrderGroup, AiHubAccount } from "@agenteschat/client";
import type { AiChoiceRow } from "@agenteschat/client/lib/ai-choice";
import {
  audienceLabel,
  audienceOf,
  choiceText,
  hubAccounts,
  hubLine,
  hubState,
  hubTitle,
  mayChange,
  orderDropOf,
  orderRows,
  withModel,
} from "../../src/features/ai/hub";
import { sectionsOf } from "../../src/features/shared/picker-sections";
import { reorderTarget } from "../../src/ui/reorder";
import { translator } from "./fixtures";

const NOW = new Date("2026-01-01T12:00:00Z");
const nobody: AccountAudience = { mode: "owner", userIds: [], roleIds: [] };

const account = (over: Partial<AiHubAccount> = {}): AiHubAccount =>
  ({
    id: "a1",
    kind: "claude_code",
    label: "Trabalho",
    named: true,
    plan: "max",
    status: "active",
    mine: false,
    ownerId: "u-walter",
    ownerName: "Walter Silva",
    provider: null,
    machineId: "m1",
    computer: "MacBook",
    usedBy: [],
    permissions: { manage: { ...nobody, mode: "admins" }, use: { ...nobody, mode: "everyone" }, reply: nobody },
    rights: { canManage: false, canSetManage: false, canUse: true, canReplyAll: false },
    ...over,
  }) as AiHubAccount;

const week = (used: number) => ({
  at: NOW.toISOString(),
  windows: [{ kind: "seven_day", usedPercent: used, resetsAt: "2026-01-03T15:40:00Z" }],
});

describe("an account's lines", () => {
  test("name alone, then plan and whose, the maker first on its detail", async () => {
    const t = await translator("pt-BR");
    const a = account();
    expect(hubTitle(t, a)).toBe("Trabalho");
    expect(hubLine(t, a)).toBe("Max · de Walter");
    expect(hubLine(t, a, true)).toBe("Claude · Max · de Walter");
    // The viewer's own unnamed account goes by its email, never the automatic "Claude 2".
    expect(hubTitle(t, account({ named: false, mine: true, label: "Claude 2", email: "ana@example.com" }))).toBe(
      "ana@example.com",
    );
  });

  test("the state line: signed out, at the limit, close to it, only its owner; nothing while fine", async () => {
    const t = await translator("pt-BR");
    expect(hubState(t, "pt-BR", account({ status: "signed_out" }), NOW)).toEqual({
      text: "Saiu da conta",
      tone: "amber",
    });
    expect(hubState(t, "pt-BR", account({ usage: week(100) as never }), NOW)?.tone).toBe("danger");
    expect(hubState(t, "pt-BR", account({ usage: week(88) as never }), NOW)).toEqual({
      text: "semana 88%",
      tone: "amber",
    });
    expect(hubState(t, "pt-BR", account({ usage: week(30) as never }), NOW)).toBeNull();
    const only = account({ permissions: { ...account().permissions, use: nobody } });
    expect(hubState(t, "pt-BR", only, NOW)).toEqual({ text: "Só Walter usa", tone: "muted" });
  });

  test("one row per account, by maker, the viewer's own first", () => {
    const rows = hubAccounts(
      {
        accounts: [
          account({ id: "c1", kind: "codex" }),
          account({ id: "a1" }),
          account({ id: "a1b", sameAs: "a1" }),
          account({ id: "a2", mine: true, ownerId: "me" }),
        ],
      },
      "me",
    );
    expect(rows.map((a) => a.id)).toEqual(["a2", "a1", "c1"]);
  });
});

describe("permissions", () => {
  test("in words, from the viewer's side", async () => {
    const t = await translator("pt-BR");
    const names = { role: (id: string) => (id === "r1" ? "Engenharia" : undefined), person: () => "João Lima" };
    expect(audienceLabel(t, "use", nobody, null, names)).toBe("Só você");
    expect(audienceLabel(t, "use", nobody, "Walter", names)).toBe("Só Walter");
    expect(audienceLabel(t, "reply", nobody, "Walter", names)).toBe("Só o dono do agente");
    expect(audienceLabel(t, "manage", { ...nobody, mode: "admins" }, null, names)).toBe("Você e administradores");
    expect(audienceLabel(t, "use", { ...nobody, mode: "roles", roleIds: ["r1"] }, null, names)).toBe("Engenharia");
    expect(audienceLabel(t, "use", { ...nobody, mode: "people", userIds: ["a", "b"] }, null, names)).toBe("2 pessoas");
    expect(audienceLabel(t, "use", { ...nobody, mode: "everyone" }, null, names)).toBe("Todos");
  });

  test("who may change which, and a mode keeps only its own list", () => {
    const owner = account({ rights: { canManage: true, canSetManage: true, canUse: true, canReplyAll: true } });
    const admin = account({ rights: { canManage: true, canSetManage: false, canUse: true, canReplyAll: true } });
    expect(mayChange(owner, "manage")).toBe(true);
    expect(mayChange(admin, "manage")).toBe(false);
    expect(mayChange(admin, "use")).toBe(true);
    expect(mayChange(account(), "reply")).toBe(false);
    const before = { mode: "people" as const, userIds: ["u1"], roleIds: ["r1"] };
    expect(audienceOf("people", before)).toEqual({ mode: "people", userIds: ["u1"], roleIds: [] });
    expect(audienceOf("everyone", before)).toEqual({ mode: "everyone", userIds: [], roleIds: [] });
  });
});

describe("the order of use", () => {
  const group = (accounts: Partial<AccountOrderGroup["accounts"][number]>[]): AccountOrderGroup => ({
    machineId: "m1",
    computer: "MacBook",
    kind: "claude_code",
    accounts: accounts.map((a) => ({ ...account(), canMove: true, movable: true, ...a })) as never,
  });

  test("signed-out accounts go to the end, skipped; logins of one account are one row", () => {
    const rows = orderRows(
      group([{ id: "a" }, { id: "b", status: "signed_out" }, { id: "c" }, { id: "c2", sameAs: "c" }]),
    );
    expect(rows.map((r) => [r.account.id, r.place])).toEqual([
      ["a", 1],
      ["c", 2],
      ["b", null],
    ]);
  });

  test("a drop lands before the row going up, after it going down", () => {
    const rows = orderRows(group([{ id: "a" }, { id: "b" }, { id: "c" }]));
    expect(orderDropOf(rows, 2, 0)).toEqual({ id: "c", onto: "a", where: "before" });
    expect(orderDropOf(rows, 0, 1)).toEqual({ id: "a", onto: "b", where: "after" });
    expect(orderDropOf(rows, 1, 1)).toBeNull();
  });

  test("a held row passes the rows whose middle it crosses, of any height", () => {
    const heights = [60, 80, 60, 100];
    expect(reorderTarget(heights, 0, 20)).toBe(0);
    expect(reorderTarget(heights, 0, 45)).toBe(1);
    expect(reorderTarget(heights, 0, 115)).toBe(2);
    expect(reorderTarget(heights, 3, -35)).toBe(2);
    expect(reorderTarget(heights, 3, -500)).toBe(0);
  });
});

describe("the one choice", () => {
  test("a dimmed account says why; a key says it is the workspace's default", async () => {
    const t = await translator("pt-BR");
    const row = (over: Partial<AiChoiceRow>): AiChoiceRow => ({
      key: "a1",
      type: "plan",
      group: "others",
      brain: "claude_code",
      account: account(),
      usable: true,
      selected: false,
      ...over,
    });
    expect(choiceText(t, row({}), "pt-BR", NOW)).toMatchObject({ label: "Trabalho", sub: "Max · de Walter" });
    expect(choiceText(t, row({ usable: false, reason: "owner_only" }), "pt-BR", NOW).sub).toBe("Só Walter usa");
    const key = row({
      key: "key:k1",
      type: "key",
      group: "keys",
      brain: "model",
      apiKey: { id: "k1", provider: "anthropic", label: "Claude da Acme", keyHint: "abcd", isDefault: true },
    });
    expect(choiceText(t, key, "pt-BR", NOW)).toMatchObject({
      label: "Claude da Acme",
      sub: "Chave de API · padrão do workspace",
    });
  });

  test("Automático picks the effort; a fixed model after it starts on medium", () => {
    const now = { brain: "claude_code" as const, account: "a1", model: null, effort: "high" as const };
    expect(withModel(now, "auto")).toMatchObject({ model: "auto", effort: "auto" });
    expect(withModel({ ...now, effort: "auto" }, "sonnet")).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(withModel(now, "opus")).toMatchObject({ model: "opus", effort: "high" });
  });

  test("the picker's options run under their section's header", () => {
    const groups = sectionsOf([
      { key: "w", label: "A do workspace" },
      { key: "a", label: "A", section: "Suas" },
      { key: "b", label: "B", section: "Suas" },
      { key: "k", label: "K", section: "Chaves de API" },
    ]);
    expect(groups.map((g) => [g.title ?? null, g.options.map((o) => o.key)])).toEqual([
      [null, ["w"]],
      ["Suas", ["a", "b"]],
      ["Chaves de API", ["k"]],
    ]);
  });
});
