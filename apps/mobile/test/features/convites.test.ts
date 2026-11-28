import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, InviteLink, JoinRequest, OrgRole } from "@agenteschat/client";
import { changedLists, linkFull, linkNeedsAttention, plainLink } from "@agenteschat/client/lib/invite-start";
import { arrivalOf } from "../../src/features/chat/logic";
import { EMPTY_INVITE, type InviteDraft } from "../../src/features/members/draft";
import {
  agentLines,
  agentPicks,
  cargoPicks,
  channelPicks,
  draftFrom,
  flipStart,
  givesLine,
  invitationExpired,
  invitationLine,
  linkChanges,
  linkChoicesOf,
  linkLine,
  linkTitle,
  listedInvitations,
  listedPlainLink,
  maxWord,
  requestLine,
  startOf,
  ttlWord,
} from "../../src/features/members/logic";
import { areaValues, SETTINGS_SECTIONS } from "../../src/features/settings/logic";
import { pushedByDefault } from "../main-stack";
import { translator } from "./fixtures";

const NOW = new Date("2026-11-14T12:00:00Z");
const DAY = 86_400_000;
const later = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
const src = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "src", path), "utf8");
const route = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "app", "(app)", "(main)", path), "utf8");

const role = (over: Partial<OrgRole> & { id: string; name: string }) =>
  ({
    kind: "custom",
    position: 1,
    permissions: [],
    givable: true,
    color: "teal",
    icon: "shield",
    channelIds: [],
    agentIds: [],
    ...over,
  }) as OrgRole;
const EVERYONE = role({ id: "todos", name: "Todos", kind: "everyone", position: 9, permissions: ["talk_to_agents"] });
const SUPORTE = role({ id: "suporte", name: "Suporte", position: 2, channelIds: ["c-suporte"], agentIds: ["max"] });
const FIN = role({ id: "fin", name: "Financeiro", position: 3, channelIds: ["c-contas"], agentIds: ["fin"] });
const ADMIN = role({ id: "admin", name: "Admin", position: 1, permissions: ["administrator"] });
const ROLES = [ADMIN, SUPORTE, FIN, EVERYONE];

const agent = (over: Partial<Agent> & { id: string; name: string }) =>
  ({ role: "", ownerUserId: "u-bruno", audienceMode: "everyone", ...over }) as Agent;
const people = (roleIds: string[] = [], userIds: string[] = []) =>
  ({ audienceMode: "people", audience: { mode: "people", userIds, roleIds } }) as Partial<Agent>;
const AGENTS = [
  agent({ id: "lodi", name: "Lodi", builtin: "right_hand" }),
  agent({ id: "ada", name: "Ada", role: "Dev" }),
  agent({ id: "max", name: "Max", ...people(["suporte"]) }),
  agent({ id: "fin", name: "Fin", ownerUserId: "u-me", ...people() }),
  agent({ id: "rex", name: "Rex", ...people() }),
  agent({ id: "nora", name: "Nora", ownerUserId: "u-me", ...people() }),
];
// Whether they manage an agent is the agent's own `canManage` (ADR 0085 addendum of 2026-11-17): none here.
const VIEWER = { userId: "u-me" };

const draft = (over: Partial<InviteDraft> = {}): InviteDraft => ({ ...EMPTY_INVITE, ...over });

