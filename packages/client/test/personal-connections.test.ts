import { describe, expect, test } from "bun:test";
import type { Connection, CustomServer } from "../src/api/types";
import {
  connectedItems,
  connectionActs,
  connectionTabs,
  personalAllowed,
  personalOfParts,
  personalOfText,
} from "../src/lib/connected";
import { mailboxName } from "../src/lib/mail";
import { ownerScopeOf, ownerSplit } from "../src/lib/owner-split";

const connection = (id: string, ownerUserId?: string | null): Connection => ({
  id,
  connector: "linear",
  label: `Linear ${id}`,
  serverUrl: "https://mcp.linear.app/mcp",
  authType: "api_key",
  accountLabel: null,
  tokenExpiresAt: null,
  createdAt: `2026-11-1${id.length}T10:00:00.000Z`,
  revokedAt: null,
  ...(ownerUserId === undefined ? {} : { ownerUserId }),
});
const server = (id: string, ownerUserId: string | null): CustomServer => ({
  id,
  serverUrl: "",
  label: `Stripe ${id}`,
  authType: "oauth",
  tools: [],
  reviewedAt: null,
  createdAt: "2026-11-15T10:00:00.000Z",
  ownerUserId,
});

describe("Equipe | Pessoal for connections", () => {
  test("a row is the team's, the viewer's own, or someone else's; an older server's rows are the team's", () => {
    expect(ownerScopeOf({}, "walter")).toBe("team");
    expect(ownerScopeOf({ ownerUserId: null }, "walter")).toBe("team");
    expect(ownerScopeOf({ ownerUserId: "walter" }, "walter")).toBe("mine");
    expect(ownerScopeOf({ ownerUserId: "bia" }, "walter")).toBe("others");
  });

  test("the list splits into the tabs and the others' group, kinds kept together, counts from the split", () => {
    const items = connectedItems(
      [connection("a"), connection("bb", "walter"), connection("ccc", "bia")],
      [server("s1", "walter"), server("s2", null)],
      [],
    );
    const split = ownerSplit(items, "walter");
    expect(split.team.map((i) => i.id).sort()).toEqual(["a", "s2"]);
    expect(split.mine.map((i) => i.id).sort()).toEqual(["bb", "s1"]);
    expect(split.others.map((i) => i.id)).toEqual(["ccc"]);
  });
});

describe("what a viewer may do with a row (the engine's rule)", () => {
  test("their own: everything, and moving it to the team only when they manage connectors", () => {
    expect(connectionActs({ ownerUserId: "walter" }, "walter", false)).toEqual({
      open: true,
      rename: true,
      change: true,
      remove: true,
      giveToAgents: true,
      takeOffAgent: true,
      moveToTeam: false,
    });
    expect(connectionActs({ ownerUserId: "walter" }, "walter", true).moveToTeam).toBe(true);
  });

  test("someone else's: never opened; who manages connectors removes it or takes it off an agent, nothing else", () => {
    expect(connectionActs({ ownerUserId: "bia" }, "walter", true)).toEqual({
      open: false,
      rename: false,
      change: false,
      remove: true,
      giveToAgents: false,
      takeOffAgent: true,
      moveToTeam: false,
    });
    const member = connectionActs({ ownerUserId: "bia" }, "walter", false);
    expect(Object.values(member).every((may) => !may)).toBe(true);
  });

  test("the team's: every member opens it, who manages connectors changes it", () => {
    expect(connectionActs({ ownerUserId: null }, "walter", false)).toMatchObject({
      open: true,
      rename: false,
      remove: false,
      giveToAgents: false,
    });
    expect(connectionActs({ ownerUserId: null }, "walter", true)).toMatchObject({ rename: true, remove: true });
  });

  test("every connector, GitHub among them, and a server by address may be personal", () => {
    expect(personalAllowed("github")).toBe(true);
    expect(personalAllowed("linear")).toBe(true);
    expect(personalAllowed(null)).toBe(true);
  });
});

describe("the shared split of Conectores (web and phone)", () => {
  const mine = connection("c1", "walter");
  const team = connection("c2", null);
  const box = (id: string, ownerUserId: string | null) => ({ id, ownerUserId });

  test("a workspace of one keeps one list with its own mailbox in it; a personal connection splits it", () => {
    const alone = connectionTabs({
      items: connectedItems([team], [], []),
      mailboxes: [box("m1", "walter")],
      me: "walter",
      members: 1,
      manages: true,
      picked: null,
    });
    expect([alone.shown, alone.tab]).toEqual([false, "team"]);
    expect(alone.mailboxes.map((m) => m.id)).toEqual(["m1"]);
    const split = connectionTabs({
      items: connectedItems([team, mine], [], []),
      mailboxes: [box("m1", "walter")],
      me: "walter",
      members: 1,
      manages: true,
      picked: "personal",
    });
    expect(split.shown).toBe(true);
    expect(split.mailboxes.map((m) => m.id)).toEqual(["m1"]);
  });

  test("the team's databases count on Equipe", () => {
    const tabs = connectionTabs({
      items: connectedItems([team], [], []),
      mailboxes: [],
      me: "walter",
      members: 3,
      manages: true,
      picked: null,
      databases: 2,
    });
    expect(tabs.team).toBe(3);
  });

  test("a one-click connection never offers to move to the team: it connects again for the team", () => {
    expect(connectionActs({ ownerUserId: "walter" }, "walter", true).moveToTeam).toBe(true);
    expect(connectionActs({ ownerUserId: "walter", viaComposio: true }, "walter", true).moveToTeam).toBe(false);
  });

  test("whose it is keeps a right-to-left name in its own direction, and someone else's mailbox goes by its service", () => {
    const t = ((key: string, o?: Record<string, unknown>) =>
      key === "connectors.personal.of"
        ? `Pessoal de ${o?.name}`
        : key === "mail.choice.gmail.name"
          ? "Gmail"
          : key) as never;
    expect(personalOfText(t, "عبد الرحمن")).toBe("Pessoal de \u2068عبد الرحمن\u2069");
    // The web cuts the name alone: the words around it, in the language's order.
    expect(personalOfParts(t)).toEqual({ before: "Pessoal de ", after: "" });
    expect(mailboxName(t, { label: "", provider: "gmail", preset: null })).toBe("Gmail");
    expect(mailboxName(t, { label: "Vendas", provider: "gmail", preset: null })).toBe("Vendas");
  });
});
