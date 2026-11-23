import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAccess, Connection, ConnectorDef } from "@agenteschat/client";
import { connectedItems } from "@agenteschat/client/lib/connected";
import { othersPersonalOf, usesOf } from "../../src/features/agents/logic";
import { connectionTabs } from "../../src/features/connectors/logic";
import { translator } from "./fixtures";

const src = (f: string) => readFileSync(join(import.meta.dir, "../../src", f), "utf8");

const def = (id: string): ConnectorDef => ({
  id,
  label: id,
  description: `${id} for Acme`,
  kind: "catalog",
  category: "dev",
  auth: ["oauth"],
  oauthConfigured: true,
  available: true,
  serverUrl: `https://mcp.${id}.example.com/mcp`,
  iconUrl: null,
  brandColor: null,
  scopes: [],
  tools: [],
});

const conn = (id: string, connector: string, ownerUserId: string | null = null): Connection => ({
  id,
  connector,
  label: connector,
  serverUrl: "https://mcp.example.com",
  authType: "oauth",
  accountLabel: null,
  tokenExpiresAt: null,
  createdAt: "2026-11-01T12:00:00.000Z",
  revokedAt: null,
  ownerUserId,
  ...(ownerUserId ? { agentIds: ["atlas"] } : {}),
});

const catalog = [def("linear"), def("notion"), def("github")];
const mail = (id: string, ownerUserId: string | null) => ({ id, ownerUserId, status: "connected" });

// Walter manages connectors; Bia is a member. Each sees what the server hands them (`others` for Walter only).
const team = conn("c-team", "linear");
const walters = conn("c-walter", "notion", "walter");
const bias = conn("c-bia", "linear", "bia");
const tabs = (
  me: string,
  manages: boolean,
  list: Connection[],
  members = 3,
  picked: "team" | "personal" | null = null,
) =>
  connectionTabs({
    items: connectedItems(list, [], catalog),
    mailboxes: [mail("m-team", null), mail("m-bia", "bia")],
    me,
    members,
    manages,
    picked,
  });

describe("Conectores on the phone: Equipe | Pessoal as the web's (ADR 0099 addendum)", () => {
  test("a member opens on Pessoal with only their own; the team's tab holds the team's", () => {
    const bia = tabs("bia", false, [team, bias]);
    expect(bia.shown).toBe(true);
    expect(bia.tab).toBe("personal");
    expect(bia.items.map((i) => i.id)).toEqual(["c-bia"]);
    expect(bia.mailboxes.map((m) => m.id)).toEqual(["m-bia"]);
    expect([bia.team, bia.mine]).toEqual([2, 2]);
    expect(bia.others).toEqual([]);
    expect(tabs("bia", false, [team, bias], 3, "team").items.map((i) => i.id)).toEqual(["c-team"]);
  });

  test("who manages connectors opens on Equipe, sees others' personal ones under it, and never on Pessoal", () => {
    const walter = tabs("walter", true, [team, walters, bias]);
    expect(walter.tab).toBe("team");
    expect(walter.items.map((i) => i.id)).toEqual(["c-team"]);
    expect(walter.others.map((i) => i.id)).toEqual(["c-bia"]);
    expect(walter.othersMail.map((m) => m.id)).toEqual(["m-bia"]);
    const own = tabs("walter", true, [team, walters, bias], 3, "personal");
    expect(own.items.map((i) => i.id)).toEqual(["c-walter"]);
    expect(own.others).toEqual([]);
    // A member's list never puts someone else's personal connection in a group, even if one slipped in.
    expect(tabs("bia", false, [team, walters], 3, "team").others).toEqual([]);
  });

  test("who manages connectors with only their own opens on Pessoal, as on Skills; a workspace of one keeps one list", () => {
    const walter = connectionTabs({
      items: connectedItems([walters], [], catalog),
      mailboxes: [],
      me: "walter",
      members: 2,
      manages: true,
      picked: null,
    });
    expect(walter.tab).toBe("personal");
    const alone = connectionTabs({
      items: connectedItems([team], [], catalog),
      mailboxes: [],
      me: "walter",
      members: 1,
      manages: true,
      picked: "personal",
    });
    expect([alone.shown, alone.tab]).toEqual([false, "team"]);
    // Their own mailbox (every mailbox has its person) stays in that one list.
    const withMail = connectionTabs({
      items: connectedItems([team], [], catalog),
      mailboxes: [mail("m-walter", "walter")],
      me: "walter",
      members: 1,
      manages: true,
      picked: null,
    });
    expect([withMail.shown, withMail.mailboxes.map((m) => m.id)]).toEqual([false, ["m-walter"]]);
  });

  test("the screen reads others' rows only for who manages connectors, with Pessoal's own Adicionar", () => {
    const screen = src("features/connectors/ConnectorsScreen.tsx");
    expect(screen).toContain("const others = { others: manages };");
    expect(screen).toContain("useConnections(orgId, true, others)");
    expect(screen).toContain("useMailAccounts(orgId, true, others)");
    expect(screen).toContain("const mayAdd = !frozen && (manages || personal);");
    expect(screen).toContain("(d) => !personal || personalAllowed(d.id)");
    expect(screen).toContain('t("connectors.personal.others")');
    // Others' rows open only Tirar de um agente and Remover: never their screen, tools or account.
    const group = screen.slice(screen.indexOf("function OthersPersonal"), screen.indexOf("function UsedBy"));
    expect(group).not.toContain("openConnection");
    expect(group).not.toContain("openTools");
    expect(group).toContain('t("connectors.personal.takeOff")');
    expect(group).toContain('t("connectors.personal.remove")');
  });
});

