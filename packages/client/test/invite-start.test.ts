import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import type { Agent, OrgRole } from "../src/api/types";
import {
  approvalCargos,
  changedLists,
  INVITE_LINK_DEFAULTS,
  INVITE_LINK_MAX_USES,
  INVITE_LINK_TTLS,
  invitableChannels,
  inviteAgentCase,
  invitePickable,
  inviteReach,
  inviteRefusal,
  inviteRefusalText,
  inviteStart,
  linkFull,
  linkNeedsAttention,
  plainLink,
  sameChoices,
} from "../src/lib/invite-start";

const none = { channelIds: [], agentIds: [] };
const roles = [
  { id: "suporte", channelIds: ["c-suporte", "c-chamados"], agentIds: ["a-max"] },
  { id: "financeiro", channelIds: ["c-contas"], agentIds: ["a-fin", "a-max"] },
  { id: "vazio" },
];

describe("what an invitation starts someone with (ADR 0184)", () => {
  test("the picked cargos bring their channels and agents, then the ones added, less the ones taken out", () => {
    expect(inviteStart(roles, [], none, none)).toEqual(none);
    expect(inviteStart(roles, ["suporte"], none, none)).toEqual({
      channelIds: ["c-suporte", "c-chamados"],
      agentIds: ["a-max"],
    });
    // Two cargos: each once, in the cargos' order; one with no reach read adds nothing.
    expect(inviteStart(roles, ["suporte", "financeiro", "vazio"], none, none)).toEqual({
      channelIds: ["c-suporte", "c-chamados", "c-contas"],
      agentIds: ["a-max", "a-fin"],
    });
    // Taken out stays out, even when another cargo brings it again; added by hand comes after.
    const removed = { channelIds: ["c-chamados"], agentIds: ["a-max"] };
    const added = { channelIds: ["c-geral-2"], agentIds: ["a-ada"] };
    expect(inviteStart(roles, ["suporte", "financeiro"], added, removed)).toEqual({
      channelIds: ["c-suporte", "c-contas", "c-geral-2"],
      agentIds: ["a-fin", "a-ada"],
    });
  });

  test("each agent's case, as the server decides it", () => {
    const agent = (extra: Partial<Agent>) => ({ id: "a-fin", ownerUserId: "u-bruno", ...extra }) as Agent;
    const people = (extra: Partial<Agent> = {}) =>
      agent({ audienceMode: "people", audience: { mode: "people", userIds: [], roleIds: [] }, ...extra });
    const lia = { userId: "u-lia" };
    const ana = { userId: "u-ana" };
    // The agent as the server sends it to who manages it (`canManage`, ADR 0085 addendum of 2026-11-17).
    const managed = (extra: Partial<Agent> = {}) => people({ canManage: true, ...extra });
    expect(inviteAgentCase(agent({ audienceMode: "everyone" }), lia, [])).toBe("everyone");
    expect(inviteAgentCase(people(), lia, ["a-fin"])).toBe("cargo");
    expect(inviteAgentCase(people(), lia, [])).toBe("locked");
    expect(inviteAgentCase(people({ ownerUserId: "u-lia" }), lia, [])).toBe("opens");
    expect(inviteAgentCase(managed(), ana, [])).toBe("opens");
    expect(inviteAgentCase(managed(), ana, [], ["Bruno"])).toBe("mailbox");
    // "Edit agents" alone doesn't reach someone's private agent: the server says Ana doesn't manage it.
    expect(inviteAgentCase(people({ canManage: false }), ana, [])).toBe("locked");
    // On its owner's plan, answering nobody else: only its owner's own switch lets anyone in.
    const plan = { kind: "claude_code", account: "Claude Max" } as Agent["brain"];
    const kept = agent({ audienceMode: "owner", audience: { mode: "owner", userIds: [], roleIds: [] }, brain: plan });
    expect(inviteAgentCase(kept, { userId: "u-bruno" }, [])).toBe("plan");
    // On a plan that already answers some people, it opens like any other.
    expect(
      inviteAgentCase(managed({ brain: plan, audience: { mode: "people", userIds: ["u-rui"], roleIds: [] } }), ana, []),
    ).toBe("opens");
    expect(
      ["everyone", "cargo", "opens", "locked", "plan", "mailbox"].filter((c) => invitePickable(c as never)),
    ).toEqual(["everyone", "cargo", "opens"]);
  });
});

