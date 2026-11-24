import { describe, expect, test } from "bun:test";
import type { AgentGroup, Machine, Member, Message, OrgRole, TeamAgent } from "@agenteschat/client";
import type { TFunction } from "i18next";
import { canEditMemories } from "../../src/features/agents/logic";
import { mayStopRun } from "../../src/features/chat/logic";
import { agentAudienceLine, agentIntent, audienceValid } from "../../src/features/roles/logic";
import { agentComputerPick } from "../../src/features/settings/logic";
import { approvalOwnerOf, ownerNameIn, ownerRoleOf, ownsIn, roleIdsOf } from "../../src/features/shared/owner";
import { rolesFirst, teamSections } from "../../src/features/team/logic";
import { agent } from "./fixtures";

// An agent's owner is a person or a role, never both (ADR 0085, addendum of 2026-11-21): whoever holds the role answers
// for it, and the phone names the role wherever it names the owner.

const role = (over: Partial<OrgRole> & { id: string; name: string }): OrgRole => ({
  kind: "custom",
  icon: "shield",
  color: "teal",
  position: 1,
  permissions: [],
  mentionable: false,
  hoist: false,
  people: 2,
  editable: true,
  givable: true,
  ...over,
});
const tech = role({ id: "r-tech", name: "Tecnologia", people: 3 });
const support = role({ id: "r-support", name: "Suporte" });
const roles = [tech, support];
const member = (userId: string, name: string, roleIds: string[] = []) => ({ userId, name, roleIds }) as Member;
const memberById = new Map([
  ["u-ana", member("u-ana", "Ana", ["r-tech"])],
  ["u-bruno", member("u-bruno", "Bruno")],
]);
// The keys and their values, to read which words a line picked without the language files.
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction;

const byRole = agent({ id: "a-iris", name: "Iris", ownerUserId: null, ownerRoleId: "r-tech" });
const byPerson = agent({ id: "a-max", name: "Max", ownerUserId: "u-bruno" });
const nobody = agent({ id: "a-noa", name: "Noa", ownerUserId: null });

describe("who answers for an agent on the phone", () => {
  test("holding its role is answering for it; a person's own agent stays theirs alone", () => {
    expect(roleIdsOf(memberById, "u-ana")).toEqual(["r-tech"]);
    expect(roleIdsOf(memberById, "u-gone")).toEqual([]);
    expect(roleIdsOf(memberById, null)).toEqual([]);
    expect(ownsIn(memberById, "u-ana", byRole)).toBe(true);
    expect(ownsIn(memberById, "u-bruno", byRole)).toBe(false);
    expect(ownsIn(memberById, "u-bruno", byPerson)).toBe(true);
    expect(ownsIn(memberById, "u-ana", byPerson)).toBe(false);
    expect(ownsIn(memberById, null, byRole)).toBe(false);
    expect(ownsIn(memberById, "u-ana", undefined)).toBe(false);
  });

  test("its owner by name: the role's where a role answers for it, nobody's for none", () => {
    expect(ownerNameIn(byRole, memberById, roles)).toBe("Tecnologia");
    expect(ownerNameIn(byPerson, memberById, roles)).toBe("Bruno");
    expect(ownerNameIn(nobody, memberById, roles)).toBeUndefined();
    // Roles not loaded yet: no name, never a person's.
    expect(ownerNameIn(byRole, memberById, undefined)).toBeUndefined();
    expect(ownerRoleOf(byRole, roles)).toBe(tech);
    expect(ownerRoleOf(byPerson, roles)).toBeUndefined();
  });

  test("an approval waits on the owner it was asked under, else on its agent's", () => {
    expect(approvalOwnerOf({ ownerUserId: null, ownerRoleId: "r-support" }, byRole)).toEqual({
      ownerUserId: null,
      ownerRoleId: "r-support",
    });
    expect(approvalOwnerOf({ ownerUserId: null }, byRole)).toBe(byRole);
    expect(approvalOwnerOf({}, undefined)).toEqual({});
  });

  test("who holds the role corrects its memories and stops its work, as its owner", () => {
    const org = { permissions: [] };
    expect(canEditMemories(byRole, { id: "u-ana", org, roleIds: ["r-tech"] })).toBe(true);
    expect(canEditMemories(byRole, { id: "u-bruno", org, roleIds: [] })).toBe(false);
    expect(canEditMemories(byRole, { id: "u-ana", org })).toBe(false);
    const run = { agentId: "a-iris", threadId: "t1", triggerMessageId: null };
    const who = { meId: "u-ana", manageAgents: false, agentOwnerId: null, messages: [] as Message[] };
    expect(mayStopRun(run, who)).toBe(false);
    expect(mayStopRun(run, { ...who, owns: ownsIn(memberById, "u-ana", byRole) })).toBe(true);
  });

  test("who holds the role moves it to another computer, as its owner", () => {
    const mini = { id: "mini", kind: "connected", agents: [{ id: "a-iris" }], pairedBy: null } as unknown as Machine;
    const pick = (meId: string, myRoleIds: string[]) =>
      agentComputerPick({ agent: byRole, meId, myRoleIds, admin: false, machines: [mini], setup: null }).canPick;
    expect(pick("u-ana", ["r-tech"])).toBe(true);
    expect(pick("u-bruno", [])).toBe(false);
  });
});