describe("a form's cargos bring their channels and agents (ADR 0184)", () => {
  test("a link's or an invitation's start reads back as the cargos' own, the added and the removed", () => {
    const given = { roleIds: ["suporte"], channelIds: ["c-vendas"], agentIds: ["max", "ada"] };
    const d = draftFrom(ROLES, given);
    // #suporte was taken out, #vendas added; Max is the cargo's, Ada added.
    expect(d).toEqual({
      roleIds: ["suporte"],
      added: { channelIds: ["c-vendas"], agentIds: ["ada"] },
      removed: { channelIds: ["c-suporte"], agentIds: [] },
    });
    expect(startOf(ROLES, d)).toEqual({ channelIds: ["c-vendas"], agentIds: ["max", "ada"] });
  });

  test("ticking and unticking: a cargo's own goes to removed and back; any other to added and back", () => {
    let d: Pick<InviteDraft, "roleIds" | "added" | "removed"> = draft({ roleIds: ["suporte"] });
    d = { ...d, ...flipStart(ROLES, d, "channelIds", "c-suporte") };
    expect(startOf(ROLES, d).channelIds).toEqual([]);
    d = { ...d, ...flipStart(ROLES, d, "channelIds", "c-suporte") };
    expect(startOf(ROLES, d).channelIds).toEqual(["c-suporte"]);
    d = { ...d, ...flipStart(ROLES, d, "agentIds", "ada") };
    expect(startOf(ROLES, d).agentIds).toEqual(["max", "ada"]);
    d = { ...d, ...flipStart(ROLES, d, "agentIds", "ada") };
    expect(startOf(ROLES, d).agentIds).toEqual(["max"]);
    // Another cargo brings its own in; the one taken out stays out.
    d = { ...d, ...flipStart(ROLES, d, "agentIds", "max"), roleIds: ["suporte", "fin"] };
    expect(startOf(ROLES, d)).toEqual({ channelIds: ["c-suporte", "c-contas"], agentIds: ["fin"] });
  });

  test("ticking one a dropped cargo had taken out brings it back (Suporte, untick #suporte, Membro, tick)", () => {
    let d: Pick<InviteDraft, "roleIds" | "added" | "removed"> = draft({ roleIds: ["suporte"] });
    d = { ...d, ...flipStart(ROLES, d, "channelIds", "c-suporte") };
    d = { ...d, ...flipStart(ROLES, d, "agentIds", "max") };
    d = { ...d, roleIds: [] };
    d = { ...d, ...flipStart(ROLES, d, "channelIds", "c-suporte") };
    d = { ...d, ...flipStart(ROLES, d, "agentIds", "max") };
    expect(startOf(ROLES, d)).toEqual({ channelIds: ["c-suporte"], agentIds: ["max"] });
    // Each tap flips once: nothing piles up in `added`.
    d = { ...d, ...flipStart(ROLES, d, "channelIds", "c-suporte") };
    expect(startOf(ROLES, d).channelIds).toEqual([]);
    expect(d.added.channelIds).toEqual([]);
    // Editar link: a link that left its cargo's channel out, once that cargo is unticked.
    let e = { ...draftFrom(ROLES, { roleIds: ["suporte"], agentIds: ["max"] }), roleIds: [] as string[] };
    e = { ...e, ...flipStart(ROLES, e, "channelIds", "c-suporte") };
    expect(startOf(ROLES, e).channelIds).toEqual(["c-suporte"]);
  });

  test("Link mode: the workspace's own link at the defaults, a link of its own past them", () => {
    expect(plainLink(linkChoicesOf(ROLES, draft()))).toBe(true);
    expect(plainLink(linkChoicesOf(ROLES, draft({ roleIds: ["suporte"] })))).toBe(false);
    expect(plainLink(linkChoicesOf(ROLES, draft({ expiresIn: "1d" })))).toBe(false);
    expect(plainLink(linkChoicesOf(ROLES, draft({ maxUses: 5 })))).toBe(false);
    // Editar link's "Até 13 de dez." reads as the 30 days a new link would have.
    expect(linkChoicesOf(ROLES, draft({ expiresIn: null })).expiresIn).toBe("30d");
  });

  test("Editar link and Editar convite save only what changed", () => {
    const link = { roleIds: ["suporte"], channelIds: ["c-suporte"], agentIds: ["max"], maxUses: 10 };
    const same = { roleIds: ["suporte"], channelIds: ["c-suporte"], agentIds: ["max"] };
    expect(changedLists(link, same)).toEqual({});
    expect(linkChanges(link, same, { expiresIn: null, maxUses: 10 })).toEqual({});
    expect(linkChanges(link, { ...same, channelIds: [] }, { expiresIn: "7d", maxUses: null })).toEqual({
      channelIds: [],
      maxUses: null,
      expiresIn: "7d",
    });
    // A link that never ends, left at "Não expira", keeps its date.
    expect(linkChanges({ ...link, neverExpires: true }, same, { expiresIn: "never", maxUses: 10 })).toEqual({});
    // The picks compare in any order.
    expect(changedLists({ roleIds: ["a", "b"] }, { roleIds: ["b", "a"], channelIds: [], agentIds: [] })).toEqual({});
  });
});

