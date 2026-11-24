import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { Agent, OrgSummary } from "../src/api/types";
import { ADVANCED_SECTIONS, AGENT_SECTIONS, sameEditors } from "../src/lib/agent-edit";
import {
  canEditAudience,
  createsRoutinesFor,
  editorsMode,
  editorsOf,
  editorsPatch,
  editorsSummary,
  editorsValueOf,
  editsAgent,
  hiddenAgentIds,
  listsAgent,
  managesAgent,
  managesRoutinesOf,
  opensDm,
} from "../src/lib/audience";
import { managesTeamAgents } from "../src/lib/team-plan";
import { mayUndoLines } from "../src/lib/team-views";

// "Who can edit" (ADR 0085, addendum of 2026-11-17): who changes how an agent works (its instructions, role, skills and
// routines) besides its owner and who manages it.

const en = i18next.createInstance();
void en.init({ lng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
const t = en.t.bind(en) as TFunction;

const names: Record<string, string> = {
  "u-ana": "Ana Souza",
  "u-bruno": "Bruno Lima",
  "u-carla": "Carla",
  "u-davi": "Davi",
  "u-eva": "Eva",
};
const roleNames: Record<string, string> = { "r-support": "Support", "r-sales": "Sales" };
const nameOf = (id: string) => names[id];
const roleName = (id: string) => roleNames[id];

/** Iara, Ana's agent, as the server sends it to whoever looks at it. */
const iara = (over: Partial<Agent> = {}): Agent => ({
  id: "a-iara",
  name: "Iara",
  handle: "iara",
  role: "",
  instructions: "",
  model: "m",
  ownerUserId: "u-ana",
  hasCredential: false,
  monthlyBudgetUsd: null,
  createdAt: "",
  ...over,
});

describe("Who can edit: what it names", () => {
  test("editorsOf: the people and roles it names, never its owner; an older server names nobody", () => {
    expect(editorsOf(iara())).toEqual({ userIds: [], roleIds: [] });
    expect(editorsOf(iara({ editors: { userIds: ["u-bruno", "u-ana"], roleIds: ["r-support"] } }))).toEqual({
      userIds: ["u-bruno"],
      roleIds: ["r-support"],
    });
    // With no owner, nobody is left out.
    expect(editorsOf(iara({ ownerUserId: null, editors: { userIds: ["u-ana"], roleIds: [] } }))).toEqual({
      userIds: ["u-ana"],
      roleIds: [],
    });
  });

  test("its choice: 'people' once it names someone besides its owner, else only who looks after it", () => {
    expect(editorsMode({ userIds: [], roleIds: [] })).toBe("owner");
    expect(editorsMode({ userIds: ["u-bruno"], roleIds: [] })).toBe("people");
    expect(editorsMode({ userIds: [], roleIds: ["r-support"] })).toBe("people");
    expect(editorsValueOf(iara())).toEqual({ mode: "owner", userIds: [], roleIds: [] });
    expect(editorsValueOf(iara({ editors: { userIds: ["u-bruno"], roleIds: ["r-support"] } }))).toEqual({
      mode: "people",
      userIds: ["u-bruno"],
      roleIds: ["r-support"],
    });
    // Named before they became its owner: it names nobody else, so the choice shows nobody picked.
    expect(editorsValueOf(iara({ editors: { userIds: ["u-ana"], roleIds: [] } }))).toEqual({
      mode: "owner",
      userIds: [],
      roleIds: [],
    });
  });

  test("a save sends the whole lists under 'people'; only who looks after it names nobody, the picks set aside", () => {
    expect(editorsPatch({ mode: "people", userIds: ["u-bruno"], roleIds: ["r-support"] })).toEqual({
      userIds: ["u-bruno"],
      roleIds: ["r-support"],
    });
    expect(editorsPatch({ mode: "owner", userIds: ["u-bruno"], roleIds: ["r-support"] })).toEqual({
      userIds: [],
      roleIds: [],
    });
  });

  test("sameEditors compares whom it names, as sets: 'people' with nobody picked is only who looks after it", () => {
    const picked = { mode: "people" as const, userIds: ["u-bruno", "u-carla"], roleIds: ["r-support"] };
    expect(sameEditors(picked, { mode: "people", userIds: ["u-carla", "u-bruno"], roleIds: ["r-support"] })).toBe(true);
    expect(sameEditors(picked, { ...picked, userIds: ["u-bruno"] })).toBe(false);
    expect(sameEditors(picked, { ...picked, roleIds: [] })).toBe(false);
    expect(sameEditors(picked, { ...picked, mode: "owner" })).toBe(false);
    expect(
      sameEditors({ mode: "people", userIds: [], roleIds: [] }, { mode: "owner", userIds: ["u-bruno"], roleIds: [] }),
    ).toBe(true);
  });

  test("its summary: its owner first, then the people and roles, as the audience's; nobody else named", () => {
    expect(editorsSummary(t, iara(), nameOf)).toBe("Only who looks after it");
    expect(editorsSummary(t, iara({ editors: { userIds: ["u-bruno"], roleIds: [] } }), nameOf)).toBe(
      "Ana Souza and Bruno Lima",
    );
    expect(
      editorsSummary(t, iara({ editors: { userIds: ["u-bruno"], roleIds: ["r-support"] } }), nameOf, roleName),
    ).toBe("Ana Souza, Bruno Lima, and Support");
    // Past three names: the first two and how many more, people when it names no role.
    expect(
      editorsSummary(t, iara({ editors: { userIds: ["u-bruno", "u-carla", "u-davi"], roleIds: [] } }), nameOf),
    ).toBe("Ana Souza, Bruno Lima and 2 more people");
    expect(
      editorsSummary(
        t,
        iara({ editors: { userIds: ["u-bruno", "u-carla"], roleIds: ["r-support", "r-sales"] } }),
        nameOf,
        roleName,
      ),
    ).toBe("Ana Souza, Bruno Lima and 3 more");
    // Its owner named too is said once, and only the names we know.
    expect(editorsSummary(t, iara({ editors: { userIds: ["u-ana", "u-bruno", "u-gone"], roleIds: [] } }), nameOf)).toBe(
      "Ana Souza and Bruno Lima",
    );
    expect(editorsSummary(t, iara({ editors: { userIds: ["u-gone"], roleIds: [] } }), nameOf)).toBe(
      "Only who looks after it",
    );
    // With no owner: the people alone.
    expect(editorsSummary(t, iara({ ownerUserId: null, editors: { userIds: ["u-bruno"], roleIds: [] } }), nameOf)).toBe(
      "Bruno Lima",
    );
  });

  test("Settings has its section right after Who can talk, in Advanced for a personal workspace", () => {
    expect(AGENT_SECTIONS.indexOf("editors")).toBe(AGENT_SECTIONS.indexOf("audience") + 1);
    expect(ADVANCED_SECTIONS).toContain("editors");
  });
});

describe("Who can edit: what each person may do, from the server's flags", () => {
  const member: OrgSummary = { id: "org", name: "Acme", role: "member", permissions: ["read", "talk_to_agents"] };
  const keyHolder: OrgSummary = { ...member, permissions: ["read", "talk_to_agents", "manage_agents"] };

  test("manages, edits and sets up routines only where the server says so; absent is no", () => {
    expect(managesAgent(iara({ canManage: true }))).toBe(true);
    expect(managesAgent(iara())).toBe(false);
    expect(managesAgent(undefined)).toBe(false);
    expect(editsAgent(iara({ canEdit: true }))).toBe(true);
    expect(editsAgent(iara({ canEdit: false }))).toBe(false);
    expect(editsAgent(null)).toBe(false);
    expect(managesRoutinesOf(iara({ canManageRoutines: true }))).toBe(true);
    expect(managesRoutinesOf(iara())).toBe(false);
  });

  test("who talks to it and who edits it: its owner or who manages it, never the key alone nor a named editor", () => {
    expect(canEditAudience(member, iara(), "u-ana")).toBe(true);
    expect(canEditAudience(keyHolder, iara({ canManage: true }), "u-carla")).toBe(true);
    // "Edit agents" that doesn't reach it: someone's private agent.
    expect(canEditAudience(keyHolder, iara({ canManage: false }), "u-carla")).toBe(false);
    // Named in "Who can edit": they edit how it works, not who edits it.
    const named = iara({ canEdit: true, editors: { userIds: ["u-eva"], roleIds: [] } });
    expect(canEditAudience(member, named, "u-eva")).toBe(false);
  });

  test("whose lists show it: who it answers, who manages it, and who edits it; never the key alone", () => {
    const locked = iara({ canTalk: false });
    expect(listsAgent(member, locked)).toBe(false);
    expect(listsAgent(member, { ...locked, canEdit: true })).toBe(true);
    // "Edit agents" that doesn't reach someone's private agent leaves it out; where it reaches, the lock says why.
    expect(listsAgent(keyHolder, locked)).toBe(false);
    expect(listsAgent(keyHolder, { ...locked, canManage: true, canEdit: true })).toBe(true);
    // An older server says nothing: it talks to me.
    expect(listsAgent(member, undefined)).toBe(true);
  });

  test("whose DM opens: who it answers and who manages it, never who only edits it (the server's openDm)", () => {
    expect(opensDm(iara())).toBe(true);
    expect(opensDm(iara({ canTalk: false }))).toBe(false);
    expect(opensDm(iara({ canTalk: false, canEdit: true }))).toBe(false);
    expect(opensDm(iara({ canTalk: false, canManage: true, canEdit: true }))).toBe(true);
    expect(opensDm(undefined)).toBe(true);
  });

  test("the DMs the lists leave out: an agent whose DM wouldn't open, one I only edit included", () => {
    const locked = iara({ canTalk: false });
    const nina = iara({ id: "a-nina", name: "Nina", canTalk: false, canEdit: true });
    const leo = iara({ id: "a-leo", name: "Leo", canTalk: false, canManage: true, canEdit: true });
    const ada = iara({ id: "a-ada", name: "Ada", canTalk: true });
    expect(hiddenAgentIds(member, [locked, nina, leo, ada])).toEqual(new Set(["a-iara", "a-nina"]));
    expect(hiddenAgentIds(keyHolder, [locked, nina, leo, ada])).toEqual(new Set(["a-iara", "a-nina"]));
  });

  test("making or copying a routine for it: setting up its routines and it answers me", () => {
    expect(createsRoutinesFor(iara({ canManageRoutines: true }))).toBe(true);
    expect(createsRoutinesFor(iara({ canManageRoutines: true, canTalk: true }))).toBe(true);
    // Named in "Who can edit", it won't answer: its routines are mine to change, not to make.
    expect(createsRoutinesFor(iara({ canManageRoutines: true, canEdit: true, canTalk: false }))).toBe(false);
    expect(createsRoutinesFor(iara({ canTalk: true }))).toBe(false);
    expect(createsRoutinesFor(undefined)).toBe(false);
  });
});

describe("what a change of lines lets me undo", () => {
  const team = [{ id: "a-atlas", canManage: true }, { id: "a-nina", canManage: false }, { id: "a-iara" }];

  test("Undo: each agent back under nobody or under an agent I manage", () => {
    expect(mayUndoLines([], team)).toBe(true);
    expect(mayUndoLines([{ agentId: "a-iara", reportsToAgentId: null }], team)).toBe(true);
    expect(mayUndoLines([{ agentId: "a-iara", reportsToAgentId: "a-atlas" }], team)).toBe(true);
  });

  test("no Undo back under someone's private agent, one the server says nothing of, or one no longer here", () => {
    expect(mayUndoLines([{ agentId: "a-iara", reportsToAgentId: "a-nina" }], team)).toBe(false);
    expect(mayUndoLines([{ agentId: "a-atlas", reportsToAgentId: "a-iara" }], team)).toBe(false);
    expect(mayUndoLines([{ agentId: "a-iara", reportsToAgentId: "a-gone" }], team)).toBe(false);
    // One line that can't go back holds the rest: the server applies all of them or none.
    expect(
      mayUndoLines(
        [
          { agentId: "a-iara", reportsToAgentId: "a-atlas" },
          { agentId: "a-atlas", reportsToAgentId: "a-nina" },
        ],
        team,
      ),
    ).toBe(false);
  });
});

describe("undoing a team someone else created", () => {
  const keyHolder = { permissions: ["read", "manage_agents"] };
  const admin = { permissions: ["read", "manage_agents", "administrator"] };
  const here = [
    { id: "a-iara", canManage: true },
    { id: "a-nina", canManage: false },
  ];

  test("needs Edit agents and managing every agent it made, from the directory", () => {
    expect(managesTeamAgents(keyHolder, ["a-iara"], here, [])).toBe(true);
    expect(managesTeamAgents(keyHolder, ["a-iara", "a-nina"], here, [])).toBe(false);
    expect(managesTeamAgents({ permissions: ["read"] }, ["a-iara"], here, [])).toBe(false);
    expect(managesTeamAgents(keyHolder, [], here, [])).toBe(true);
  });

  test("an archived one by its own canManage, a deleted one reached by the key, one not known yet only by an admin", () => {
    const former = [
      { id: "a-leo", deleted: false, canManage: true },
      { id: "a-bia", deleted: false, canManage: false },
      { id: "a-old", deleted: true },
    ];
    expect(managesTeamAgents(keyHolder, ["a-iara", "a-leo"], here, former)).toBe(true);
    expect(managesTeamAgents(keyHolder, ["a-iara", "a-bia"], here, former)).toBe(false);
    expect(managesTeamAgents(keyHolder, ["a-iara", "a-old"], here, former)).toBe(true);
    // Archived and not yet read: never assumed mine.
    expect(managesTeamAgents(keyHolder, ["a-iara", "a-zed"], here, former)).toBe(false);
    expect(managesTeamAgents(keyHolder, ["a-iara", "a-zed"], here, undefined)).toBe(false);
    expect(managesTeamAgents(admin, ["a-iara", "a-zed"], here, undefined)).toBe(true);
  });
});