describe("Pessoal on the phone: one's mailboxes keep their own rule", () => {
  test("they are a group of their own, with their line, and the connections' note sits over the connections only", () => {
    const screen = src("features/connectors/ConnectorsScreen.tsx");
    expect(screen).toContain("const rowMail = personal ? [] : mailboxes;");
    expect(screen).toContain('t("connectors.personal.mailTitle")');
    expect(screen).toContain('t("connectors.personal.mailNote")');
    const group = screen.indexOf('t("connectors.personal.mailNote")');
    const note = screen.indexOf('t("connectors.personal.note")');
    expect(group).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(group);
    expect(screen).toContain("{personal && items.length > 0 ? (");
  });

  test("one connection's own screen speaks of it alone, the list of them all", () => {
    expect(src("features/connectors/ConnectionScreen.tsx")).toContain('t("connectors.personal.noteOne")');
    expect(src("features/connectors/ConnectionScreen.tsx")).not.toContain('t("connectors.personal.note")');
    expect(src("features/connectors/ConnectorsScreen.tsx")).toContain('t("connectors.personal.note")');
  });
});

describe("Connecting on the phone: Para quem and the closing line", () => {
  test("a personal connection says so on every call; the team's sends nothing new", () => {
    const sheet = src("features/connectors/ConnectSheet.tsx");
    expect(sheet).toContain("const mine = theirs ? { personal: true } : {};");
    expect(sheet.match(/\.\.\.mine/g)?.length).toBe(4);
    expect(sheet).toContain("const forWhom = !item && !teamOnly && members > 1;");
    expect(sheet).toContain("disabled: !admin },");
    expect(sheet).toContain('t("connectors.personal.teamLocked")');
    expect(sheet).toContain('t("connectors.personal.done")');
    // A connection already there is looked up in the sheet's own tab, never the other's.
    expect(sheet).toContain("connectionOf(def, mine ? owned.mine : owned.team)");
  });

  test("the kit's segmented choice takes a segment that can't be chosen", () => {
    const seg = src("ui/Segmented.tsx");
    expect(seg).toContain("const off = item.disabled === true && !on;");
    expect(seg).toContain("disabled={off}");
    expect(seg).toContain("accessibilityState={{ selected: on, disabled: off }}");
  });

  test("the words, in Portuguese and English", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    expect(pt("connectors.personal.done")).toBe("Seus agentes só usam quando você pede.");
    expect(en("connectors.personal.done")).toBe("Your agents use it only when you ask.");
    expect(pt("connectors.personal.worksWhenAsked")).toBe("Só funciona quando você pede.");
    expect(pt("connectors.personal.of", { name: "Bia" })).toBe("Pessoal de Bia");
  });

  test("a chat's card to connect opens for every member, GitHub only for who manages connectors", () => {
    const card = src("features/ai/OfferCard.tsx");
    expect(card).toContain('can(org, "manage_connectors") || personalAllowed(card.connector)');
    const screen = src("features/connectors/ConnectorsScreen.tsx");
    expect(screen).toContain("if (!manages && !personalAllowed(connect)) return;");
  });
});

describe("An agent's screen: the viewer's own marked Pessoal, someone else's only turns off", () => {
  const scope = { scope: "linear:read", label: "Ler", state: "granted", tools: [] };
  const access = {
    all: false,
    builtins: [],
    connectors: [
      {
        connectionId: "c-bia",
        connector: "linear",
        label: "Linear da Bia",
        custom: false,
        state: "granted",
        scopes: [scope],
        ownerUserId: "bia",
      },
      {
        connectionId: "c-team",
        connector: "notion",
        label: "Notion",
        custom: false,
        state: "granted",
        scopes: [scope],
      },
    ],
  } as unknown as AgentAccess;

  test("the team's first, then the viewer's own personal ones", () => {
    const { lines } = usesOf(access);
    expect(lines.map((l) => [l.connectionId, l.personal])).toEqual([
      ["c-team", false],
      ["c-bia", true],
    ]);
  });

  test("someone else's comes only from the others tree, never the viewer's own or the team's", () => {
    const withOthers = {
      ...access,
      connectors: [
        ...access.connectors,
        {
          connectionId: "c-joao",
          connector: "linear",
          label: "Linear",
          custom: false,
          state: "granted",
          scopes: [],
          ownerUserId: "joao",
        },
      ],
    } as AgentAccess;
    expect(othersPersonalOf(withOthers, "bia").map((c) => c.connectionId)).toEqual(["c-joao"]);
    expect(othersPersonalOf(null, "bia")).toEqual([]);
    const screen = src("features/agents/AgentProfileScreen.tsx");
    expect(screen).toContain('const takesOff = details && (decides || can(org, "manage_connectors"));');
    expect(screen).toContain("useAgentAccess(orgId, id, takesOff, { others: true })");
    expect(screen).toContain('t("connectors.personal.turnOff")');
    expect(screen).toContain('text: t("connectors.personal.worksWhenAsked")');
  });

  test("someone else's mailbox shows only while this agent holds it, by its name", () => {
    const mailSection = src("features/agents/AgentMailSection.tsx");
    expect(mailSection).toContain("useMailAccounts(orgId, enabled, { others: true })");
    expect(mailSection).toContain("a.agents.some((x) => x.agentId === agentId)");
    expect(mailSection).toContain("address: account.address || mailboxName(t, account)");
  });
});

test("a routine watching a teammate's mailbox, which the viewer's list doesn't hold, still names one on its row", () => {
  expect(src("features/routines/RoutineForm.tsx")).toContain(
    'upperFirst(t("mail.routine.unknownMailbox"), i18n.language)',
  );
});