describe("Convites' rows (ADR 0184)", () => {
  const link = (over: Partial<InviteLink> = {}): InviteLink => ({
    id: "l1",
    url: "https://agentes.example.com/invite/abc",
    expiresAt: later(6),
    createdAt: later(-1),
    createdBy: "Ana Souza",
    createdByUserId: "u-ana",
    waiting: 0,
    roleIds: [],
    channelIds: [],
    agentIds: [],
    maxUses: null,
    uses: 0,
    ...over,
  });

  test("a link's name is its cargos, Membro with none; its line, how full it is, when it ends and whose", async () => {
    const pt = await translator("pt-BR");
    expect(linkTitle(pt, ROLES, link())).toBe("Membro");
    expect(linkTitle(pt, ROLES, link({ roleIds: ["fin", "suporte"] }))).toBe("Suporte e Financeiro");
    expect(linkLine(pt, "pt-BR", link({ maxUses: 1 }), "u-me", NOW)).toBe(
      "0 de 1 pessoa · expira em 6 dias · de Ana Souza",
    );
    expect(linkLine(pt, "pt-BR", link({ maxUses: 10, uses: 10 }), "u-ana", NOW)).toBe(
      "10 de 10 pessoas · expira em 6 dias",
    );
    expect(linkLine(pt, "pt-BR", link({ uses: 4, neverExpires: true }), "u-ana", NOW)).toBe(
      "4 pessoas entraram · não expira",
    );
    expect(linkLine(pt, "pt-BR", link({ expiresAt: later(20 / 24) }), "u-ana", NOW)).toBe(
      "Ninguém entrou ainda · expira em 20 h",
    );
    // Full, or less than a day left: the row says it in amber.
    expect(linkFull(link({ maxUses: 10, uses: 10 }))).toBe(true);
    expect(linkNeedsAttention(link({ maxUses: 10, uses: 10 }), NOW)).toBe(true);
    expect(linkNeedsAttention(link({ expiresAt: later(20 / 24) }), NOW)).toBe(true);
    expect(linkNeedsAttention(link(), NOW)).toBe(false);
    const en = await translator("en");
    expect(linkLine(en, "en", link({ maxUses: 5, uses: 1 }), "u-me", NOW)).toBe(
      "1 of 5 people · expires in 6 days · by Ana Souza",
    );
  });

  test("Link mode shows the workspace's listed link at once: the newest plain one with its address", () => {
    const listed = [
      link({ id: "own", plain: false }),
      link({ id: "unshown", plain: true, url: null }),
      link({ id: "workspace", plain: true }),
      link({ id: "older", plain: true }),
    ];
    expect(listedPlainLink(listed, NOW)?.id).toBe("workspace");
    // A server without `plain` lists only the workspace's own.
    expect(listedPlainLink([link()], NOW)?.id).toBe("l1");
    expect(listedPlainLink([link({ plain: false })], NOW)).toBeUndefined();
    // Past its date since the list was read: renewing it would make a new address.
    expect(listedPlainLink([link({ plain: true, expiresAt: later(-0.01) })], NOW)).toBeUndefined();
    expect(listedPlainLink(undefined, NOW)).toBeUndefined();
  });

  test("a request says how it came and what its link gives; a suggestion who made it", async () => {
    const pt = await translator("pt-BR");
    const known = {
      roles: ROLES,
      channels: [
        { id: "c-suporte", name: "suporte" },
        { id: "c-urgente", name: "chamados-urgentes" },
      ],
      agents: AGENTS,
    };
    const via = {
      createdAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
      link: {
        id: "l1",
        createdBy: "Paula Reis",
        roleIds: ["suporte"],
        channelIds: ["c-suporte"],
        agentIds: ["max"],
        full: false,
      },
    } as Pick<JoinRequest, "createdAt" | "suggestedBy" | "link">;
    const gives = givesLine(pt, known, via.link ?? {});
    expect(gives).toEqual(["Suporte", "#suporte", "Max"]);
    expect(requestLine(pt, "pt-BR", via, gives, NOW)).toBe(
      "Pediu pelo link de Paula Reis há 3 h · Suporte · #suporte · Max",
    );
    const suggested = { createdAt: later(-1), suggestedBy: "Bruno" };
    expect(requestLine(pt, "pt-BR", suggested, [], NOW)).toBe("Bruno sugeriu ontem");
    // Many channels say two and how many more.
    expect(
      givesLine(
        pt,
        { ...known, channels: [...known.channels, { id: "c3", name: "vendas" }] },
        {
          channelIds: ["c-suporte", "c-urgente", "c3"],
        },
      ),
    ).toEqual(["#suporte, #chamados-urgentes e mais 1"]);
  });

  test("e-mail invitations: working and expired, the newest first", async () => {
    const pt = await translator("pt-BR");
    const open = {
      id: "i1",
      email: "marina@example.com",
      role: "member" as const,
      roleIds: ["suporte"],
      status: "pending" as const,
      expiresAt: later(5),
      createdAt: later(-2),
    };
    const gone = {
      ...open,
      id: "i2",
      email: "rafael@example.com",
      roleIds: [],
      status: "expired" as const,
      expiresAt: later(-6),
      createdAt: later(-13),
    };
    expect(invitationLine(pt, "pt-BR", open, ROLES, {}, NOW)).toBe("Suporte · expira em 5 dias");
    expect(invitationExpired(gone, NOW)).toBe(true);
    expect(invitationLine(pt, "pt-BR", gone, ROLES, {}, NOW)).toMatch(/^Membro · expirou em /);
    // Past its date, a list that still says pending is expired too.
    expect(invitationExpired({ ...open, expiresAt: later(-1) }, NOW)).toBe(true);
    expect(listedInvitations([gone, open]).map((i) => i.id)).toEqual(["i1", "i2"]);
  });

  test("Validade and Máximo de pessoas in words", async () => {
    const pt = await translator("pt-BR");
    expect(ttlWord(pt, "30m")).toBe("30 minutos");
    expect(ttlWord(pt, "never")).toBe("Não expira");
    expect(maxWord(pt, 1)).toBe("1 pessoa");
    expect(maxWord(pt, 25)).toBe("25 pessoas");
    expect(maxWord(pt, null)).toBe("Sem limite");
  });
});

