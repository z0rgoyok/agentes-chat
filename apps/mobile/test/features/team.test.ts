import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentGroup, Channel, Member, TeamAgent } from "@agenteschat/client";
import { chartByPerson, mayUndoLines } from "@agenteschat/client/lib/team-views";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import { chartRows, lineContinues, teamSections } from "../../src/features/team/logic";

const agent = (id: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
  id,
  name: id,
  handle: id.toLowerCase(),
  role: "",
  appearance: null,
  ownerUserId: null,
  capabilities: [],
  busy: false,
  canTalk: true,
  channelIds: [],
  ...over,
});
const member = (userId: string, name: string) => ({ userId, name }) as Member;
const channel = (id: string, name: string) => ({ id, name }) as Channel;
const input = {
  agents: [
    agent("Ada", { ownerUserId: "u-lukas", channelIds: ["c-eng"] }),
    agent("Milo", { channelIds: ["c-fin"] }),
    agent("Lodi"),
  ],
  groups: [
    { id: "g-eng", name: "Engenharia", agentIds: ["Ada"], leadUserId: "u-lukas", backupUserId: "u-gone" },
  ] as AgentGroup[],
  members: [member("u-lukas", "Lukas")],
  channels: [channel("c-fin", "financeiro"), channel("c-eng", "engenharia")],
  rightHandId: "Lodi",
};
const shape = (view: "list" | "chart" | "map") =>
  teamSections(view, input).map((s) => [s.title, s.agents.map((a) => a.name)]);

describe("Equipe on the phone (ADR 0148)", () => {
  test("Lista by setor, Organograma by person, Mapa by channel: the web's views, the right hand left out", () => {
    expect(shape("list")).toEqual([
      ["Engenharia", ["Ada"]],
      [null, ["Milo"]],
    ]);
    // Each setor says who leads it and who covers, as the web's card (someone who left reads as nobody).
    expect(teamSections("list", input)[0]).toMatchObject({ lead: "Lukas", backup: null });
    expect(shape("chart")).toEqual([
      ["Lukas", ["Ada"]],
      [null, ["Milo"]],
    ]);
    expect(shape("map")).toEqual([
      ["#financeiro", ["Milo"]],
      ["#engenharia", ["Ada"]],
    ]);
  });

  test("its words exist in English and Portuguese", () => {
    expect(featureKeysEn.team.mapHint).toContain("{{name}}");
    expect(featureKeysPtBR.team.mapHint).toContain("{{name}}");
    expect(featureKeysPtBR.agents.noGroupSection).toBe("Sem setor");
  });
});

describe("Responde a on the phone (ADR 0148 addendum)", () => {
  test("a supervisor's reports are indented rows under it, and each level's line runs while its rows go on", () => {
    const nina = agent("Nina", { ownerUserId: "u-lukas" });
    const team = [
      nina,
      agent("Bea", { reportsToAgentId: "Nina" }),
      agent("Cid", { reportsToAgentId: "Bea" }),
      agent("Dan", { reportsToAgentId: "Nina" }),
      agent("Eva", { ownerUserId: "u-lukas" }),
    ];
    const [col] = chartByPerson(team, [], new Set(["u-lukas"]));
    const rows = chartRows(col?.nodes ?? []);
    expect(rows.map((r) => [r.agent.id, r.depth])).toEqual([
      ["Nina", 0],
      ["Bea", 1],
      ["Cid", 2],
      ["Dan", 1],
      ["Eva", 0],
    ]);
    // Nina's line (level 0) runs on to Eva; Bea's level-1 line runs on to Dan; Cid ends its own.
    expect(lineContinues(rows, 0, 0)).toBe(true);
    expect(lineContinues(rows, 1, 1)).toBe(true);
    expect(lineContinues(rows, 2, 2)).toBe(false);
    expect(lineContinues(rows, 3, 1)).toBe(false);
    expect(lineContinues(rows, 4, 0)).toBe(false);
  });

  test("Undo only when the server takes it back: each former supervisor nobody or one the person manages", () => {
    // The server puts an agent only under one its person manages (ADR 0085 addendum of 2026-11-17): someone's private
    // agent, which "Edit agents" alone doesn't reach, can't take it back.
    const team = [agent("Nina", { canManage: true }), agent("Theo", { canManage: false }), agent("Ivo")];
    expect(mayUndoLines([{ agentId: "Bea", reportsToAgentId: null }], team)).toBe(true);
    expect(mayUndoLines([{ agentId: "Bea", reportsToAgentId: "Nina" }], team)).toBe(true);
    expect(mayUndoLines([{ agentId: "Bea", reportsToAgentId: "Theo" }], team)).toBe(false);
    // An older server says nothing (no), and one no longer in the team can't be checked.
    expect(mayUndoLines([{ agentId: "Bea", reportsToAgentId: "Ivo" }], team)).toBe(false);
    expect(mayUndoLines([{ agentId: "Bea", reportsToAgentId: "Gone" }], team)).toBe(false);
    // Every one of them.
    const both = [
      { agentId: "Bea", reportsToAgentId: "Nina" },
      { agentId: "Cid", reportsToAgentId: "Theo" },
    ];
    expect(mayUndoLines(both, team)).toBe(false);
    // The toast offers it only then, never for an undo itself nor when nothing changed.
    const section = readFileSync(join(import.meta.dir, "../../src/features/agents/ReportsToSection.tsx"), "utf8");
    expect(section).toContain("...(undoing || previous.length === 0 || !mayUndoLines(previous, team)");
  });
});
