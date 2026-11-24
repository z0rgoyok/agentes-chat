import { describe, expect, test } from "bun:test";
import type { OrgRole } from "../src/api/types";
import {
  agentOwnerOf,
  hasAgentOwner,
  ownerNameOf,
  ownerPatchOf,
  ownerRoles,
  ownerValueOf,
  ownsAgentAs,
  roleOfOwnerValue,
} from "../src/lib/agent-owner";

const NONE = "__none__";

const role = (id: string, over: Partial<OrgRole> = {}): OrgRole => ({
  id,
  kind: "custom",
  name: id,
  icon: "person",
  color: "teal",
  position: 1,
  permissions: [],
  mentionable: true,
  hoist: false,
  people: 2,
  editable: true,
  givable: true,
  ...over,
});

describe("an agent's owner: a person, a role or nobody (ADR 0085, addendum of 2026-11-21)", () => {
  test("which one, and who answers for it", () => {
    expect(agentOwnerOf({ ownerUserId: "u-ana" })).toEqual({ kind: "person", userId: "u-ana" });
    expect(agentOwnerOf({ ownerUserId: null, ownerRoleId: "r-tech" })).toEqual({ kind: "role", roleId: "r-tech" });
    expect(agentOwnerOf({})).toEqual({ kind: "none" });
    expect(hasAgentOwner({ ownerRoleId: "r-tech" })).toBe(true);
    expect(hasAgentOwner({ ownerUserId: null })).toBe(false);
    expect(ownsAgentAs({ ownerRoleId: "r-tech" }, "u-bia", ["r-tech"])).toBe(true);
    expect(ownsAgentAs({ ownerRoleId: "r-tech" }, "u-dani", ["r-sales"])).toBe(false);
    expect(ownsAgentAs({ ownerUserId: "u-ana" }, "u-ana", [])).toBe(true);
  });

  test("the picker's value and what a save sends: a role clears the person, a person or nobody the role", () => {
    expect(ownerValueOf({ ownerUserId: "u-ana" }, NONE)).toBe("u-ana");
    expect(ownerValueOf({ ownerRoleId: "r-tech" }, NONE)).toBe("role:r-tech");
    expect(ownerValueOf({}, NONE)).toBe(NONE);
    expect(roleOfOwnerValue("role:r-tech")).toBe("r-tech");
    expect(roleOfOwnerValue("u-ana")).toBeNull();
    expect(ownerPatchOf("role:r-tech", NONE)).toEqual({ ownerUserId: null, ownerRoleId: "r-tech" });
    expect(ownerPatchOf("u-ana", NONE)).toEqual({ ownerUserId: "u-ana", ownerRoleId: null });
    expect(ownerPatchOf(NONE, NONE)).toEqual({ ownerUserId: null, ownerRoleId: null });
  });

  test("the roles offered leave out the base role and any that administers (no owner already means the admins)", () => {
    const roles = [
      role("r-admin", { permissions: ["administrator"] }),
      role("r-tech"),
      role("r-all", { kind: "everyone" }),
    ];
    expect(ownerRoles(roles).map((r) => r.id)).toEqual(["r-tech"]);
  });

  test("the owner's name: the person's, else the role's", () => {
    const names = {
      person: (id: string) => ({ "u-ana": "Ana" })[id],
      role: (id: string) => ({ "r-tech": "Tech" })[id],
    };
    expect(ownerNameOf({ ownerUserId: "u-ana" }, names)).toBe("Ana");
    expect(ownerNameOf({ ownerRoleId: "r-tech" }, names)).toBe("Tech");
    expect(ownerNameOf({}, names)).toBeUndefined();
  });
});
