import { describe, expect, test } from "bun:test";
import type { OrgRole } from "../src/api/types";
import {
  addsAgentsTo,
  addsConnectors,
  editsMemory,
  leavesChannel,
  makesAgents,
  managesChannel,
  setsAutoReply,
} from "../src/lib/permissions";
import {
  areaRows,
  COMPUTER_KEYS,
  COMPUTERS_ROW,
  channelLeavers,
  grants,
  holdersAfter,
  levelOn,
  reachOf,
  rowState,
  withRow,
  withRowHolders,
} from "../src/lib/roles";

const member = { permissions: ["read", "post"] };
const manager = { permissions: ["read", "post", "manage_channels"] };
const room = { createdByUserId: "bia", isMember: true };

test("a channel is managed by its creator while in it, or who manages channels, no one else", () => {
  expect(managesChannel(room, "bia", member)).toBe(true);
  expect(managesChannel({ ...room, isMember: false }, "bia", member)).toBe(false);
  expect(managesChannel({ ...room, isMember: false }, "caio", manager)).toBe(true);
  expect(managesChannel(room, "caio", member)).toBe(false);
  expect(managesChannel(room, "caio", manager)).toBe(true);
  expect(managesChannel(undefined, "caio", manager)).toBe(true);
  expect(managesChannel({ createdByUserId: null }, null, member)).toBe(false);
});

test("an agent's reply mode in a channel: who manages the channel, or the agent's owner", () => {
  const bot = { ownerUserId: "caio" };
  expect(setsAutoReply(room, bot, "caio", member)).toBe(true);
  expect(setsAutoReply(room, bot, "bia", member)).toBe(true);
  expect(setsAutoReply(room, bot, "davi", manager)).toBe(true);
  expect(setsAutoReply(room, bot, "davi", member)).toBe(false);
  expect(setsAutoReply(room, { ownerUserId: null }, null, member)).toBe(false);
  expect(setsAutoReply(room, undefined, "caio", member)).toBe(false);
});

test("an agent goes in or out of a channel its person is in and may post in, or manages", () => {
  const joined = { ...room, isMember: true };
  const other = { ...room, isMember: false };
  expect(addsAgentsTo(joined, "caio", member)).toBe(true);
  expect(addsAgentsTo(joined, "caio", { permissions: ["read"] })).toBe(false);
  expect(addsAgentsTo(other, "caio", member)).toBe(false);
  expect(addsAgentsTo(other, "bia", member)).toBe(false);
  expect(addsAgentsTo(other, "caio", manager)).toBe(true);
  expect(addsAgentsTo(undefined, "caio", member)).toBe(false);
});

test("an agent's memory is edited by its owner or who reviews memory", () => {
  const bot = { ownerUserId: "caio" };
  const reviewer = { permissions: ["read", "review_memory"] };
  expect(editsMemory(bot, "caio", member)).toBe(true);
  expect(editsMemory(bot, "davi", reviewer)).toBe(true);
  expect(editsMemory(bot, "davi", member)).toBe(false);
});

test("a channel's exceptions (ADR 0134): the list's `can` decides managing when the server sends it", () => {
  const member = { permissions: ["read", "post"] };
  const admin = { permissions: ["read", "post", "manage_channels"] };
  expect(managesChannel({ isMember: true, can: { post: true, callAgents: true, manage: true } }, "u", member)).toBe(
    true,
  );
  expect(managesChannel({ isMember: true, can: { post: true, callAgents: true, manage: false } }, "u", admin)).toBe(
    false,
  );
  expect(managesChannel({ isMember: true }, "u", admin)).toBe(true);
});

test("anyone in a channel may leave it, except #general, where everyone stays", () => {
  expect(leavesChannel({ name: "eng", isMember: true })).toBe(true);
  expect(leavesChannel({ name: "eng", isMember: false })).toBe(false);
  expect(leavesChannel({ name: "general", isMember: true })).toBe(false);
});

test("a way into a new agent shows for who creates agents, never in a workspace being deleted", () => {
  const maker = { permissions: ["read", "create_agents"] };
  expect(makesAgents(maker)).toBe(true);
  expect(makesAgents(member)).toBe(false);
  expect(makesAgents({ ...maker, deletion: { dueAt: null, requestedAt: null, requestedBy: null } })).toBe(false);
  expect(makesAgents(null)).toBe(false);
});

