import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Channel, OrgRole, OrgRoles, Person } from "@agenteschat/client";
import { audiencePatch } from "@agenteschat/client/lib/audience";
import { COMPUTERS_ROW, giveRole, newRoleInput, roleLock } from "@agenteschat/client/lib/roles";
import { memberActions, withAddresses } from "../../src/features/members/logic";
import {
  ADVANCED,
  agentAudienceLine,
  agentIntent,
  agentLosingLine,
  agentTicked,
  agentWhoPatch,
  audienceValid,
  channelAudienceLine,
  channelGroups,
  channelIntent,
  channelTicked,
  copiesWhole,
  copyableRoles,
  givableRoles,
  glanceLine,
  heldStep,
  listedAgents,
  mailLossQuestion,
  moveRole,
  orderChanged,
  orderSteps,
  peopleNames,
  permissionGroups,
  reachLine,
  rowIntent,
  stepIntent,
  tabValues,
  talkGate,
  whoCanChanged,
  whoCanHolders,
  whoCanLines,
  whoCanStart,
  whoSeesInput,
  whoSeesLines,
  whoSeesStart,
} from "../../src/features/roles/logic";
import { SETTINGS_SECTIONS, visibleSections } from "../../src/features/settings/logic";
import { ICON_NAMES } from "../../src/ui/icons.data";
import { GROUPED_ROW, TOUCH } from "../../src/ui/rhythm";
import { ditherPaths, roleMarkFit, roleMarkIcon } from "../../src/ui/role-mark";
import { agent, translator } from "./fixtures";