describe("only its owner, a role", () => {
  const ownerOnly = { ...byRole, audience: { mode: "owner" as const, userIds: [], roleIds: [] } };

  test("says whoever holds the role, never 'only the owner'", () => {
    expect(agentAudienceLine(t, ownerOnly, roles, (id) => memberById.get(id)?.name)).toBe(
      'audience.mode.ownerRole {"role":"Tecnologia"}',
    );
    const personOnly = { ...byPerson, audience: { mode: "owner" as const, userIds: [], roleIds: [] } };
    expect(agentAudienceLine(t, personOnly, roles, (id) => memberById.get(id)?.name)).toBe(
      'mobile.roles.only {"names":"Bruno"}',
    );
  });

  test("is a choice with a role that answers for it, and dropping the last cargo falls back to it", () => {
    expect(audienceValid({ mode: "owner", userIds: [], roleIds: [] }, byRole)).toBe(true);
    expect(audienceValid({ mode: "owner", userIds: [], roleIds: [] }, nobody)).toBe(false);
    const onlySupport = { ...byRole, audience: { mode: "people" as const, userIds: [], roleIds: ["r-support"] } };
    expect(agentIntent(support, onlySupport, roles)).toEqual({
      kind: "save",
      audience: { mode: "owner", userIds: [], roleIds: [], consultable: true },
    });
  });
});

describe("the org chart by person, with roles", () => {
  const teamAgent = (id: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
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
  const input = {
    agents: [
      teamAgent("Ada", { ownerUserId: "u-bruno" }),
      teamAgent("Iris", { ownerRoleId: "r-tech" }),
      teamAgent("Noa"),
      teamAgent("Ivo", { ownerRoleId: "r-tech" }),
    ],
    groups: [] as AgentGroup[],
    members: [...memberById.values()],
    channels: [],
    rightHandId: null,
    roles,
  };

  test("a role's column comes before the people's, its agents in it; nobody's stays last", () => {
    expect(teamSections("chart", input).map((s) => [s.key, s.title, s.agents.map((a) => a.name)])).toEqual([
      ["role:r-tech", "Tecnologia", ["Iris", "Ivo"]],
      ["u-bruno", "Bruno", ["Ada"]],
      ["none", null, ["Noa"]],
    ]);
    expect(rolesFirst([{ roleId: null }, { roleId: "r" }, { roleId: null }])).toEqual([
      { roleId: "r" },
      { roleId: null },
      { roleId: null },
    ]);
  });
});
