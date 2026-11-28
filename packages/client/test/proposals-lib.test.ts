import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Proposal } from "../src/api/types";
import {
  appLabel,
  cardHead,
  cardProposalIds,
  changedLines,
  memoryLine,
  messageProposalCards,
  pendingOnAgent,
  proposalSections,
  proposalTarget,
  proposalTitle,
  proposalWhy,
  proposerOf,
  removalOf,
  settingLineText,
} from "../src/lib/proposals";

const t = ((key: string, o?: Record<string, unknown>) =>
  o && "defaultValue" in o
    ? `${key}=${o.defaultValue}`
    : o
      ? `${key} ${JSON.stringify(o)}`
      : key) as unknown as TFunction;

const row = (id: string, patch: Partial<Proposal> = {}): Proposal => ({
  id,
  agentId: `agent-${id}`,
  proposedByAgentId: "theo",
  target: { type: "agent_instructions", agentId: `agent-${id}` },
  title: "",
  why: "",
  evidence: [],
  before: "Seja breve.",
  after: "Seja breve.\n\n## Learned\n- Responder em português.",
  status: "pending",
  stale: false,
  canDecide: true,
  decider: { type: "admins" },
  createdAt: "2026-10-31T12:00:00.000Z",
  decidedBy: null,
  decidedByAgent: null,
  review: null,
  reviewed: false,
  undoable: false,
  undoneBy: null,
  undoneAt: null,
  decidedAt: null,
  ...patch,
});
const role = (id: string, patch: Partial<Proposal> = {}) =>
  row(id, { target: { type: "agent_role", agentId: `agent-${id}` }, before: "Dev", after: "Revisora", ...patch });
const access = (id: string, patch: Partial<Proposal> = {}) =>
  row(id, {
    target: { type: "agent_access", agentId: `agent-${id}` },
    before: "",
    after: "",
    access: [{ id: "browser:use", label: "Use a browser", on: false }],
    ...patch,
  });