const APP = join(import.meta.dir, "..", "..", "app", "(app)");
const SRC = join(import.meta.dir, "..", "..", "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

/** The server's areas (`PERMISSION_AREAS` in packages/engine/src/permissions.ts), as `GET …/roles` sends them. */
const AREAS: OrgRoles["areas"] = [
  {
    id: "chat",
    use: ["post", "create_channels"],
    keys: ["post", "create_channels", "mention_everyone", "manage_channels"],
  },
  {
    id: "agents",
    use: ["talk_to_agents", "assign_work", "manage_routines"],
    keys: ["talk_to_agents", "assign_work", "manage_routines", "approve_actions", "create_agents", "manage_agents"],
  },
  {
    id: "tools",
    use: ["pair_computers"],
    keys: [
      "pair_computers",
      "own_browsers",
      "own_computers",
      "control_browsers",
      "control_computers",
      "manage_connectors",
      "manage_credentials",
    ],
  },
  { id: "knowledge", use: ["edit_wiki", "upload_files"], keys: ["edit_wiki", "upload_files", "review_memory"] },
  {
    id: "org",
    use: ["invite_people"],
    keys: [
      "invite_people",
      "view_usage",
      "view_audit",
      "configure",
      "manage_members",
      "manage_roles",
      "manage_billing",
    ],
  },
];
/** A new workspace's Todos (`EVERYONE_DEFAULTS`). */
const DEFAULTS = [
  "post",
  "create_channels",
  "talk_to_agents",
  "assign_work",
  "pair_computers",
  "own_computers",
  "edit_wiki",
  "upload_files",
];

const role = (over: Partial<OrgRole> & { id: string }): OrgRole => ({
  kind: "custom",
  name: over.id,
  icon: "shield",
  color: "teal",
  position: 1,
  permissions: [],
  mentionable: false,
  hoist: false,
  people: 0,
  editable: true,
  givable: true,
  ...over,
});
const everyone = role({
  id: "all",
  kind: "everyone",
  name: "everyone",
  icon: "audienceEveryone",
  color: "graphite",
  position: 99,
  permissions: DEFAULTS,
  channelIds: ["general", "clientes", "produto", "vendas"],
  agentIds: ["ada", "theo", "lia"],
});
const admin = role({ id: "admin", name: "Admin", color: "indigo", position: 0, permissions: ["administrator"] });
const suporte = role({
  id: "suporte",
  name: "Suporte",
  icon: "message",
  position: 1,
  permissions: ["manage_routines", "approve_actions", "invite_people"],
  channelIds: ["suporte", "urgentes"],
  agentIds: ["max"],
});
const fin = role({
  id: "fin",
  name: "Financeiro",
  icon: "wallet",
  color: "amber",
  position: 2,
  permissions: ["view_usage", "view_audit"],
  channelIds: ["financeiro"],
  agentIds: ["fin"],
});
const roles = [admin, suporte, fin, everyone];
const data: OrgRoles = { roles, areas: AREAS, colors: ["teal", "amber"], icons: ["shield", "message", "wallet"] };
const person = (userId: string, over: Partial<Person> = {}) =>
  ({ userId, name: userId, email: `${userId}@example.com`, role: "member", roleIds: [], ...over }) as Person;
const owner = { role: "owner", userId: "me" } as const;

describe("Cargos on the phone: where they live (P1, plan §1.4)", () => {
  test("in Configurações › Workspace › Pessoas for who manages roles, each screen in the stack", () => {
    const org = (permissions: string[]) => ({ id: "o", name: "Acme", role: "member" as const, permissions });
    expect(visibleSections(org(["read", "manage_roles"])).map((s) => s.id)).toContain("roles");
    expect(visibleSections(org(["read", "manage_members"])).map((s) => s.id)).not.toContain("roles");
    expect(SETTINGS_SECTIONS.find((s) => s.id === "roles")?.href).toBe("/settings/roles");
    const layout = readFileSync(join(APP, "_layout.tsx"), "utf8");
    const pages = ["index", "[roleId]", "permissions", "who", "channels", "channel", "agents", "agent"];
    for (const page of [...pages, "people", "add", "look", "rename", "new", "person"]) {
      expect(existsSync(join(APP, "settings", "roles", `${page}.tsx`))).toBe(true);
      expect(layout).toContain(`name="settings/roles/${page}"`);
    }
    // The levels' screen and the "on the computer" line went with the old page.
    expect(existsSync(join(APP, "settings", "roles", "area.tsx"))).toBe(false);
    expect(existsSync(join(SRC, "features", "settings", "RolesScreen.tsx"))).toBe(false);
  });

  test("who changes a cargo: the server's flags, said the web's way", () => {
    const manager = { role: "member", rank: 1, permissions: ["manage_roles", "manage_members"] };
    expect(roleLock(manager, suporte)).toBeNull();
    expect(roleLock(manager, { ...suporte, editable: false })).toBe("own");
    expect(roleLock(manager, { ...suporte, editable: false, position: 0 })).toBe("above");
    expect(roleLock({ role: "member", permissions: [] }, { ...suporte, editable: false })).toBe("noPermission");
  });
});

describe("What a cargo adds (P2, P3)", () => {
  test("its reach line, Todos' without the +, Administrador in words", async () => {
    const t = await translator("pt-BR");
    expect(reachLine(t, suporte, everyone, AREAS)).toBe("+3 permissões · +2 canais · +1 agente");
    expect(reachLine(t, fin, everyone, AREAS)).toBe("+2 permissões · +1 canal · +1 agente");
    expect(reachLine(t, everyone, everyone, AREAS)).toBe("8 permissões · 4 canais · 3 agentes");
    expect(reachLine(t, admin, everyone, AREAS)).toBe("Pode tudo");
    // What Todos already gives adds nothing.
    expect(reachLine(t, role({ id: "x", permissions: ["post"] }), everyone, AREAS)).toBe("Só o que Todos podem");
    expect(reachLine(t, { ...everyone, permissions: [], channelIds: [], agentIds: [] }, undefined, AREAS)).toBe(
      "Só ler",
    );
    // Channels the viewer doesn't see count, never named.
    expect(reachLine(t, { ...fin, hiddenChannels: 2 }, everyone, AREAS)).toBe("+2 permissões · +3 canais · +1 agente");
    const en = await translator("en");
    expect(reachLine(en, suporte, everyone, AREAS)).toBe("+3 permissions · +2 channels · +1 agent");
  });

  test("the glance under its name starts with its people; the tabs' values are the reach's numbers", async () => {
    const t = await translator("pt-BR");
    expect(glanceLine(t, suporte, everyone, AREAS, 3)).toBe("3 pessoas · +3 permissões · +2 canais · +1 agente");
    expect(glanceLine(t, suporte, everyone, AREAS, 0)).toBe("Ninguém · +3 permissões · +2 canais · +1 agente");
    expect(tabValues(t, suporte, everyone, AREAS)).toEqual({ permissions: "+3", channels: "+2", agents: "+1" });
    expect(tabValues(t, everyone, everyone, AREAS)).toEqual({ permissions: "8", channels: "4", agents: "3" });
    expect(tabValues(t, role({ id: "x" }), everyone, AREAS)).toEqual({ permissions: "", channels: "", agents: "" });
    expect(tabValues(t, admin, everyone, AREAS).permissions).toBe("Pode tudo");
  });
});

describe("Permissões (P4): the Todos trap is gone", () => {
  test("one flat list in the web's groups, the computers in their place, Administrador last under Avançado", async () => {
    const t = await translator("pt-BR");
    const groups = permissionGroups(t, suporte, data, owner);
    expect(groups.map((g) => g.title)).toEqual([
      "Conversas",
      "Agentes",
      "Apps e computadores",
      "Wiki e arquivos",
      "Workspace",
      "Avançado",
    ]);
    expect(groups[2]?.rows.map((r) => r.row)).toEqual([
      "pair_computers",
      COMPUTERS_ROW,
      "manage_connectors",
      "manage_credentials",
    ]);
    expect(groups.at(-1)?.rows.map((r) => r.row)).toEqual(["administrator"]);
    // A row everyone has reads "Todos podem" on the cargo, on and live; the cargo's own reads on.
    const chat = groups[0]?.rows ?? [];
    expect(chat.find((r) => r.row === "create_channels")).toMatchObject({ level: 1, own: 0, fromEveryone: true });
    expect(groups[1]?.rows.find((r) => r.row === "manage_routines")).toMatchObject({ level: 1, fromEveryone: false });
    expect(chat.find((r) => r.row === "manage_channels")).toMatchObject({ level: 0, fromEveryone: false });
  });

  test("Todos has no Administrador; a row only some cargos give names them", async () => {
    const t = await translator("pt-BR");
    const groups = permissionGroups(t, everyone, data, owner);
    expect(groups.map((g) => g.id)).not.toContain(ADVANCED);
    const routines = groups[1]?.rows.find((r) => r.row === "manage_routines");
    expect(routines?.holders.map((r) => r.name)).toEqual(["Admin", "Suporte"]);
    expect(groups[0]?.rows.find((r) => r.row === "post")?.fromEveryone).toBe(false);
  });

  test("an Administrador cargo shows only Avançado; search finds a title, an ⓘ's words or a group, accents aside", async () => {
    const t = await translator("pt-BR");
    expect(permissionGroups(t, admin, data, owner).map((g) => g.id)).toEqual([ADVANCED]);
    const titles = (q: string) =>
      permissionGroups(t, suporte, data, owner, q).flatMap((g) => g.rows.map((r) => r.title));
    expect(titles("criar canais")).toEqual(["Criar canais"]);
    expect(titles("faturas")).toEqual(["Plano e cobrança"]);
    expect(titles("conversas")).toEqual(["Mandar mensagens", "Criar canais", "Mencionar todos", "Organizar canais"]);
    expect(titles("reagir")).toEqual(["Mandar mensagens"]);
    expect(titles("cobranca")).toEqual(["Plano e cobrança"]);
    expect(titles("nada disso")).toEqual([]);
  });

  test("a key the viewer doesn't hold can't be given: its switch is off", async () => {
    const t = await translator("pt-BR");
    const manager = { role: "member", userId: "u", permissions: ["manage_roles", "post", "own_browsers"] };
    const rows = permissionGroups(t, suporte, data, manager).flatMap((g) => g.rows);
    expect(rows.find((r) => r.row === "post")?.held).toBe(true);
    expect(rows.find((r) => r.row === "manage_billing")?.held).toBe(false);
    expect(rows.find((r) => r.row === "administrator")?.held).toBe(false);
    expect(heldStep(manager)).toBe(1);
    expect(heldStep(owner)).toBe(4);
  });

  test("a switch saves the cargo's own keys; off on what everyone has asks Quem pode; Administrador asks first", () => {
    expect(rowIntent(suporte, everyone, "manage_channels", true)).toEqual({
      kind: "save",
      permissions: [...suporte.permissions, "manage_channels"],
    });
    expect(rowIntent(suporte, everyone, "invite_people", false)).toEqual({
      kind: "save",
      permissions: ["manage_routines", "approve_actions"],
    });
    expect(rowIntent(suporte, everyone, "create_channels", false)).toEqual({ kind: "who" });
    expect(rowIntent(everyone, everyone, "post", false)).toEqual({ kind: "who" });
    expect(rowIntent(everyone, everyone, "manage_channels", true)).toEqual({
      kind: "save",
      permissions: [...DEFAULTS, "manage_channels"],
    });
    expect(rowIntent(suporte, everyone, "administrator", true)).toEqual({ kind: "admin" });
    expect(rowIntent({ ...suporte, permissions: ["administrator", "post"] }, everyone, "administrator", false)).toEqual(
      {
        kind: "save",
        permissions: ["post"],
      },
    );
  });

  test("the computers' steps: at or above Todos' saves, below it asks who keeps Todos' step", () => {
    // Todos is at step 2 (its people's own agents' computer).
    expect(stepIntent(suporte, everyone, 4)).toEqual({
      kind: "save",
      permissions: [...suporte.permissions, "control_computers"],
    });
    expect(stepIntent({ ...suporte, permissions: ["control_browsers"] }, everyone, 2)).toEqual({
      kind: "save",
      permissions: [],
    });
    expect(stepIntent(suporte, everyone, 1)).toEqual({ kind: "who" });
    expect(stepIntent(everyone, everyone, 3)).toEqual({
      kind: "save",
      permissions: [...DEFAULTS.filter((k) => k !== "own_computers"), "control_browsers"],
    });
    expect(stepIntent(everyone, everyone, 0)).toEqual({ kind: "who" });
  });
});

describe("Quem pode (P5): Todos and the cargos in one call", () => {
  const people = [
    person("me", { role: "owner" }),
    person("carla", { roleIds: ["suporte"] }),
    person("diego", { roleIds: ["suporte"] }),
    person("eva"),
    person("bia", { roleIds: ["fin"] }),
    person("rui"),
    person("lia"),
  ];

  test("the walkthrough: Suporte › Criar canais off keeps it for Financeiro, Admin as it is, Suporte without", async () => {
    const t = await translator("pt-BR");
    const who = whoCanStart(roles, "create_channels", suporte);
    expect(who).toMatchObject({ mode: "some", step: 0, keep: 1 });
    expect([...who.ticked]).toEqual(["fin"]);
    expect(whoCanHolders(roles, who)).toEqual({
      everyone: 0,
      roles: [
        { id: "suporte", level: 0 },
        { id: "fin", level: 1 },
      ],
    });
    expect(whoCanChanged(roles, who)).toBe(true);
    expect(whoCanLines(t, roles, people, who, "me")).toEqual([
      "Deixam de poder: carla, diego e mais 3.",
      "Donos sempre podem.",
    ]);
    // Todos again: nothing changes, Salvar stays off.
    expect(whoCanChanged(roles, { ...who, mode: "everyone" })).toBe(false);
  });

  test("from Todos: the cargos that already hold it ticked; everyone getting it says so", async () => {
    const t = await translator("pt-BR");
    const who = whoCanStart(roles, "manage_routines", everyone);
    expect([...who.ticked]).toEqual(["suporte"]);
    expect(whoCanChanged(roles, who)).toBe(false);
    expect(whoCanLines(t, roles, [person("rui")], { ...who, mode: "everyone" }, "me")).toEqual([
      "Todo mundo passa a poder.",
      "Donos sempre podem.",
    ]);
    expect(whoCanLines(t, roles, [person("rui")], who, "me")[0]).toBe("Ninguém perde.");
  });

  test("you come first in the line; a cargo above the viewer is never sent", async () => {
    const t = await translator("pt-BR");
    const above = { ...fin, editable: false };
    const list = [admin, suporte, above, everyone];
    const who = whoCanStart(list, "post", suporte);
    expect(whoCanHolders(list, who).roles.map((r) => r.id)).toEqual(["suporte"]);
    expect(whoCanLines(t, list, [person("me", { roleIds: ["suporte"] }), person("rui")], who, "me")[0]).toBe(
      "Deixam de poder: você e rui.",
    );
  });

  test("the computers: Todos goes down to the step picked, the ticked keep Todos' old step", async () => {
    const t = await translator("pt-BR");
    const browser = { ...fin, permissions: ["own_browsers"] };
    const list = [admin, suporte, browser, everyone];
    const who = whoCanStart(list, COMPUTERS_ROW, suporte, 1);
    expect(who).toMatchObject({ step: 1, keep: 2, from: "suporte" });
    // Suporte, where it was picked, gets exactly that step (the web's `rowHolders`).
    expect(whoCanHolders(list, who)).toEqual({
      everyone: 1,
      roles: [
        { id: "suporte", level: 1 },
        { id: "fin", level: 2 },
      ],
    });
    expect(whoCanLines(t, list, [person("rui")], who, "me")[0]).toBe(
      "Todos passam a ter o navegador dos próprios agentes.",
    );
    // Unticked, a cargo keeps what it has below Todos' old step: Financeiro its own agents' browser.
    const none = { ...whoCanStart(list, COMPUTERS_ROW, suporte, 0), ticked: new Set<string>() };
    expect(whoCanHolders(list, none).roles).toEqual([
      { id: "suporte", level: 0 },
      { id: "fin", level: 1 },
    ]);
    expect(whoCanLines(t, list, [], none, "me")[0]).toBe("Todos deixam de usar os computadores dos agentes.");
    // Above Todos' step, "Não usa" on Suporte takes all of it, not down to what is below Todos' old step.
    const strong = [admin, { ...suporte, permissions: ["control_browsers"] }, fin, everyone];
    const off = whoCanStart(strong, COMPUTERS_ROW, suporte, 0);
    expect(whoCanHolders(strong, off).roles).toEqual([
      { id: "suporte", level: 0 },
      { id: "fin", level: 2 },
    ]);
    // Todos isn't a cargo it started on: from Todos, every unticked cargo keeps what it has below.
    expect(whoCanStart(strong, COMPUTERS_ROW, everyone, 0).from).toBeUndefined();
  });
});

describe("Canais (P6, P6b)", () => {
  const channel = (over: Partial<Channel> & { id: string }): Channel => ({
    name: over.id,
    topic: "",
    visibility: "public",
    isMember: true,
    createdAt: "2026-11-01T00:00:00Z",
    ...over,
  });
  const general = channel({ id: "general" });
  const clientes = channel({ id: "clientes", categoryId: "vendas", position: 1 });
  const limited = channel({ id: "suporte", visibility: "private", audienceRoleIds: ["suporte", "fin"] });
  const diretoria = channel({ id: "diretoria", visibility: "private", audienceRoleIds: [] });

  test("a cargo's people see public channels and those limited to it; who sees each, in words", async () => {
    const t = await translator("pt-BR");
    expect(channelTicked(suporte, clientes)).toBe(true);
    expect(channelTicked(suporte, limited)).toBe(true);
    expect(channelTicked(admin, limited)).toBe(false);
    expect(channelTicked(everyone, limited)).toBe(false);
    expect(channelAudienceLine(t, clientes, roles)).toBe("Todos veem");
    expect(channelAudienceLine(t, limited, roles)).toBe("Só Suporte e Financeiro");
    expect(channelAudienceLine(t, diretoria, roles)).toBe("Privado");
  });

  test("a tap follows W5's table, and Todos opens a channel to everyone", () => {
    expect(channelIntent(suporte, general, true)).toEqual({ kind: "fixed" });
    expect(channelIntent(suporte, clientes, false)).toEqual({ kind: "locked" });
    expect(channelIntent(suporte, clientes, true)).toEqual({ kind: "who" });
    expect(channelIntent(suporte, limited, true)).toEqual({
      kind: "save",
      input: { visibility: "private", audienceRoleIds: ["fin"] },
    });
    expect(channelIntent(admin, limited, true)).toEqual({
      kind: "save",
      input: { visibility: "private", audienceRoleIds: ["suporte", "fin", "admin"] },
    });
    expect(channelIntent(suporte, diretoria, true)).toEqual({
      kind: "save",
      input: { visibility: "private", audienceRoleIds: ["suporte"] },
      open: "role",
    });
    expect(channelIntent(everyone, diretoria, true)).toEqual({
      kind: "save",
      input: { visibility: "public" },
      open: "everyone",
    });
  });

  test("Quem vê opens on the other cargos; none ticked is invite only; the line says who leaves or stops seeing", async () => {
    const t = await translator("pt-BR");
    const start = whoSeesStart(roles, clientes, suporte);
    expect(start).toEqual({ mode: "roles", roleIds: new Set(["admin", "fin"]) });
    expect(whoSeesInput({ mode: "roles", roleIds: new Set() })).toEqual({ visibility: "private", audienceRoleIds: [] });
    const people = [person("carla", { roleIds: ["suporte"] }), person("bia", { roleIds: ["fin"] }), person("rui")];
    // From public to Admin and Financeiro: who's in stays, the others stop seeing it.
    expect(whoSeesLines(t, clientes, start, ["carla"], people, roles, "me")).toEqual([
      "Quem já está continua. Deixam de ver: rui.",
    ]);
    // Taking Suporte off a limited channel: its people in it leave.
    const next = { mode: "roles" as const, roleIds: new Set(["fin"]) };
    expect(whoSeesLines(t, limited, next, ["carla", "bia"], people, roles, "me")).toEqual(["carla sai do canal."]);
    expect(whoSeesLines(t, limited, { mode: "public", roleIds: new Set() }, [], people, roles, "me")).toEqual([
      "Todo o histórico fica aberto para o workspace.",
    ]);
  });

  test("grouped as the sidebar: no category first with #general on top, then each category; search by name", () => {
    const vendas = { id: "vendas", name: "Vendas" };
    const groups = channelGroups([clientes, limited, general, diretoria], [vendas]);
    expect(groups.map((g) => [g.name, g.channels.map((c) => c.name)])).toEqual([
      [null, ["general", "diretoria", "suporte"]],
      ["Vendas", ["clientes"]],
    ]);
    expect(channelGroups([clientes, limited, general], [vendas], "#cli").map((g) => g.name)).toEqual(["Vendas"]);
  });
});

describe("Agentes (P7, P7b)", () => {
  const max = agent({ id: "max", name: "Max", ownerUserId: "ana" });
  const people = [person("ana"), person("carla", { roleIds: ["suporte"] }), person("rui")];
  const nameOf = (id: string) => people.find((p) => p.userId === id)?.name;
  const limitedMax = { ...max, audience: { mode: "people" as const, userIds: ["ana"], roleIds: ["suporte"] } };
  const ownerOnly = { ...max, audience: { mode: "owner" as const, userIds: [], roleIds: [] } };

  test("the right hand and agents gone aren't listed; who talks to each, in words", async () => {
    const t = await translator("pt-BR");
    const lodi = agent({ id: "lodi", name: "Lodi", builtin: "right_hand" });
    const gone = agent({ id: "old", name: "Old", former: "archived" });
    expect(listedAgents([max, lodi, gone, agent({ id: "ada", name: "Ada" })]).map((a) => a.name)).toEqual([
      "Ada",
      "Max",
    ]);
    expect(agentAudienceLine(t, max, roles, nameOf)).toBe("Todos falam");
    expect(agentAudienceLine(t, limitedMax, roles, nameOf)).toBe("Só Suporte e ana");
    expect(agentAudienceLine(t, ownerOnly, roles, nameOf)).toBe("Só ana");
    expect(agentTicked(fin, max)).toBe(true);
    expect(agentTicked(suporte, limitedMax)).toBe(true);
    expect(agentTicked(fin, limitedMax)).toBe(false);
    expect(agentTicked(everyone, limitedMax)).toBe(false);
  });

  test("a tap follows W7's table: narrow from everyone, drop or add the cargo, open to everyone from Todos", () => {
    expect(agentIntent(suporte, max, roles)).toEqual({
      kind: "who",
      start: { mode: "people", userIds: [], roleIds: ["admin", "fin"], consultable: true },
    });
    expect(agentIntent(suporte, limitedMax, roles)).toEqual({
      kind: "save",
      audience: { mode: "people", userIds: ["ana"], roleIds: [], consultable: true },
    });
    expect(agentIntent(fin, limitedMax, roles)).toEqual({
      kind: "save",
      audience: { mode: "people", userIds: ["ana"], roleIds: ["suporte", "fin"], consultable: true },
    });
    expect(agentIntent(fin, ownerOnly, roles)).toEqual({
      kind: "who",
      start: { mode: "people", userIds: [], roleIds: ["fin"], consultable: true },
    });
    // The cargo was the only one listed besides the owner: only the owner is left.
    const onlySuporte = { ...max, audience: { mode: "people" as const, userIds: [], roleIds: ["suporte"] } };
    expect(agentIntent(suporte, onlySuporte, roles)).toEqual({
      kind: "save",
      audience: { mode: "owner", userIds: [], roleIds: [], consultable: true },
    });
    expect(agentIntent(everyone, limitedMax, roles)).toEqual({
      kind: "save",
      audience: { mode: "everyone", userIds: [], roleIds: [], consultable: true },
    });
  });

  test("a tick, an untick or Quem fala com keeps Outros agentes podem consultar as it was saved", () => {
    // Off, on someone's plan only its owner turns it back on (ADR 0059 §5): a cargo's tab never does.
    const closed = {
      ...max,
      audience: { mode: "people" as const, userIds: [], roleIds: ["suporte"], consultable: false },
    };
    const sent = (intent: ReturnType<typeof agentIntent>) =>
      audiencePatch(intent.kind === "save" ? intent.audience : intent.start).consultable;
    expect(sent(agentIntent(fin, closed, roles))).toBe(false);
    expect(sent(agentIntent(suporte, { ...closed, ownerUserId: null }, roles))).toBe(false);
    expect(sent(agentIntent(suporte, closed, roles))).toBe(false);
    const open = { ...max, audience: { mode: "everyone" as const, userIds: [], roleIds: [], consultable: false } };
    expect(sent(agentIntent(suporte, open, roles))).toBe(false);
    expect(sent(agentIntent(everyone, closed, roles))).toBe(false);
    // P7b: whatever is picked, Salvar sends the saved switch.
    expect(agentWhoPatch({ mode: "people", userIds: ["rui"], roleIds: [] }, { consultable: false })).toEqual({
      mode: "people",
      userIds: ["rui"],
      roleIds: [],
      consultable: false,
    });
    expect(read("features/roles/AgentsScreen.tsx")).toContain("const next = agentWhoPatch(who, saved);");
  });

  test("Quem fala com needs someone, and says who stops talking to it", async () => {
    const t = await translator("pt-BR");
    expect(audienceValid({ mode: "people", userIds: [], roleIds: [] }, max)).toBe(false);
    expect(audienceValid({ mode: "owner", userIds: [], roleIds: [] }, { ownerUserId: null })).toBe(false);
    expect(audienceValid({ mode: "people", userIds: [], roleIds: ["fin"] }, max)).toBe(true);
    const next = { mode: "people" as const, userIds: [], roleIds: ["suporte"] };
    expect(agentLosingLine(t, max, next, people, "me")).toBe("Deixam de falar com Max: rui.");
    expect(agentLosingLine(t, max, { mode: "everyone", userIds: [], roleIds: [] }, people, "me")).toBe(
      "Ninguém perde.",
    );
  });

  test("without Conversar com agentes for Todos or the cargo, the tab says so first", () => {
    expect(talkGate(suporte, everyone)).toBe(false);
    const quiet = { ...everyone, permissions: ["post"] };
    expect(talkGate(suporte, quiet)).toBe(true);
    expect(talkGate({ ...suporte, permissions: ["talk_to_agents"] }, quiet)).toBe(false);
    expect(talkGate(admin, quiet)).toBe(false);
  });
});

describe("The order (P2's Ordenar), people and new cargos", () => {
  const list = [admin, suporte, fin];

  test("▲ and ▼ move a cargo among those below the viewer; OK saves only a changed order", () => {
    const mine = [{ ...admin, editable: false }, suporte, fin];
    expect(orderSteps(mine, "admin")).toEqual({ up: false, down: false });
    expect(orderSteps(mine, "suporte")).toEqual({ up: false, down: true });
    expect(orderSteps(mine, "fin")).toEqual({ up: true, down: false });
    const moved = moveRole(mine, "fin", -1);
    expect(moved.map((r) => r.id)).toEqual(["admin", "fin", "suporte"]);
    expect(moveRole(mine, "suporte", -1).map((r) => r.id)).toEqual(["admin", "suporte", "fin"]);
    expect(orderChanged(moved, mine)).toBe(true);
    expect(orderChanged(mine, list)).toBe(false);
    // ▲▼ are 44 targets reaching into the row's padding: on the name's line they take the 30-point mark's height, so
    // opening Ordenar grows no row and the list doesn't move.
    const into = read("ui/Grouped.tsx").match(/buttons: \{[^}]*marginVertical: -GROUPED_ROW\.padY \+ (\d+)/)?.[1];
    expect(TOUCH - 2 * (GROUPED_ROW.padY - Number(into))).toBe(30);
    expect(read("features/roles/RolesScreen.tsx")).toMatch(/leading=\{<CargoMark role=\{role\} size=\{30\} \/>\}/);
  });

  test("a person's Cargos lists what the viewer may give; Criar cargo copies whole only below them", () => {
    expect(givableRoles([...list, { ...fin, id: "top", givable: false }, everyone]).map((r) => r.id)).toEqual([
      "admin",
      "suporte",
      "fin",
    ]);
    const lead = { role: "member", userId: "u", permissions: ["manage_roles", "view_usage", "view_audit"] };
    expect(copyableRoles(roles, lead).map((r) => r.id)).toEqual(["fin"]);
    expect(copiesWhole(fin)).toBe(true);
    expect(copiesWhole({ ...fin, editable: false })).toBe(false);
    expect(copiesWhole(everyone)).toBe(false);
    // Above the viewer, or a template: by its keys.
    expect(newRoleInput("Moderação", "mod", [])).toEqual({
      name: "Moderação",
      icon: "flag",
      color: "teal",
      permissions: ["create_channels", "manage_channels"],
    });
    expect(newRoleInput("Cópia", "copy:fin", [fin])).toMatchObject({ icon: "wallet", permissions: fin.permissions });
  });

  test("adding people one by one goes on past a refusal, keeping their other cargos", async () => {
    const sent: { userId: string; roleIds: string[] }[] = [];
    const people = [person("ana", { roleIds: ["top"] }), person("bia")];
    const result = await giveRole(people, ["ana", "bia", "gone"], "fin", async (v) => {
      sent.push(v);
      if (v.userId === "ana") throw new Error("above you");
    });
    expect(sent).toEqual([
      { userId: "ana", roleIds: ["top", "fin"] },
      { userId: "bia", roleIds: ["fin"] },
    ]);
    expect(result.added).toBe(1);
    expect((result.failed as Error).message).toBe("above you");
  });

  test("the mailbox question names each agent, address and whose it is", async () => {
    const t = await translator("pt-BR");
    expect(
      mailLossQuestion(t, [
        { agentName: "Max", address: "bruno@example.com", ownerName: "Bruno" },
        { agentName: "Fin", address: "caixa@example.com", ownerName: null },
      ]),
    ).toEqual({
      title: "Agentes perdem 2 caixas de e-mail",
      text: [
        "Max perde bruno@example.com, a caixa de e-mail de Bruno.",
        "Fin perde a caixa de e-mail caixa@example.com.",
        "Só quem deu a caixa dá de novo.",
      ].join("\n"),
    });
  });

  test("Membros: a person's sheet offers Cargos; Convidar com este cargo gives new addresses the cargo", () => {
    expect(memberActions(false, true, true)).toEqual(["dm", "roles", "remove"]);
    expect(memberActions(true, true, true)).toEqual(["roles", "leave"]);
    expect(memberActions(false, false)).toEqual(["dm"]);
    expect(withAddresses([], "ana@example.com", "suporte")).toEqual([
      { email: "ana@example.com", valid: true, roleId: "suporte" },
    ]);
    expect(read("features/members/MembersPage.tsx")).toContain("roles: () => router.push(rolesHref.person(m.userId))");
    expect(read("features/roles/RoleScreen.tsx")).toContain("params: { role: role.id }");
    const invite = read("features/members/InvitePeople.tsx");
    expect(invite).toContain("withAddresses(d.addresses, text, d.roleId ?? null)");
    // The docked button sends what is still in the field (the keyboard up): it gets the cargo too.
    expect(invite).toContain("const all = withAddresses(draft.addresses, typed, draft.roleId ?? null);");
    expect(invite).not.toMatch(/withAddresses\(draft\.addresses, typed\)/);
  });

  test("giving a cargo asks about mailboxes first and sends what was asked; taking one has Desfazer", () => {
    const parts = read("features/roles/parts.tsx");
    expect(parts).toContain("mailLossSeen: seen");
    expect(parts).toMatch(/e instanceof ApiError && e\.status === 404\) return \[\]/);
    const people = read("features/roles/PeopleScreen.tsx");
    expect(people).toContain("set.mutateAsync({ ...v, mailLossSeen: seen })");
    expect(people).toContain('action: { label: t("members.undo")');
    // The ones being added keep their rows until the screen is gone, and every switch waits while one saves.
    expect(people).toContain("const people = useHeldWhile(live, busy);");
    expect(people).toMatch(/stays = false;\s*goBack\(\);[\s\S]*?if \(stays\) setBusy\(false\);/);
    expect(people).toContain("disabled={cargo.busy}");
    // Busy from the tap, the mailbox question included: a second switch meanwhile would save from the same cargos.
    expect(parts).toContain("return { run, busy: running || set.isPending };");
    expect(parts).toMatch(/if \(inFlight\.current\) return false;\s*inFlight\.current = true;\s*setRunning\(true\);/);
    expect(parts).toMatch(/finally \{\s*inFlight\.current = false;\s*setRunning\(false\);/);
    // An ignored take-out says nothing.
    expect(people).toMatch(/cargo\.run\(p, role\.id, false\)\.then\(\(done\) => \{\s*if \(!done\) return;/);
  });
});

describe("RoleMark: the web's mark on the phone", () => {
  test("the server's sixteen icons, Todos' and the owners' are all in the phone's set", () => {
    const engine = readFileSync(join(import.meta.dir, "../../../../packages/engine/src/permissions.ts"), "utf8");
    const list = engine.match(/ROLE_ICONS = \[([^\]]+)\]/)?.[1] ?? "";
    const icons = [...list.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
    expect(icons).toHaveLength(16);
    for (const name of [...icons, "audienceEveryone", "audienceOwner"]) expect(ICON_NAMES).toContain(name as never);
    expect(roleMarkIcon("pullRequest")).toBe("pullRequest");
    expect(roleMarkIcon("nope")).toBe("shield");
  });

  test("the dither is one path per tone covering every cell once, however many cells", () => {
    for (const cells of [8, 10, 14, 18]) {
      const paths = ditherPaths("teal", cells);
      expect(paths.length).toBeLessThanOrEqual(5);
      const area = paths
        .flatMap((p) => [...p.d.matchAll(/h(\d+)v1/g)].map((m) => Number(m[1])))
        .reduce((a, b) => a + b, 0);
      expect(area).toBe(cells * cells);
    }
    expect(ditherPaths("teal", 10)).toBe(ditherPaths("teal", 10));
  });

  test("the dither's cells and the icon follow the web's sizes, the icon never past 72% of the circle", () => {
    expect(roleMarkFit(14)).toEqual({ cells: 8, icon: 10 });
    expect(roleMarkFit(16)).toEqual({ cells: 8, icon: 10 });
    for (const size of [14, 16, 18, 20, 22, 24, 26, 30, 32, 40, 56, 64])
      expect([size, roleMarkFit(size).icon / size <= 0.72]).toEqual([size, true]);
    expect(roleMarkFit(24)).toEqual({ cells: 10, icon: 16 });
    expect(roleMarkFit(30)).toEqual({ cells: 14, icon: 20 });
    expect(roleMarkFit(56)).toEqual({ cells: 18, icon: 26 });
    // Every caller draws the kit's mark with its role's icon, none the old square.
    expect(read("features/dashboards/parts.tsx")).not.toContain("export function RoleMark");
    for (const file of [
      "features/dashboards/EditRolesScreen.tsx",
      "features/files/ShareSheet.tsx",
      "features/devices/AudienceScreen.tsx",
      "features/agents/setup/SetupStepScreen.tsx",
      "features/members/JoinRequestsSheet.tsx",
    ])
      expect({ file, icon: /RoleMark color=\{\w+\.color\} icon=\{\w+\.icon\}/.test(read(file)) }).toEqual({
        file,
        icon: true,
      });
  });
});

describe("The worst case: long names, one of each, a hundred cargos, 1,284 people", () => {
  // The server's limits: a cargo's name 40 letters (ROLE_NAME_MAX), a channel's 80, an agent's 32, ROLES_MAX 100.
  const long = role({ id: "long", name: "Desenvolvimento de Produto e Engenharia!", position: 3 });
  const viet = role({ id: "viet", name: "Nguyễn Thị Minh Khai", position: 4, permissions: ["manage_channels"] });
  const han = role({ id: "han", name: "研发与产品工程部", position: 5, channelIds: ["c1"], agentIds: [] });

  test("exactly one of everything says it in the singular", async () => {
    const t = await translator("pt-BR");
    expect(reachLine(t, viet, everyone, AREAS)).toBe("+1 permissão");
    expect(reachLine(t, han, everyone, AREAS)).toBe("+1 canal");
    expect(glanceLine(t, han, everyone, AREAS, 1)).toBe("1 pessoa · +1 canal");
    const en = await translator("en");
    expect(glanceLine(en, han, everyone, AREAS, 1)).toBe("1 person · +1 channel");
    expect(long.name).toHaveLength(40);
  });

  test("a hundred cargos: the order moves within those the viewer may change, the names in full", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      role({ id: `r${i}`, name: `${"Cargo ".repeat(6)}${i}`.slice(0, 40), position: i, editable: i > 9 }),
    );
    expect(orderSteps(many, "r10")).toEqual({ up: false, down: true });
    expect(orderSteps(many, "r99")).toEqual({ up: true, down: false });
    expect(moveRole(many, "r10", -1)).toEqual(many);
    expect(givableRoles([...many, everyone])).toHaveLength(100);
  });

  test("1,284 people losing a permission: you first, two names, then how many more", async () => {
    const t = await translator("pt-BR");
    const crowd = [
      person("me", { name: "Inês" } as Partial<Person>),
      person("a", { name: "Aleksandra Wiśniewska-Kowalczyk" } as Partial<Person>),
      ...Array.from({ length: 1282 }, (_, i) => person(`p${i}`)),
    ];
    expect(t("mobile.roles.losing", { names: peopleNames(t, crowd, "me") })).toBe(
      "Deixam de poder: você, Aleksandra Wiśniewska-Kowalczyk e mais 1282.",
    );
  });

  test("an address with a long domain stays whole in the mailbox question", async () => {
    const t = await translator("pt-BR");
    const address = "bartholomew.fitzgerald@northwind-industries-holdings.example.com";
    const q = mailLossQuestion(t, [{ agentName: "Assistente de Atendimento ao Cli", address, ownerName: null }]);
    expect(q.title).toBe("Um agente perde uma caixa de e-mail");
    expect(q.text).toContain(address);
  });

  test("80 channels in categories: grouped, #general first, a search narrows them", () => {
    const channels = Array.from({ length: 80 }, (_, i) => ({
      id: `c${i}`,
      name: i === 0 ? "general" : `canal-${i}-do-time-de-atendimento-ao-cliente-nivel-${i % 3}`,
      categoryId: i % 2 ? "a" : i % 3 ? "b" : null,
      position: i,
    }));
    const groups = channelGroups(channels, [
      { id: "a", name: "Atendimento" },
      { id: "b", name: "Produto" },
    ]);
    expect(groups.map((g) => g.channels.length).reduce((a, b) => a + b, 0)).toBe(80);
    expect(groups[0]?.channels[0]?.name).toBe("general");
    expect(channelGroups(channels, [], "#nivel-2").every((g) => g.channels.every((c) => c.name.endsWith("2")))).toBe(
      true,
    );
  });
});
