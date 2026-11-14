import { describe, expect, test } from "bun:test";
import type { Agent, OrgRole } from "../src/api/types";
import { audienceWithRole, roleTalksTo } from "../src/lib/audience";
import {
  channelReach,
  deleteLeavers,
  keepsFixedOnTop,
  levelOn,
  movedOrder,
  reachRows,
  roleSees,
  rowChanges,
  rowHolders,
  whoStart,
  withRowHolders,
  writableRoles,
} from "../src/lib/roles";

/* The cargo page's pure parts (plan §1.2–1.3): "Quem pode" as one call, what a cargo reaches, who leaves a channel. */

const base = { mentionable: false, hoist: false, people: 0, editable: true, givable: true };
const role = (id: string, permissions: string[], more: Partial<OrgRole> = {}): OrgRole => ({
  ...base,
  id,
  kind: "custom",
  name: id,
  icon: "shield",
  color: "teal",
  position: 0,
  permissions,
  ...more,
});
const everyone = role("everyone", ["post", "create_channels", "own_computers"], { kind: "everyone", position: 9 });
const admin = role("admin", ["administrator"], { position: 0 });
const suporte = role("suporte", ["approve_actions"], { position: 1 });
const fin = role("fin", ["view_usage"], { position: 2 });
const above = role("diretoria", ["create_channels"], { position: 0, editable: false });
const roles = [admin, above, suporte, fin, everyone];

describe("Quem pode: Todos and the cargos in one call", () => {
  test("only the cargos the viewer may change are written, Administrador and the ones above aside", () => {
    expect(writableRoles(roles).map((r) => r.id)).toEqual(["suporte", "fin"]);
  });

  test("turning off on Suporte what everyone has: everyone off, every other writable cargo keeps it, Suporte doesn't", () => {
    const ticked = whoStart(roles, "create_channels", 1, { but: "suporte" });
    expect([...ticked]).toEqual(["fin"]);
    const holders = rowHolders(
      roles,
      "create_channels",
      { everyone: false, ticked },
      { keep: 1, low: 0, from: { id: "suporte", level: 0 } },
    );
    expect(holders).toEqual({
      everyone: 0,
      roles: [
        { id: "suporte", level: 0 },
        { id: "fin", level: 1 },
      ],
    });
    const after = withRowHolders(roles, "create_channels", holders);
    expect(after.map((r) => [r.id, levelOn(r.permissions, "create_channels")])).toEqual([
      ["admin", 0],
      ["diretoria", 1],
      ["suporte", 0],
      ["fin", 1],
      ["everyone", 0],
    ]);
    expect(rowChanges(roles, "create_channels", holders)).toBe(true);
  });

  test("Todos kept: nothing changes, so there's nothing to save, and no cargo is zeroed by being left out", () => {
    const holders = rowHolders(roles, "create_channels", { everyone: true, ticked: new Set() }, { keep: 1, low: 0 });
    expect(holders).toEqual({
      everyone: 1,
      roles: [
        { id: "suporte", level: 0 },
        { id: "fin", level: 0 },
      ],
    });
    expect(rowChanges(roles, "create_channels", holders)).toBe(false);
  });

  test("on the computers, a cargo ticked keeps Todos' old step, one above it its own, an unticked one drops under it", () => {
    const withSteps = [
      { ...suporte, permissions: ["control_computers"] },
      { ...fin, permissions: [] },
      everyone,
    ] as OrgRole[];
    const ticked = whoStart(withSteps, "computers", 2, "holders");
    expect([...ticked]).toEqual(["suporte"]);
    const holders = rowHolders(
      withSteps,
      "computers",
      { everyone: false, ticked: new Set(["suporte", "fin"]) },
      { keep: 2, low: 1 },
    );
    expect(holders).toEqual({
      everyone: 1,
      roles: [
        { id: "suporte", level: 4 },
        { id: "fin", level: 2 },
      ],
    });
    const untick = rowHolders(withSteps, "computers", { everyone: false, ticked: new Set() }, { keep: 2, low: 1 });
    expect(untick.roles).toEqual([
      { id: "suporte", level: 1 },
      { id: "fin", level: 0 },
    ]);
  });

  test("no level goes under none, whatever step the dialog keeps (the server refuses one)", () => {
    const holders = rowHolders(roles, "approve_actions", { everyone: false, ticked: new Set() }, { keep: 0, low: 0 });
    expect(holders.roles.map((r) => r.level)).toEqual([0, 0]);
  });
});

