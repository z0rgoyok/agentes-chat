import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentUsageFacts,
  createdText,
  hidesAgentPage,
  lockedText,
  seesFactsOnly,
} from "@agenteschat/client/lib/agent-facts";
import { agent, translator } from "./fixtures";

const AGENTS = join(import.meta.dir, "../../src/features/agents");
const source = (file: string) => readFileSync(join(AGENTS, file), "utf8");

/** João's Atlas, answering only him. */
const atlas = (over: Parameters<typeof agent>[0] | object = {}) =>
  agent({
    id: "a-atlas",
    name: "Atlas",
    ownerUserId: "u-joao",
    audience: { mode: "owner", userIds: [] },
    seesDetails: false,
    ...over,
  });

describe("a teammate's private agent, by its facts alone", () => {
  test("Editar agentes sees its facts; a plain member's link finds nothing; a public card stays open", () => {
    expect(seesFactsOnly(atlas({ factsOnly: true }))).toBe(true);
    expect(hidesAgentPage(atlas({ factsOnly: true }))).toBe(false);
    expect(hidesAgentPage(atlas())).toBe(true);
    // It answers someone besides João: not private, its public card opens.
    expect(hidesAgentPage(atlas({ audience: { mode: "people", userIds: ["u-ana"] } }))).toBe(false);
    // Its owner and who it answers see how it works.
    expect(hidesAgentPage(atlas({ seesDetails: true }))).toBe(false);
  });

  test("this month's usage: what thinks for it, runs, tokens, the budget as a share, never money, last activity", async () => {
    const t = await translator("pt-BR");
    const now = new Date("2026-11-24T12:00:00Z");
    const rows = agentUsageFacts(
      t,
      "pt-BR",
      {
        runsThisMonth: 34,
        tokensThisMonth: 1_200_000,
        budgetUsedPercent: 11,
        lastActivityAt: "2026-11-24T10:00:00Z",
      },
      "Claude Sonnet 5.5",
      now,
    );
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["Pensa com", "Claude Sonnet 5.5"],
      ["Execuções", "34"],
      ["Tokens", "1,2 mi"],
      ["Orçamento", "11% usado"],
      ["Última atividade", "há 2 h"],
    ]);
    const never = agentUsageFacts(
      t,
      "pt-BR",
      { runsThisMonth: 0, tokensThisMonth: 0, budgetUsedPercent: 0, lastActivityAt: null },
      null,
      now,
    );
    expect(never.map((r) => r.value)).toEqual(["0", "0", "0% usado", "Nenhuma ainda"]);
  });

  test("who made it, and with whom its workings stay", async () => {
    const t = await translator("pt-BR");
    const names = (id: string) => (id === "u-joao" ? "João" : undefined);
    expect(createdText(t, "pt-BR", { createdAt: "2026-11-13T12:00:00Z", createdByUserId: "u-joao" }, names)).toBe(
      "João, 13 nov",
    );
    expect(createdText(t, "pt-BR", { createdAt: "2026-11-13T12:00:00Z", createdByUserId: null }, names)).toBe("13 nov");
    expect(lockedText(t, atlas(), "João")).toBe(
      "Instruções, memória, ferramentas, conversas, rotinas e arquivos do Atlas ficam com João, quem essa pessoa chamar para editar e os admins.",
    );
    expect(t("agentPage.facts.ask", { owner: "João" })).toBe("Pedir a João");
  });

  test("the phone's Agentes lists it locked, and its profile shows its facts, not how it works", () => {
    const list = source("AgentsScreen.tsx");
    expect(list).toContain("listsAgent(org, a) || seesFactsOnly(a)");
    expect(list).toContain('t("agentPage.facts.private")');
    const profile = source("AgentProfileScreen.tsx");
    expect(profile).toContain("const facts = seesFactsOnly(agent);");
    expect(profile).toMatch(/facts && agent \? \(\s*<View style=\{\[styles\.page, sides\]\}>\s*<AgentFacts/);
    // A plain member reaching its link (a pushed /agent/<id>) finds nothing, as on the web: no public card.
    expect(profile).toMatch(/if \(hidesAgentPage\(agent\)\) \{[\s\S]{0,240}t\("agent\.notFound"\)/);
  });
});