test("a way into connecting a service shows for who manages connectors, never in a workspace being deleted", () => {
  const admin = { permissions: ["read", "manage_connectors"] };
  expect(addsConnectors(admin)).toBe(true);
  expect(addsConnectors(member)).toBe(false);
  expect(addsConnectors({ ...admin, deletion: { dueAt: null, requestedAt: null, requestedBy: null } })).toBe(false);
});

describe("cargos: rows, who holds them and what a cargo reaches (ADR 0085 addendum of 2026-11-13)", () => {
  const role = (over: Partial<OrgRole> & { id: string }): OrgRole => ({
    kind: "custom",
    name: over.id,
    icon: "shield",
    color: "teal",
    position: 1,
    permissions: [],
    mentionable: true,
    hoist: false,
    people: 0,
    editable: true,
    givable: true,
    ...over,
  });
  const everyone = role({
    id: "all",
    kind: "everyone",
    position: 99,
    permissions: ["post", "create_channels", "own_computers"],
  });
  const admin = role({ id: "admin", position: 0, permissions: ["administrator"], editable: false });
  const lead = role({ id: "lead", position: 1, permissions: ["create_channels"], editable: false });
  const finance = role({ id: "finance", position: 2 });
  const support = role({ id: "support", position: 3, permissions: ["create_channels", "view_usage"] });
  const roles = [admin, lead, finance, support, everyone];
  const person = (userId: string, roleIds: string[] = [], owner = false) => ({
    userId,
    role: owner ? ("owner" as const) : ("member" as const),
    roleIds,
  });
  const tools = { keys: ["pair_computers", ...COMPUTER_KEYS, "manage_connectors", "manage_credentials"] };

  test("the computers are one row of five steps, and every agent's browser gives their own agents' whole computer", () => {
    expect(areaRows(tools)).toEqual(["pair_computers", COMPUTERS_ROW, "manage_connectors", "manage_credentials"]);
    expect([...grants(["control_browsers"])].sort()).toEqual(["control_browsers", "own_browsers", "own_computers"]);
    expect([0, 1, 2, 3, 4].map((n) => levelOn(withRow(["post"], COMPUTERS_ROW, n), COMPUTERS_ROW))).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(withRow(["post", "own_computers", "control_browsers"], COMPUTERS_ROW, 1)).toEqual(["post", "own_browsers"]);
    expect(withRow(["post"], "create_channels", 1)).toEqual(["post", "create_channels"]);
    expect(withRow(["post", "create_channels"], "create_channels", 0)).toEqual(["post"]);
    // Administrador's reach isn't the role's own: what comes back when it goes off.
    expect(levelOn(["administrator"], "post")).toBe(0);
  });

  test("a row says what the role holds and what Todos gives: the chip shows when everyone has it", () => {
    expect(rowState(finance, everyone, "create_channels")).toEqual({
      own: 0,
      everyone: 1,
      level: 1,
      fromEveryone: true,
    });
    expect(rowState(support, everyone, "view_usage")).toMatchObject({ own: 1, everyone: 0, fromEveryone: false });
    expect(rowState(everyone, everyone, "post")).toMatchObject({ own: 1, everyone: 1, fromEveryone: true });
    expect(rowState(everyone, everyone, "view_usage")).toMatchObject({ level: 0, fromEveryone: false });
    // On the ladder, a role above Todos' step is its own.
    const ops = role({ id: "ops", permissions: ["control_computers"] });
    expect(rowState(ops, everyone, COMPUTERS_ROW)).toMatchObject({ own: 4, everyone: 2, fromEveryone: false });
  });

  test("a Quem pode change as the server applies it, and who loses or gets it; owners always can", () => {
    const holders = { everyone: 0, roles: [{ id: "finance", level: 1 }] };
    const next = withRowHolders(roles, "create_channels", holders);
    const keysOf = (id: string) => next.find((r) => r.id === id)?.permissions;
    expect(keysOf("all")).toEqual(["post", "own_computers"]);
    expect(keysOf("finance")).toEqual(["create_channels"]);
    expect(keysOf("support")).toEqual(["view_usage"]);
    // Above the viewer, and Administrador: as they were.
    expect(keysOf("lead")).toEqual(["create_channels"]);
    expect(keysOf("admin")).toEqual(["administrator"]);
    const people = [
      person("owner", [], true),
      person("carla"),
      person("diego", ["support"]),
      person("fabi", ["finance"]),
      person("leo", ["lead"]),
      person("ada", ["admin"]),
    ];
    const { losing, gaining } = holdersAfter(people, roles, "create_channels", holders);
    expect(losing.map((p) => p.userId)).toEqual(["carla", "diego"]);
    expect(gaining).toEqual([]);
    // Back to everyone: whoever didn't have it gets it.
    const back = holdersAfter(people, next, "create_channels", { everyone: 1, roles: [] });
    expect(back.gaining.map((p) => p.userId)).toEqual(["carla", "diego"]);
    // Finance's own key goes with it, and Fabi keeps it through everyone.
    expect(back.losing).toEqual([]);
    // The ladder: Todos lowered to their agents' browser, Finance raised to the step it had. Leo's role is above
    // the viewer and holds no step of its own, so he loses it too.
    const lowered = holdersAfter(people, roles, COMPUTERS_ROW, { everyone: 1, roles: [{ id: "finance", level: 2 }] });
    expect(lowered.losing.map((p) => p.userId)).toEqual(["carla", "diego", "leo"]);
  });

  test("what a cargo adds past Todos, its channels (the unseen ones counted) and its agents", () => {
    const areas = [{ keys: ["post", "create_channels", "view_usage"] }, tools];
    expect(reachOf({ ...support, channelIds: ["c1"], hiddenChannels: 2, agentIds: ["a1"] }, everyone, areas)).toEqual({
      all: false,
      permissions: 1,
      channels: 3,
      agents: 1,
    });
    expect(reachOf({ ...everyone, channelIds: ["g", "h"], agentIds: [] }, everyone, areas)).toEqual({
      all: false,
      permissions: 3,
      channels: 2,
      agents: 0,
    });
    expect(reachOf(admin, everyone, areas)).toMatchObject({ all: true, channels: 0, agents: 0 });
    // An older server sends no reach: none.
    expect(reachOf(finance, everyone, areas)).toEqual({ all: false, permissions: 0, channels: 0, agents: 0 });
  });

  test("who leaves a channel, or stops seeing it, when its cargos change (ADR 0125's rule)", () => {
    const people = [
      person("owner", [], true),
      person("carla", ["support"]),
      person("diego", ["support", "finance"]),
      person("eva"),
      person("fabi", ["finance"]),
      person("gil", ["support"]),
      person("ada", ["admin"]),
    ];
    const room = { visibility: "private", audienceRoleIds: ["support", "finance"], createdByUserId: "gil" };
    const members = ["carla", "diego", "eva", "gil"];
    // Support goes: Carla leaves; Diego keeps Finance; Eva was added by name; Gil made it.
    const dropped = channelLeavers(
      room,
      { visibility: "private", audienceRoleIds: ["finance"] },
      members,
      people,
      roles,
    );
    expect(dropped.leave.map((p) => p.userId)).toEqual(["carla"]);
    expect(dropped.unsee.map((p) => p.userId)).toEqual([]);
    // Invite only, or public: nobody leaves; invite only hides it from Fabi, who wasn't in.
    const closed = channelLeavers(room, { visibility: "private", audienceRoleIds: [] }, members, people, roles);
    expect(closed.leave).toEqual([]);
    expect(closed.unsee.map((p) => p.userId)).toEqual(["fabi"]);
    expect(channelLeavers(room, { visibility: "public", audienceRoleIds: [] }, members, people, roles)).toEqual({
      leave: [],
      unsee: [],
    });
    // Public to Finance only: who's in stays, and those out of it stop seeing it (admins and owners never do).
    const open = { visibility: "public", createdByUserId: "eva" };
    const limited = channelLeavers(
      open,
      { visibility: "private", audienceRoleIds: ["finance"] },
      ["eva"],
      people,
      roles,
    );
    expect(limited.leave).toEqual([]);
    expect(limited.unsee.map((p) => p.userId)).toEqual(["carla", "gil"]);
  });
});