describe("what a cargo reaches", () => {
  const areas = [{ keys: ["post", "create_channels", "approve_actions", "view_usage"] }];
  test("its rows past Todos', Todos' every row it holds", () => {
    expect(reachRows(suporte, everyone, areas)).toEqual(["approve_actions"]);
    expect(reachRows({ ...suporte, permissions: ["post"] }, everyone, areas)).toEqual([]);
    expect(reachRows(everyone, everyone, areas)).toEqual(["post", "create_channels"]);
  });

  test("who sees a channel, and whether a cargo's people see it through it", () => {
    const pub = { visibility: "public" };
    const limited = { visibility: "private", audienceRoleIds: ["suporte"] };
    const closed = { visibility: "private", audienceRoleIds: [] };
    expect([channelReach(pub), channelReach(limited), channelReach(closed)]).toEqual([
      { kind: "everyone" },
      { kind: "roles", roleIds: ["suporte"] },
      { kind: "private" },
    ]);
    expect([
      roleSees(suporte, pub),
      roleSees(suporte, limited),
      roleSees(fin, limited),
      roleSees(everyone, limited),
    ]).toEqual([true, true, false, false]);
  });

  test("whom an agent answers through a cargo, and its audience with the cargo in or out", () => {
    const agent = (audience: Agent["audience"]) => ({ id: "a", name: "Max", ownerUserId: "ana", audience }) as Agent;
    const all = agent({ mode: "everyone", userIds: [], roleIds: [] });
    const some = agent({ mode: "people", userIds: ["bia"], roleIds: ["suporte"] });
    const own = agent({ mode: "owner", userIds: [], roleIds: [] });
    expect([
      roleTalksTo(suporte, all),
      roleTalksTo(suporte, some),
      roleTalksTo(fin, some),
      roleTalksTo(everyone, some),
    ]).toEqual([true, true, false, false]);
    expect(audienceWithRole(some, "suporte", false)).toEqual({
      mode: "people",
      userIds: ["bia"],
      roleIds: [],
      consultable: true,
    });
    expect(audienceWithRole(own, "fin", true)).toEqual({
      mode: "people",
      userIds: [],
      roleIds: ["fin"],
      consultable: true,
    });
  });
});

test("deleting a cargo takes out of a channel limited to it whoever holds none of its other cargos, its creator aside", () => {
  const channels = [
    { id: "c1", visibility: "private", audienceRoleIds: ["suporte"], createdByUserId: "ana" },
    { id: "c2", visibility: "private", audienceRoleIds: ["suporte", "fin"] },
    { id: "c3", visibility: "public" },
  ];
  const people = [
    { userId: "ana", roleIds: ["suporte"] },
    { userId: "bia", roleIds: ["suporte"] },
    { userId: "caio", roleIds: ["suporte", "fin"] },
    { userId: "davi", roleIds: [] },
  ];
  const members: Record<string, string[]> = { c1: ["ana", "bia", "caio"], c2: ["bia", "caio"], c3: ["davi"] };
  const leaving = deleteLeavers({ id: "suporte" }, channels, (id) => members[id] ?? [], people);
  expect(leaving.map((p) => p.userId)).toEqual(["bia", "caio"]);
});

test("moving a cargo one place, never above one the viewer can't change", () => {
  const editable = (id: string) => id !== "diretoria";
  const order = ["diretoria", "suporte", "fin"];
  expect(movedOrder(order, editable, "fin", -1)).toEqual(["diretoria", "fin", "suporte"]);
  expect(movedOrder(order, editable, "suporte", -1)).toBeNull();
  expect(movedOrder(order, editable, "fin", 1)).toBeNull();
  expect(keepsFixedOnTop(["suporte", "diretoria", "fin"], editable)).toBe(false);
});

describe("REVIEW P1", () => {
  test("the cargo the change started on, ticked again, keeps the row", () => {
    const holders = rowHolders(
      roles,
      "create_channels",
      { everyone: false, ticked: new Set(["suporte", "fin"]) },
      { keep: 1, low: 0, from: { id: "suporte", level: 0 } },
    );
    expect(holders.roles).toEqual([
      { id: "suporte", level: 1 },
      { id: "fin", level: 1 },
    ]);
  });
  test("computers: the cargo it started on, ticked again, keeps Todos' old step", () => {
    const holders = rowHolders(
      roles,
      "computers",
      { everyone: false, ticked: new Set(["suporte"]) },
      { keep: 2, low: 0, from: { id: "suporte", level: 0 } },
    );
    expect(holders.roles.find((r) => r.id === "suporte")?.level).toBe(2);
  });
});