describe("the choices pushed over a form", () => {
  test("Canais: the cargo's first, then the sectors, #general ticked and fixed; a cargo's private one on offer", async () => {
    const pt = await translator("pt-BR");
    const channels = [
      {
        id: "c-general",
        name: "general",
        visibility: "public" as const,
        isMember: true,
        groupId: null,
        position: 0,
      },
      {
        id: "c-suporte",
        name: "suporte",
        visibility: "private" as const,
        isMember: false,
        audienceRoleIds: ["suporte"],
        groupId: "k-time",
        position: 0,
      },
      {
        id: "c-vendas",
        name: "vendas",
        visibility: "public" as const,
        isMember: false,
        groupId: "k-time",
        position: 1,
      },
      { id: "c-dir", name: "diretoria", visibility: "private" as const, isMember: true, groupId: null, position: 1 },
      { id: "c-folha", name: "folha", visibility: "private" as const, isMember: false, groupId: null, position: 2 },
    ];
    const groups = channelPicks(pt, {
      channels,
      sectors: [{ id: "k-time", name: "Time" }],
      roles: ROLES,
      draft: draft({ roleIds: ["suporte"] }),
    });
    expect(groups.map((g) => [g.title, g.picks.map((p) => [p.channel.name, p.on, p.fixed, p.sub ?? ""])])).toEqual([
      ["Do cargo Suporte", [["suporte", true, false, "Pelo cargo Suporte"]]],
      [
        null,
        [
          ["general", true, true, "Todo mundo entra no #general."],
          ["diretoria", false, false, "Privado · você está nele"],
        ],
      ],
      ["Time", [["vendas", false, false, ""]]],
    ]);
    // Without the cargo, its private channel isn't on offer (the viewer isn't in it).
    const none = channelPicks(pt, { channels, sectors: [], roles: ROLES, draft: draft() });
    expect(none.flatMap((g) => g.picks.map((p) => p.channel.name))).not.toContain("suporte");
    // A search keeps what it names, with its "#" or not, accents aside; a group left without any goes.
    const found = (query: string) =>
      channelPicks(pt, {
        channels,
        sectors: [{ id: "k-time", name: "Time" }],
        roles: ROLES,
        draft: draft({ roleIds: ["suporte"] }),
        query,
      }).map((g) => [g.title, g.picks.map((p) => p.channel.name)]);
    expect(found("#vend")).toEqual([["Time", ["vendas"]]]);
    expect(found("SUP")).toEqual([["Do cargo Suporte", ["suporte"]]]);
    expect(found("diretória")).toEqual([[null, ["diretoria"]]]);
    expect(found("folha")).toEqual([]);
  });

  test("Agentes: every case the server decides, with its reason, and only the pickable ones tickable", async () => {
    const pt = await translator("pt-BR");
    const args: Parameters<typeof agentPicks>[1] = {
      agents: AGENTS.filter((a) => a.builtin !== "right_hand"),
      viewer: VIEWER,
      roles: ROLES,
      draft: draft({ roleIds: ["suporte"] }),
      ownerName: (id) => (id === "u-bruno" ? "Bruno" : id === "u-me" ? "Você" : null),
      mailboxOwners: (id) => (id === "nora" ? ["Bruno"] : id === "fin" ? [] : []),
    };
    const picks = agentPicks(pt, args);
    // A search keeps the ones it names, by name or função, in their groups.
    const found = (query: string) => {
      const p = agentPicks(pt, { ...args, query });
      return [p.fromCargo.map((x) => x.agent.name), p.others.map((x) => x.agent.name)];
    };
    expect(found("DEV")).toEqual([[], ["Ada"]]);
    expect(found("max")).toEqual([["Max"], []]);
    expect(found("ninguém")).toEqual([[], []]);
    const said = (list: typeof picks.others) =>
      list.map((p) => [p.agent.name, p.case, p.sub, p.on, p.disabled, p.opens ?? ""]);
    expect(said(picks.fromCargo)).toEqual([["Max", "cargo", "Pelo cargo Suporte", true, false, ""]]);
    expect(said(picks.others)).toEqual([
      ["Ada", "everyone", "Dev", false, false, ""],
      ["Fin", "opens", "Restrito · você libera", false, false, ""],
      ["Nora", "mailbox", "Lê o e-mail de Bruno", false, false, "agent"],
      ["Rex", "locked", "Restrito · só Bruno libera", false, true, ""],
    ]);
    // Someone else's agent the viewer manages (its `canManage`) opens as their own does.
    const managed = agentPicks(pt, { ...args, agents: [{ ...(AGENTS[4] as Agent), canManage: true }] });
    expect(said(managed.others)).toEqual([["Rex", "opens", "Restrito · você libera", false, false, ""]]);
    // While its mailboxes are being asked, one the viewer would open waits.
    const asking = agentPicks(pt, {
      agents: [AGENTS[3] as Agent],
      viewer: VIEWER,
      roles: ROLES,
      draft: draft(),
      ownerName: () => null,
      mailboxOwners: () => undefined,
    });
    expect(asking.others[0]?.disabled).toBe(true);
    // One already in the form can always come out, whatever its case now.
    const kept = agentPicks(pt, {
      agents: [AGENTS[4] as Agent],
      viewer: VIEWER,
      roles: ROLES,
      draft: draft({ added: { channelIds: [], agentIds: ["rex"] } }),
      ownerName: () => "Bruno",
      mailboxOwners: () => [],
    });
    expect([kept.others[0]?.on, kept.others[0]?.disabled]).toEqual([true, false]);
    // The viewer's own agent that keeps its plan for them says so as the web does, and opens its plan's choice.
    const mine = agentPicks(pt, {
      ...args,
      agents: [
        agent({
          id: "lia",
          name: "Lia",
          ownerUserId: "u-me",
          audienceMode: "owner",
          audience: { mode: "owner", userIds: [], roleIds: [] },
          brain: { kind: "claude_code", account: "Claude Max" } as Agent["brain"],
        }),
      ],
    });
    expect(said(mine.others)).toEqual([["Lia", "plan", "Só atende você", false, false, "plan"]]);
  });

  test("Cargo: one the form gives that you can't give shows checked and marked, to take out and never to tick again", async () => {
    const pt = await translator("pt-BR");
    const roles = ROLES.map((r) => (r.id === "fin" ? { ...r, givable: false } : r));
    const rows = (roleIds: string[], held: string[]) =>
      cargoPicks(pt, roles, roleIds, false, held).map((p) => [p.label, p.on, p.sub ?? "", p.disabled ?? false]);
    // Financeiro is the link's, above the editor; the others are theirs to give.
    expect(rows(["fin", "suporte"], ["fin", "suporte"])).toEqual([
      ["Membro", false, "", false],
      ["Admin", false, "", false],
      ["Suporte", true, "", false],
      ["Financeiro", true, "Acima do seu cargo", false],
    ]);
    // Taken out, it keeps its place until the choice closes, and can't come back.
    expect(rows(["suporte"], ["fin", "suporte"]).at(-1)).toEqual(["Financeiro", false, "Acima do seu cargo", true]);
    // One the form never gave isn't offered.
    expect(rows([], []).map(([label]) => label)).toEqual(["Membro", "Admin", "Suporte"]);
    const picks = src("features/members/InvitePickers.tsx");
    expect(picks).toContain("const [held] = useState(draft.roleIds);");
    expect(picks).toContain("cargoPicks(t, roles, draft.roleIds, personal, held)");
    expect(picks).toMatch(/sub=\{p\.sub\}\s*checked=\{p\.on\}\s*disabled=\{p\.disabled\}/);
  });

  test("the lines under Agentes: no talking, an Administrador, restricted agents that start answering", async () => {
    const pt = await translator("pt-BR");
    const noTalk = [{ ...EVERYONE, permissions: [] }, SUPORTE];
    expect(
      agentLines(pt, { roles: noTalk, roleIds: ["suporte"], agents: AGENTS, agentIds: [], viewer: VIEWER }),
    ).toEqual({ off: true, lines: ["Com esse cargo, a pessoa não conversa com agentes."] });
    expect(
      agentLines(pt, { roles: ROLES, roleIds: ["admin"], agents: AGENTS, agentIds: ["fin"], viewer: VIEWER }).lines,
    ).toEqual(["Com Admin, a pessoa vê todos os agentes.", "Fin passa a responder a quem entrar por este convite."]);
    expect(agentLines(pt, { roles: ROLES, roleIds: [], agents: AGENTS, agentIds: ["ada"], viewer: VIEWER })).toEqual({
      off: false,
      lines: [],
    });
    // While the cargos load (no Todos yet) nothing is said, never a wrong "doesn't talk to agents".
    expect(agentLines(pt, { roles: [], roleIds: [], agents: AGENTS, agentIds: [], viewer: VIEWER })).toEqual({
      off: false,
      lines: [],
    });
  });

  test("Cargo, Canais and Agentes search past eight rows, as the cargo's own lists; a miss says so and clears", () => {
    const picks = src("features/members/InvitePickers.tsx");
    for (const key of ["rolesPage.search", "rolesPage.channels.search", "rolesPage.agents.search"])
      expect(picks).toContain(`<PickSearch value={query} onChange={setQuery} label={t("${key}")} />`);
    expect(picks.match(/> ROLES_SEARCH_FROM \? \(/g)?.length).toBe(3);
    for (const key of ["rolesPage.noMatch", "rolesPage.channels.noMatch", "rolesPage.agents.noMatch"])
      expect(picks).toContain(`<NoMatch text={t("${key}", { q: query.trim() })} clear={() => setQuery("")} />`);
    expect(picks).toContain('<GroupedRow icon="x" label={t("filters.clearSearch")} onPress={clear} />');
    // Canais and Agentes filter where their groups are made; the right hand goes too when the search misses it.
    expect(picks).toContain("channelPicks(t, { channels, sectors, roles, draft, query })");
    expect(picks).toMatch(/mailboxOwners,\s*query,\s*\}\);/);
    expect(picks).toContain("const rightShown = right && agentMatches(right, query) ? right : undefined;");
  });

  test("each choice is a pushed screen writing to the form its route names", () => {
    const fields = src("features/members/InviteFields.tsx");
    expect(fields).toContain('router.push({ pathname: "/invite-pick", params: { draft, what } })');
    const picks = src("features/members/InvitePickers.tsx");
    expect(picks).toContain("const draft = useInviteDraft(key);");
    // Validade and Máximo go back on their pick; Máximo never offers fewer than the link took.
    expect(picks).toContain("INVITE_LINK_MAX_USES.filter((max) => max === null || max >= uses)");
    expect(route("invite-pick.tsx")).toContain("<InvitePickScreen />");
    for (const name of ["invite-pick", "invite-link", "invite-edit", "settings/invites"])
      expect({ name, pushed: pushedByDefault(name) }).toEqual({ name, pushed: true });
  });
});