describe("what the dialog offers and sends (ADR 0184)", () => {
  const roles = [
    { id: "everyone", kind: "everyone" as const, permissions: ["post"] },
    { id: "suporte", kind: "custom" as const, permissions: ["approve_actions"] },
    { id: "falantes", kind: "custom" as const, permissions: ["talk_to_agents"] },
    { id: "admin", kind: "custom" as const, permissions: ["administrator"] },
  ];

  test("talking to agents comes from Todos or a picked cargo, Administrador included", () => {
    expect(inviteReach(roles, [])).toEqual({ talks: false, admin: false });
    expect(inviteReach(roles, ["suporte"])).toEqual({ talks: false, admin: false });
    expect(inviteReach(roles, ["suporte", "falantes"])).toEqual({ talks: true, admin: false });
    expect(inviteReach(roles, ["admin"])).toEqual({ talks: true, admin: true });
    const open = roles.map((r) => (r.id === "everyone" ? { ...r, permissions: ["talk_to_agents"] } : r));
    expect(inviteReach(open, []).talks).toBe(true);
  });

  test("channels: public ones, ones the viewer is in, private ones limited to a picked cargo; never #general", () => {
    const channels = [
      { id: "g", name: "general", visibility: "public" as const, isMember: true },
      { id: "pub", name: "clientes", visibility: "public" as const, isMember: false },
      { id: "in", name: "diretoria", visibility: "private" as const, isMember: true },
      { id: "sup", name: "suporte", visibility: "private" as const, isMember: false, audienceRoleIds: ["suporte"] },
      { id: "out", name: "financeiro", visibility: "private" as const, isMember: false, audienceRoleIds: ["fin"] },
    ];
    expect(invitableChannels(channels, []).map((c) => c.id)).toEqual(["pub", "in"]);
    expect(invitableChannels(channels, ["suporte"]).map((c) => c.id)).toEqual(["pub", "in", "sup"]);
  });

  test("a link at the defaults is the workspace's own; any choice, a link of its own; two links' choices compare as sets", () => {
    const plain = { roleIds: [], channelIds: [], agentIds: [], expiresIn: "30d" as const, maxUses: null };
    expect(plainLink(plain)).toBe(true);
    expect(plainLink({ ...plain, roleIds: ["suporte"] })).toBe(false);
    expect(plainLink({ ...plain, expiresIn: "7d" })).toBe(false);
    expect(plainLink({ ...plain, maxUses: 1 })).toBe(false);
    expect(sameChoices({ ...plain, channelIds: ["a", "b"] }, { ...plain, channelIds: ["b", "a"] })).toBe(true);
    expect(sameChoices({ ...plain, channelIds: ["a"] }, { ...plain, channelIds: ["a", "b"] })).toBe(false);
    expect(sameChoices(plain, { ...plain, expiresIn: "never" })).toBe(false);
    expect(linkFull({ maxUses: 1, uses: 1 })).toBe(true);
    expect(linkFull({ maxUses: 5, uses: 1 })).toBe(false);
    expect(linkFull({ maxUses: null, uses: 40 })).toBe(false);
    // What Link sends to renew the workspace's own link, and the lists the server takes, in the choices' order.
    expect(plainLink(INVITE_LINK_DEFAULTS)).toBe(true);
    expect(INVITE_LINK_TTLS).toEqual(["30m", "1h", "1d", "7d", "30d", "never"]);
    expect(INVITE_LINK_MAX_USES).toEqual([1, 5, 10, 25, 50, 100, null]);
  });

  test("Convites' attention tone: full, or less than a day left; a link that never ends is never soon", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    const at = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
    expect(linkNeedsAttention({ uses: 10, maxUses: 10, expiresAt: at(480) }, now)).toBe(true);
    expect(linkNeedsAttention({ uses: 3, maxUses: null, expiresAt: at(20) }, now)).toBe(true);
    expect(linkNeedsAttention({ expiresAt: at(30) }, now)).toBe(false);
    expect(
      linkNeedsAttention({ uses: 0, maxUses: 1, expiresAt: "9999-12-31T00:00:00.000Z", neverExpires: true }, now),
    ).toBe(false);
  });

  test("a request's approval starts on the link's cargos the approver may give, the others named as left out", () => {
    const cargo = (id: string, name: string, position: number, givable: boolean) =>
      ({
        id,
        name,
        position,
        givable,
        kind: id === "todos" ? "everyone" : "custom",
        permissions: [] as string[],
      }) as OrgRole;
    const cargos = [
      cargo("admin", "Admin", 0, false),
      cargo("fin", "Financeiro", 2, false),
      cargo("sup", "Suporte", 1, true),
      cargo("todos", "everyone", 9, false),
    ];
    expect(approvalCargos(cargos, ["fin", "sup", "admin", "todos"])).toEqual({
      given: ["sup"],
      leftOut: ["Admin", "Financeiro"],
    });
    expect(approvalCargos(cargos, [])).toEqual({ given: [], leftOut: [] });
  });

  test("Editar sends only the lists that changed, compared in any order", () => {
    const was = { roleIds: ["suporte"], channelIds: ["c-suporte"], agentIds: ["max"] };
    expect(changedLists(was, { roleIds: ["suporte"], channelIds: ["c-suporte"], agentIds: ["max"] })).toEqual({});
    expect(changedLists(was, { roleIds: [], channelIds: ["c-suporte"], agentIds: [] })).toEqual({
      roleIds: [],
      agentIds: [],
    });
    expect(changedLists({ roleIds: ["a", "b"] }, { roleIds: ["b", "a"], channelIds: [], agentIds: [] })).toEqual({});
    expect(changedLists({}, { roleIds: [], channelIds: ["c1"], agentIds: [] })).toEqual({ channelIds: ["c1"] });
  });

  test("a refused pick is read off the server's params and said with its way on", () => {
    const i18n = i18next.createInstance();
    void i18n.init({ lng: "pt-BR", resources, initAsync: false, interpolation: { escapeValue: false } });
    const t = i18n.t.bind(i18n) as TFunction;
    const refused = (code: string, params?: Record<string, unknown>) =>
      inviteRefusal(new ApiError(400, code, "no", params));
    const archived = refused("invitation.channel", { channelId: "c1", name: "suporte", why: "archived" });
    expect(archived).toEqual({ kind: "channel", id: "c1", name: "suporte", why: "archived" });
    if (archived?.kind !== "channel") throw new Error("a channel");
    expect(inviteRefusalText(t, archived)).toBe("O #suporte foi arquivado. Tire o canal para enviar.");
    expect(inviteRefusalText(t, { kind: "channel", id: "c2", name: "diretoria", why: "left" })).toBe(
      "Você não está mais no #diretoria. Tire o canal para enviar.",
    );
    // A channel gone names none: the marked one is the one to take out.
    expect(inviteRefusalText(t, { kind: "channel", id: "c3", name: null, why: "gone" })).toBe(
      "Um dos canais não existe mais. Tire o marcado para enviar.",
    );
    const max = refused("invitation.agent", { agentId: "a1", name: "Max", why: "gone" });
    if (max?.kind !== "agent") throw new Error("an agent");
    expect(inviteRefusalText(t, max)).toBe("O Max saiu do time. Tire do convite para enviar.");
    expect(inviteRefusalText(t, { kind: "agent", id: "a2", name: "Ada", why: "locked" })).toBe(
      "Você não pode mais liberar a Ada. Tire do convite para enviar.",
    );
    // An agent gone without a name, never "O  saiu do time.".
    const unnamed = refused("invitation.agent", { agentId: "a3", name: "", why: "gone" });
    expect(unnamed).toEqual({ kind: "agent", id: "a3", name: null, why: "gone" });
    if (unnamed?.kind !== "agent") throw new Error("an agent");
    expect(inviteRefusalText(t, unnamed)).toBe("Um dos agentes saiu do time. Tire o marcado para enviar.");
    // A why this app doesn't know reads as gone; a cargo the sender may no longer give, as a cargo.
    expect(refused("invitation.channel", { channelId: "c4", name: "x", why: "new" })).toMatchObject({ why: "gone" });
    for (const code of ["role.above_you", "role.grant_forbidden", "role.unknown"])
      expect(refused(code)).toEqual({ kind: "role" });
    // Anything else is the caller's to say.
    expect(refused("invitation.channel", { why: "archived" })).toBeNull();
    expect(refused("role.name_long")).toBeNull();
    expect(inviteRefusal(new Error("offline"))).toBeNull();
  });
});
