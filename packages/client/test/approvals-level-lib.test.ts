import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import {
  APPROVALS_LEVELS,
  approvalsLevelLine,
  approvalsLevelOf,
  auditUnasked,
  changesWhenAsks,
  followsWorkspace,
  levelsBefore,
  ownApprovalsCount,
  shownApprovalsLevel,
} from "../src/lib/approvals-level";
import { workspaceBudgetText } from "../src/lib/new-agent";

const i18n = i18next.createInstance();
void i18n.init({ lng: "pt-BR", resources, initAsync: false, interpolation: { escapeValue: false } });

test("an agent that follows the workspace says which level holds; the workspace's budget says how much", () => {
  const idle = { isPending: false };
  expect(approvalsLevelLine(i18n.t, { approvalsLevel: "risky", approvalsLevelOwn: false }, idle)).toBe(
    "Só o arriscado · do workspace",
  );
  expect(approvalsLevelLine(i18n.t, { approvalsLevel: "never", approvalsLevelOwn: true }, idle)).toBe(
    "Nunca perguntar",
  );
  // A change on its way shows the level asked for, its own.
  const saving = { isPending: true, variables: { approvalsLevel: "always" as const } };
  expect(approvalsLevelLine(i18n.t, { approvalsLevel: "risky", approvalsLevelOwn: false }, saving)).toBe(
    "Sempre perguntar",
  );
  expect(workspaceBudgetText(i18n.t, "pt-BR", 20)).toMatch(/^Padrão \(US\$\s20\)$/);
  expect(workspaceBudgetText(i18n.t, "pt-BR", undefined)).toBe("Padrão do workspace");
});

test("an agent's level: its own, and risky from a server that doesn't say", () => {
  expect(APPROVALS_LEVELS).toEqual(["always", "risky", "never"]);
  expect(approvalsLevelOf({ approvalsLevel: "never" })).toBe("never");
  expect(approvalsLevelOf({})).toBe("risky");
  expect(approvalsLevelOf(undefined)).toBe("risky");
});

test("while a change is on its way the row shows what was asked for", () => {
  const agent = { approvalsLevel: "risky" as const };
  expect(shownApprovalsLevel(agent, { isPending: false, variables: { approvalsLevel: "never" } })).toBe("risky");
  expect(shownApprovalsLevel(agent, { isPending: true, variables: { approvalsLevel: "never" } })).toBe("never");
  // Another field of the agent is being saved: the level stays as saved.
  expect(shownApprovalsLevel(agent, { isPending: true, variables: {} })).toBe("risky");
});

test("the audit marks a call that ran without its card because the agent never asks", () => {
  expect(auditUnasked({ details: { approvalsLevel: "never" } })).toBe(true);
  expect(auditUnasked({ details: { approvalRules: ["r1"] } })).toBe(false);
});

test("an agent follows the workspace only when the server says so, and the own ones are counted", () => {
  expect(followsWorkspace({ approvalsLevelOwn: false })).toBe(true);
  expect(followsWorkspace({ approvalsLevelOwn: true })).toBe(false);
  expect(followsWorkspace({})).toBe(false);
  expect(ownApprovalsCount([{ approvalsLevelOwn: true }, { approvalsLevelOwn: false }, {}])).toBe(1);
});

test("Change when it asks: a waiting request, for who decides it and manages its agent", () => {
  // The agent as the server sends it to me: `canManage` ("Edit agents" where it reaches, ADR 0085 addendum).
  const managed = { canManage: true };
  expect(changesWhenAsks(managed, { status: "pending", canDecide: true })).toBe(true);
  expect(changesWhenAsks(managed, { status: "pending", canDecide: false })).toBe(false);
  expect(changesWhenAsks(managed, { status: "approved", canDecide: true })).toBe(false);
  // Deciding it isn't setting its agent's level: someone's private agent stays out of reach of the key alone.
  expect(changesWhenAsks({ canManage: false }, { status: "pending", canDecide: true })).toBe(false);
  expect(changesWhenAsks({}, { status: "pending", canDecide: true })).toBe(false);
  expect(changesWhenAsks(undefined, { status: "pending", canDecide: true })).toBe(false);
});

test("what Undo puts back: one agent's choice, or every own choice I manage with the workspace's level", () => {
  const agents = [
    { id: "ada", approvalsLevel: "never" as const, approvalsLevelOwn: true, canManage: true },
    { id: "atlas", approvalsLevel: "risky" as const, approvalsLevelOwn: false, canManage: true },
    // Its own choice, on an agent I don't manage: the server would refuse setting it back.
    { id: "iara", approvalsLevel: "always" as const, approvalsLevelOwn: true, canManage: false },
  ];
  expect(levelsBefore("risky", agents, "atlas")).toEqual({
    workspace: "risky",
    agents: [{ id: "atlas", level: null }],
  });
  expect(levelsBefore("risky", agents, "ada")).toEqual({ workspace: "risky", agents: [{ id: "ada", level: "never" }] });
  expect(levelsBefore("always", agents)).toEqual({ workspace: "always", agents: [{ id: "ada", level: "never" }] });
});