describe("Convidar pessoas on the phone", () => {
  const invite = src("features/members/InvitePeople.tsx");

  test("E-mail or Link on top, full width; a server that sends no e-mail has links only", () => {
    expect(invite).toContain("{byLink ? null : (");
    expect(invite).toMatch(/<Segmented\s+wide\s+items=\{\[/);
    expect(invite).toContain('{ key: "email", label: t("invites.byEmail"), icon: "mail" }');
  });

  test("each label over its field, the field at the row's whole width, as the app's forms", () => {
    expect(invite).toMatch(/<GroupedField\s+key="to"\s+stacked/);
    const fields = src("features/members/InviteFields.tsx");
    expect(fields.match(/<GroupedField\s+key="\w+"\s+stacked/g)?.length).toBe(3);
    const kit = src("ui/Grouped.tsx");
    // The label's line, then the value under it at the row's width, 4 apart.
    expect(kit).toContain("<View style={styles.stackValue} pointerEvents={passive}>");
    expect(kit).toContain("stackValue: { marginTop: 4 },");
  });

  test("it sends every good address with the cargos, channels and agents; while it sends nothing goes back", () => {
    expect(invite).toContain("emails: ready.map((a) => a.email),");
    expect(invite).toMatch(/usePreventRemove\(sending, \(\{ repeat \}\) => \{\s*if \(leaving\.current\) repeat\(\);/);
    // A finished send goes back itself, past the hold the screen hasn't let go of yet (the question under the form
    // too, in a personal workspace).
    expect(invite).toMatch(
      /leaving\.current = true;[\s\S]*?if \(family && router\.canDismiss\(\)\) router\.dismiss\(2\);\s*else goBack\(\);/,
    );
    // A refused pick marks its token and says why, the form kept as it was.
    expect(invite).toContain('if (!refusedBy(e)) toast({ title: errorText(t, e, i18n.language), icon: "x" });');
    expect(invite).toContain('playSound("approved");');
  });

  test("Link mode: the workspace's link renewed as the mode opens, any other choice makes its own", () => {
    expect(invite).toMatch(/renew\s*\.mutateAsync\(INVITE_LINK_DEFAULTS\)\s*\.then\(setWorkspace,/);
    expect(invite).toContain("const link = await make.mutateAsync(choices);");
    expect(invite).toContain('label={t("members.link.make")}');
  });

  test("Link mode never moves as it opens: the listed address at once, else its three lines and the date's line held", () => {
    // The list is read while E-mail shows; renewing keeps the address, only "Vale até" changes.
    expect(invite).toContain("const links = useInviteLinks(orgId).data;");
    expect(invite).toContain("listed={listedPlainLink(links)}");
    expect(invite).toContain("(plain ? (workspace ?? (renew.isError ? null : (listed ?? null))) : null)");
    // From the first frame, before the renewal starts.
    expect(invite).toContain("const renewing = plain && !shown && (renew.isIdle || renew.isPending);");
    expect(invite).toContain('const ADDRESS_PENDING = "…\\n\\u00a0\\n\\u00a0";');
    // A long host wraps the address whole, never cut, here and on Editar link.
    expect(invite).toContain("label={shown?.url ?? ADDRESS_PENDING} labelLines={0}");
    expect(src("features/members/InviteEdit.tsx")).toContain('<GroupedRow icon="link" label={url} labelLines={0} />');
    // Never "Crie o link para copiar." while no Criar link row is there.
    expect(invite).toMatch(/: renewing\s*\? "\\u00a0"\s*: t\("invites\.linkEmpty"\)/);
    // Opening renews the workspace's link to 30 days: only the defaults renew it, an empty body returns it as it is.
    expect(invite).toContain("renew.mutateAsync(INVITE_LINK_DEFAULTS)");
    expect(invite).not.toContain("renew.mutateAsync()");
    // A refused renewal hides the listed link and says why, as the web does.
    expect(invite).not.toContain("if (!known) toast(");
    // The listed link may have been revoked since it was read: Copiar and Compartilhar wait for the renewal.
    expect(invite).toContain("const unconfirmed = !shown || shown === listed;");
    expect(invite.match(/disabled=\{unconfirmed\}/g)?.length).toBe(2);
  });
});

describe("the kit's token (a 32 pt pill with a 44 pt ×)", () => {
  const token = src("ui/Token.tsx");

  test("its numbers", () => {
    expect(token).toContain("export const TOKEN_H = 32;");
    expect(token).toContain("const X_BOX = 24;");
    // The × grows to a finger's 44.
    expect(token).toContain("hitSlop={(TOUCH - X_BOX) / 2}");
  });

  test("a long address is cut in its middle and keeps its note and its ×; lines past the limit leave and say how many", () => {
    expect(token).toMatch(/<RNText\s+numberOfLines=\{1\}\s+ellipsizeMode="middle"[^>]*style=\{\[TEXT, styles\.label/);
    expect(token).toContain(
      "const out = limit === null ? 0 : items.filter((it) => (tops[String(it.key)] ?? 0) >= limit).length;",
    );
    expect(src("features/members/InviteFields.tsx").match(/<TokenWrap lines=\{2\} more=\{more\}>/g)?.length).toBe(2);
  });
});

describe("Configurações › Pessoas: Membros · Convites · Cargos", () => {
  test("Convites sits between Membros and Cargos, for whoever invites, with the requests waiting as its value", async () => {
    const people = SETTINGS_SECTIONS.filter((s) => s.group === "people").map((s) => s.id);
    expect(people).toEqual(["members", "invites", "roles"]);
    const invites = SETTINGS_SECTIONS.find((s) => s.id === "invites");
    expect(invites?.allowed({ id: "o", name: "Acme", role: "member", permissions: ["read"] })).toBe(false);
    expect(invites?.allowed({ id: "o", name: "Acme", role: "member", permissions: ["invite_people"] })).toBe(true);
    const pt = await translator("pt-BR");
    expect(areaValues(pt, "pt-BR", { waiting: 2 }).invites).toBe("2");
    expect(areaValues(pt, "pt-BR", { waiting: 0 }).invites).toBeUndefined();
  });

  test("Membros keeps people; who waits and what was sent are Convites'", () => {
    const members = src("features/members/MembersPage.tsx");
    expect(members).not.toContain("WaitingYou");
    expect(members).not.toContain("SentInvitations");
    const convites = src("features/members/InvitesScreen.tsx");
    expect(convites).toContain('router.push({ pathname: "/join-requests", params: { request: r.id } })');
    // The bar's "+" is the system's own button (`SettingsPage` `actions`).
    expect(convites).toMatch(
      /actions=\{\[\{ icon: "plus", sf: "plus", label: t\("members\.inviteTitle"\), onPress: invite \}\]\}/,
    );
    // An e-mail invitation's sheet: Editar in place of Mudar o papel; expired, Renovar and Tirar.
    const sheets = src("features/members/InviteSheets.tsx");
    expect(sheets).toContain('label: t("invites.edit"),');
    expect(sheets).not.toContain("changeRole");
    expect(sheets).toContain('label: t("members.invitations.drop"),');
  });

  test("a request's review starts on its link's choices, and a full link waits for a bigger maximum", () => {
    const sheet = src("features/members/JoinRequestsScreen.tsx");
    expect(sheet).toContain("const { given, leftOut } = approvalCargos(roles, r.link?.roleIds ?? []);");
    expect(sheet).toContain("disabled={busy || waitsForRoom(r, full) || linkFull || !draft}");
    expect(sheet).toContain('t("errors.join.linkFullApproval")');
    // A link's cargo the approver can't give stays out, and the card says which, as the web's row.
    expect(sheet).toContain(
      '<Note icon="lock">{t("invites.roleLeftOut", { count: leftOut.length, roles: joinNames(leftOut, t) })}</Note>',
    );
  });
});

describe("the arrival card (#general for a newcomer's first day)", () => {
  test("the invitation's agents first, a few people, the first agent to talk to, the channels besides #general", () => {
    const arrival = arrivalOf({
      agents: [
        { id: "ada", canTalk: true },
        { id: "max", canTalk: true },
        { id: "rex", canTalk: false },
        { id: "theo", canTalk: true },
        { id: "lia", canTalk: true },
      ],
      pinned: ["max", "rex"],
      people: [{ userId: "u-me" }, { userId: "u-carla" }, { userId: "u-diego" }, { userId: "u-eva" }],
      meId: "u-me",
      channels: [
        { name: "general", isMember: true },
        { name: "suporte", isMember: true },
        { name: "vendas", isMember: false },
        { name: "chamados-urgentes", isMember: true },
      ],
    });
    expect(arrival).toEqual({
      agents: ["max", "ada", "theo"],
      people: ["u-carla", "u-diego"],
      host: "max",
      alsoIn: ["#suporte", "#chamados-urgentes"],
    });
    const card = src("features/chat/ChannelWelcome.tsx");
    expect(card).toContain('t("members.arrival.alsoIn", { channels: namesText(t, arrival.alsoIn, 3) })');
    // Three buttons as wide as the card: say hi here, talk to the first agent, meet the team.
    expect(card.match(/variant="(primary|ghost)"\s+wide/g)?.length).toBe(3);
    expect(card).toContain('requestComposerText(channelId, "");');
  });

  test("the Agentes tab shows the pinned agents first, the invitation's included", () => {
    const screen = src("features/agents/AgentsScreen.tsx");
    expect(screen).toContain("freeSections(free, groups, pinned)");
    expect(screen).toContain("pinned={pins.pins.agents}");
  });
});

describe("the worst case (break-ui): long names, one of each, a thousand of them", () => {
  // The server's limits: a cargo's name 40 letters, a channel's 80, an agent's 32, an address 320 (64 is the classic).
  const LONG_CARGO = role({ id: "long", name: "Desenvolvimento de Produto e Engenharia!", position: 4 });
  const VIET = role({ id: "viet", name: "Đặng Thị Ngọc Hân", position: 5 });
  const LONG_EMAIL = "bartholomew.fitzgerald@northwind-industries-holdings.example.com";

  test("exactly one of everything is said in the singular, a thousand with its separator", async () => {
    const pt = await translator("pt-BR");
    const one = { uses: 1, maxUses: 1, expiresAt: later(1 / 48), createdBy: null, createdByUserId: null };
    expect(linkLine(pt, "pt-BR", one, "u-me", NOW)).toBe("1 de 1 pessoa · expira em 30 min");
    expect(linkLine(pt, "pt-BR", { ...one, maxUses: null }, "u-me", NOW)).toBe("1 pessoa entrou · expira em 30 min");
    expect(maxWord(pt, 1)).toBe("1 pessoa");
    expect(areaValues(pt, "pt-BR", { waiting: 1284 }).invites).toBe("1.284");
    const convites = src("features/members/InvitesScreen.tsx");
    expect(convites).toContain("formatInt(i18n.language, waiting.length)");
    expect(convites).toContain("formatInt(i18n.language, sent.length)");
  });

  test("long cargo, channel and agent names: a link's name and a request's line wrap whole, never cut", async () => {
    const pt = await translator("pt-BR");
    const roles = [...ROLES, LONG_CARGO, VIET];
    // Every cargo is named on the link's row; it wraps as far as it needs.
    expect(linkTitle(pt, roles, { roleIds: ["long", "viet", "fin"] })).toBe(
      "Financeiro, Desenvolvimento de Produto e Engenharia! e Đặng Thị Ngọc Hân",
    );
    // What a link gives names two of each and counts the rest, so its line stays short.
    const channels = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      name: `atendimento-ao-cliente-regiao-${i}`,
    }));
    const gives = givesLine(
      pt,
      { roles, channels, agents: AGENTS },
      {
        roleIds: ["long", "viet", "fin"],
        channelIds: channels.map((c) => c.id),
        agentIds: ["max", "ada", "fin", "rex"],
      },
    );
    expect(gives).toEqual([
      "Financeiro, Desenvolvimento de Produto e Engenharia! e mais 1",
      "#atendimento-ao-cliente-regiao-0, #atendimento-ao-cliente-regiao-1 e mais 10",
      "Max, Ada e mais 2",
    ]);
    const convites = src("features/members/InvitesScreen.tsx");
    expect(convites).toMatch(/label=\{linkTitle\(t, roles, link\)\}\s*labelLines=\{0\}/);
    // How it came, then what it gives on a line of its own, neither cut.
    expect(convites).toMatch(/sub=\{requestLine\(t, i18n\.language, r, \[\]\)\}\s*subLines=\{0\}/);
    expect(convites).toContain('belowText: gives.join(" · ")');
    // A channel's 80 letters wrap in Canais.
    expect(src("features/members/InvitePickers.tsx")).toMatch(/label=\{p\.channel\.name\}\s*labelLines=\{0\}/);
  });

  test("the classic long address: three lines on Convites, whole on Editar convite, cut only inside its token", async () => {
    const pt = await translator("pt-BR");
    expect(LONG_EMAIL.length).toBe(64);
    const convites = src("features/members/InvitesScreen.tsx");
    expect(convites).toMatch(/label=\{inv\.email\}\s*labelLines=\{3\}/);
    expect(src("features/members/InviteEdit.tsx")).toContain('t("members.invitations.label", { email: inv.email })');
    expect(pt("members.invitations.label", { email: LONG_EMAIL })).toBe(`Convite para ${LONG_EMAIL}`);
    // In its token the address is cut in its middle (its name and its domain stay), its note and its × whole.
    const token = src("ui/Token.tsx");
    expect(token).toContain('ellipsizeMode="middle"');
    expect(token).toMatch(/\{note \? \(\s*<RNText numberOfLines=\{1\}/);
    expect(token).toContain("label: { flexShrink: 1, minWidth: 0 },");
  });

  test("empty and loading: Convites' rows of the final shape, then the empty line with its two ways in", () => {
    const convites = src("features/members/InvitesScreen.tsx");
    expect(convites).toContain("<RowBones />");
    expect(convites).toContain('<GroupedFooter>{t("members.invitations.empty")}</GroupedFooter>');
    expect(convites).toContain('label={t("members.copyInviteLink")}');
    // A request's card waits for the cargos, so it opens on its link's choices.
    expect(src("features/members/JoinRequestsScreen.tsx")).toContain("else if (!list.data || !roles.data)");
    // Convidar opens on its cargo in the first frame.
    expect(src("features/members/InvitePeople.tsx")).toContain("const draft = useInviteDraft(KEY) ?? opening;");
  });
});