describe("what waits on an agent's page", () => {
  test("its instructions and the skills it asked to change, nothing decided or another agent's", () => {
    const skill = row("a", {
      agentId: "ada",
      target: { type: "skill", agentId: "ada", skillId: "s", name: "relatorios" },
    });
    const list = [
      row("b", { agentId: "ada", target: { type: "agent_instructions", agentId: "ada" } }),
      skill,
      row("c", { agentId: "ada", target: { type: "agent_role", agentId: "ada" } }),
      row("d", { agentId: "theo", target: { type: "agent_instructions", agentId: "theo" } }),
      { ...skill, id: "e", status: "accepted" as const },
      // Applied and then put back (ADR 0219): nothing for the review to weigh.
      { ...skill, id: "f", status: "undone" as const },
    ];
    expect(pendingOnAgent(list, "ada").map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("a skill on a card", () => {
  test("reads as a text change, so the phone's card shows its lines", () => {
    const skill = row("a", {
      target: { type: "skill", agentId: "agent-a", skillId: "s", name: "relatorios" },
      before: "# Passos",
      after: "# Passos\n1. Conferir os totais.",
    });
    expect(proposalSections([skill])).toMatchObject([
      { kind: "text", lines: [{ kind: "add", text: "1. Conferir os totais." }], rows: [{ id: "a" }] },
    ]);
  });
});

describe("a name and a look on a settings card", () => {
  const names = { model: (id: string) => id, person: () => undefined, channel: () => undefined, role: () => undefined };
  test("a name reads as itself, a look in words, a custom color as its code", () => {
    expect(settingLineText(t, "pt-BR", { field: "name", from: "Dev", to: "Ada" }, names)).toEqual({
      field: "rightHand.field.name",
      from: "Dev",
      to: "Ada",
    });
    const line = settingLineText(
      t,
      "pt-BR",
      { field: "look", from: null, to: { color: "#123456", eyes: "happy", accessory: "crown" } },
      names,
    );
    expect(line.from).toBe("rightHand.value.lookDefault");
    expect(line.to).toBe("#123456 · look.eyesNames.happy · look.accessories.crown");
  });
  test("an effort reads as its level; none as the model's own, auto as Automático", () => {
    expect(settingLineText(t, "pt-BR", { field: "effort", from: null, to: "xhigh" }, names)).toEqual({
      field: "rightHand.field.effort",
      from: "agentPage.work.brain.efforts.none",
      to: "agentPage.work.brain.efforts.xhigh",
    });
    expect(settingLineText(t, "pt-BR", { field: "effort", from: "auto", to: "low" }, names).from).toBe(
      "agentPage.work.brain.efforts.auto",
    );
  });
  test("Responde a reads the agents' names the server gave, or none", () => {
    expect(
      settingLineText(
        t,
        "pt-BR",
        { field: "reports_to", from: "a-nina", to: "a-bea", label: { from: "Nina", to: "Bea" } },
        names,
      ),
    ).toEqual({ field: "rightHand.field.reports_to", from: "Nina", to: "Bea" });
    expect(settingLineText(t, "pt-BR", { field: "reports_to", from: null, to: "a-bea" }, names)).toEqual({
      field: "rightHand.field.reports_to",
      from: "rightHand.value.none",
      to: "rightHand.value.anAgent",
    });
  });
  test("a department reads by its name, or none", () => {
    expect(settingLineText(t, "pt-BR", { field: "group", from: "Operações", to: "Vendas" }, names)).toEqual({
      field: "rightHand.field.group",
      from: "Operações",
      to: "Vendas",
    });
    expect(settingLineText(t, "pt-BR", { field: "group", from: "Vendas", to: null }, names)).toEqual({
      field: "rightHand.field.group",
      from: "Vendas",
      to: "rightHand.value.none",
    });
  });
});

describe("a skill line on a settings card", () => {
  const names = { model: (id: string) => id, person: () => undefined, channel: () => undefined, role: () => undefined };
  test("reads as the skill by its name, off to on", () => {
    expect(
      settingLineText(
        t,
        "pt-BR",
        { field: "skill", skillId: "s-excel", from: false, to: true, label: { to: "excel" } },
        names,
      ),
    ).toEqual({
      field: 'rightHand.field.skill {"name":"excel"}',
      from: "rightHand.value.skillOff",
      to: "rightHand.value.skillOn",
    });
  });
});

describe("a card of proposals", () => {
  test("its rows: every id, else the one an older server sent; its proposer, else the agent it changes", () => {
    expect(cardProposalIds({ proposalId: "a", proposalIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(cardProposalIds({ proposalId: "a" })).toEqual(["a"]);
    expect(cardProposalIds({ proposalIds: [] })).toEqual([]);
    expect(
      messageProposalCards({
        memoryUpdates: [
          { action: "remembered", itemId: "m", text: "x" },
          { action: "proposed", itemId: "a", text: "x", proposalId: "a", proposalIds: ["a", "b"] },
        ],
      }),
    ).toEqual([["a", "b"]]);
    expect(messageProposalCards({ proposalId: "old" })).toEqual([["old"]]);
    expect(messageProposalCards(null)).toEqual([]);
    expect(proposerOf(row("1"))).toBe("theo");
    expect(proposerOf(row("1", { proposedByAgentId: undefined }))).toBe("agent-1");
  });

  test("each change shows once: agents changed alike share it, roles and apps come after", () => {
    const swap = row("3", { before: "- Preços em $.", after: "- Preços em R$." });
    const sections = proposalSections([row("1"), access("4"), swap, role("5"), row("2")]);
    expect(sections.map((s) => [s.kind, s.rows.map((r) => r.id)])).toEqual([
      ["text", ["1", "2"]],
      ["text", ["3"]],
      ["role", ["5"]],
      ["access", ["4"]],
    ]);
    expect(changedLines(row("1"))).toEqual([
      { kind: "add", text: "## Learned" },
      { kind: "add", text: "- Responder em português." },
    ]);
    expect(changedLines(swap)).toEqual([
      { kind: "del", text: "- Preços em $." },
      { kind: "add", text: "- Preços em R$." },
    ]);
  });

  test("apps in the person's language: a built-in scope translated, a connection by its own name", () => {
    expect(appLabel(t, { id: "browser:use", label: "Use a browser", on: true })).toBe(
      "scopes.browser_use.label=Use a browser",
    );
    expect(appLabel(t, { id: "connector:c1", label: "Linear", on: true })).toBe("Linear");
  });

  test("the head: what one row changes, how many agents several change, or one agent's changes", () => {
    const name = (id: string) => (id === "agent-1" ? "Ada" : "Theo");
    expect(cardHead(t, [role("1")], "Theo", name, "Acme")).toEqual({
      key: "proposals.proposes",
      values: { agent: "Theo", target: expect.stringContaining("proposals.targetRole") },
    });
    expect(cardHead(t, [row("1"), row("2")], "Theo", name, "Acme")).toEqual({
      key: "proposals.proposesMany",
      values: { agent: "Theo", count: 2 },
    });
    expect(cardHead(t, [row("1"), role("2")], "Theo", name, "Acme").key).toBe("proposals.proposesManyChanges");
    const one = cardHead(t, [row("1"), role("1"), access("1")], "Theo", name, "Acme");
    expect(one.key).toBe("proposals.proposes");
    expect(String(one.values.target)).toContain('proposals.targetChanges {"name":"Ada"');
  });

  test("the context: the workspace's by its name, a personal workspace's as what its agents know (ADR 0159)", () => {
    const name = () => "Ada";
    const context = row("1", { target: { type: "org_context" }, title: "Update the context" });
    // By name only, as before; a team's workspace reads the same.
    expect(proposalTarget(t, context, name, "Acme")).toBe('proposals.targetContext {"org":"Acme"}');
    expect(proposalTarget(t, context, name, { name: "Acme", mode: "team" })).toBe(
      'proposals.targetContext {"org":"Acme"}',
    );
    expect(proposalTitle(t, context, "Acme", name)).toBe("proposals.titleContext=Update the context");
    // A personal workspace's never reads "Personal context".
    const personal = { name: "Personal", mode: "personal" as const };
    expect(proposalTarget(t, context, name, personal)).toBe('proposals.targetContextPersonal {"org":"Personal"}');
    expect(proposalTitle(t, context, personal, name)).toBe("proposals.titleContextPersonal=Update the context");
    expect(cardHead(t, [context], "Theo", name, personal).values.target).toBe(
      'proposals.targetContextPersonal {"org":"Personal"}',
    );
    // An agent's own changes read the same in either mode.
    expect(proposalTarget(t, role("1"), name, personal)).toContain("proposals.targetRole");
  });
});

describe("the server's reasons", () => {
  test("a code reads in the person's language, an agent's words as they are", () => {
    expect(proposalWhy(t, { why: "Fica mais claro.", whyCode: null })).toBe("Fica mais claro.");
    expect(proposalWhy(t, { why: "Fica mais claro." })).toBe("Fica mais claro.");
    expect(proposalWhy(t, { why: "Remover", whyCode: "refused" })).toBe('proposals.whyCode.refused {"text":"Remover"}');
    expect(proposalWhy(t, { why: "", whyCode: "seen" })).toBe("proposals.whyCode.seen");
    expect(proposalWhy(t, { why: "", whyCode: "no_channel" })).toBe("proposals.whyCode.noChannel");
  });
  test("a lesson from a refusal says so", () => {
    expect(memoryLine(t, { text: "Remover", how: "refused" })).toBe('memory.fromRefusal {"text":"Remover"}');
    expect(memoryLine(t, { text: "Prefere curto." })).toBe("Prefere curto.");
  });
});

describe("removalOf", () => {
  const line = (field: "archive" | "delete" | "model") => ({ settings: [{ field, from: false, to: true }] });
  test("a card whose every row archives (or deletes) one agent, else none", () => {
    expect(removalOf([line("archive"), line("archive")])).toBe("archive");
    expect(removalOf([line("delete")])).toBe("delete");
    expect(removalOf([line("archive"), line("delete")])).toBeNull();
    expect(removalOf([line("archive"), line("model")])).toBeNull();
    expect(removalOf([{ settings: [...line("archive").settings, ...line("model").settings] }])).toBeNull();
    expect(removalOf([])).toBeNull();
  });
});
