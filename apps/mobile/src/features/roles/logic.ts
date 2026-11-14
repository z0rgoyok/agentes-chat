import type {
  Agent,
  AgentAudience,
  AudienceMode,
  Channel,
  OrgRole,
  OrgRoles,
  Person,
  RowHolders,
} from "@agenteschat/client";
import { audienceAdmits, audienceOf, audiencePatch, modeOf } from "@agenteschat/client/lib/audience";
import { accessInput, accessOf } from "@agenteschat/client/lib/channel-access";
import { namesText } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  areaRows,
  COMPUTER_KEYS,
  COMPUTERS_ROW,
  channelLeavers,
  holdersAfter,
  holdsAll,
  isEveryone,
  levelOn,
  reachOf,
  rowMax,
  rowState,
  sortRoles,
  withRow,
} from "@agenteschat/client/lib/roles";
import { matchesWords } from "@agenteschat/ui/search";
import type { TFunction } from "i18next";

/*
 * Configurações › Cargos on the phone (plan §1.4, ADR 0085 addendum of 2026-11-13), the web's rules: what each cargo
 * adds, its permissions as one flat list where a row everyone has is still live ("Quem pode…" says who keeps it), the
 * channels and agents it opens, its people, and the order. Pure, so it is unit-tested; the screens draw it.
 */

/** Whoever looks: their membership and rank (`OrgSummary`), and who they are. */
export interface Viewer {
  role: string;
  rank?: number | null | undefined;
  userId: string;
  permissions?: readonly string[] | undefined;
}

/** The owners' page in the roles' routes (owner isn't a role on the server: `organization_members.role`). */
export const OWNER_ROLE = "owner";
/** The owners' mark, as their names are painted. */
export const OWNER_MARK = { color: "violet", icon: "audienceOwner" } as const;
/** Past this many cargos the list gets its search, as the web's. */
export const ROLES_SEARCH_FROM = 8;
/** At most this many cargos per workspace (`ROLES_MAX` on the server): Criar cargo says so instead. */
export const ROLES_MAX = 100;

const isAdmin = (r: Pick<OrgRole, "kind" | "permissions">) => !isEveryone(r) && r.permissions.includes("administrator");
const custom = (roles: readonly OrgRole[]) => sortRoles(roles.filter((r) => !isEveryone(r)));
const SEP = " · ";

// ── What a cargo adds ───────────────────────────────────────────────────────

/**
 * The line under a cargo in the list and on its page: "+3 permissões · +2 canais · +1 agente" (what it adds to Todos),
 * Todos' own reach without the "+", "Pode tudo" for Administrador, "Só o que Todos podem" when it adds nothing.
 */
export function reachLine(t: TFunction, role: OrgRole, everyone: OrgRole | undefined, areas: OrgRoles["areas"]) {
  const r = reachOf(role, everyone, areas);
  if (r.all) return t("mobile.roles.reach.all");
  const base = isEveryone(role);
  const parts = (["permissions", "channels", "agents"] as const)
    .filter((k) => r[k] > 0)
    .map((k) => {
      const words = t(`mobile.roles.reach.${k}`, { count: r[k] });
      return base ? words : t("mobile.roles.reach.more", { what: words });
    });
  if (parts.length) return parts.join(SEP);
  return base ? t("mobile.roles.reach.baseNone") : t("mobile.roles.reach.none");
}

/** The glance under a cargo's name: its people, then what it adds ("3 pessoas · +3 permissões · +2 canais"). */
export function glanceLine(
  t: TFunction,
  role: OrgRole,
  everyone: OrgRole | undefined,
  areas: OrgRoles["areas"],
  people: number,
) {
  const who = people > 0 ? t("rolesPage.people", { count: people }) : t("mobile.roles.nobody");
  return `${who}${SEP}${reachLine(t, role, everyone, areas)}`;
}

/** The values beside Permissões, Canais and Agentes on a cargo's page: "+3" (Todos': "7"), nothing at zero. */
export function tabValues(t: TFunction, role: OrgRole, everyone: OrgRole | undefined, areas: OrgRoles["areas"]) {
  const r = reachOf(role, everyone, areas);
  const value = (n: number) => (n === 0 ? "" : isEveryone(role) ? String(n) : `+${n}`);
  return {
    permissions: r.all ? t("mobile.roles.reach.all") : value(r.permissions),
    channels: value(r.channels),
    agents: value(r.agents),
  };
}

// ── Permissões ──────────────────────────────────────────────────────────────

/** The group Administrador sits in, last. */
export const ADVANCED = "advanced";

export interface PermissionRow {
  /** A key, `computers` (the five steps) or `administrator`. */
  row: string;
  title: string;
  /** What it lets people do: the ⓘ's text. */
  desc: string;
  /** The cargo's own level, and what its people get (Todos' included). */
  own: number;
  level: number;
  /** Everyone has at least this much: "Todos podem" under it, and turning it off asks who keeps it. */
  fromEveryone: boolean;
  /** On Todos: the cargos that give it when Todos doesn't ("Só Admin e Financeiro"). */
  holders: OrgRole[];
  /** The viewer holds it (an owner everything): only then may they give or take it. */
  held: boolean;
}

export interface PermissionGroup {
  id: string;
  title: string;
  rows: PermissionRow[];
}

/** The highest computers' step the viewer holds: they may set a cargo up to it (`settableKeys` on the server). */
export function heldStep(viewer: Viewer) {
  if (viewer.role === "owner") return COMPUTER_KEYS.length;
  return COMPUTER_KEYS.reduce((step, k, i) => (holdsAll(viewer, [k]) ? i + 1 : step), 0);
}

/**
 * A cargo's permissions in the web's groups (the server's areas, then Avançado with Administrador), each row's state,
 * those matching `query` (title, ⓘ text or group, accents ignored). An Administrador cargo shows Avançado alone: it may
 * everything, its other rows come back as they were when it goes off. Todos has no Administrador.
 */
export function permissionGroups(
  t: TFunction,
  role: OrgRole,
  data: OrgRoles,
  viewer: Viewer,
  query = "",
): PermissionGroup[] {
  const everyone = data.roles.find(isEveryone);
  const base = isEveryone(role);
  const admin = isAdmin(role);
  const rowOf = (row: string): PermissionRow => {
    const s = rowState(role, everyone, row);
    const computers = row === COMPUTERS_ROW;
    return {
      row,
      title: computers ? t("mobile.roles.computers.title") : t(`permissions.${row}.title` as "permissions.post.title"),
      desc: computers ? t("mobile.roles.computers.hint") : t(`permissions.${row}.desc` as "permissions.post.desc"),
      own: s.own,
      level: s.level,
      fromEveryone: !base && s.fromEveryone,
      holders: base ? custom(data.roles).filter((r) => isAdmin(r) || levelOn(r.permissions, row) > s.own) : [],
      held: computers ? heldStep(viewer) > 0 : holdsAll(viewer, [row]),
    };
  };
  const groups: PermissionGroup[] = admin
    ? []
    : data.areas.map((a) => ({
        id: a.id,
        title: t(`permissions.areas.${a.id}` as "permissions.areas.chat"),
        rows: areaRows(a).map(rowOf),
      }));
  if (!base)
    groups.push({
      id: ADVANCED,
      title: t("mobile.roles.advanced"),
      rows: [
        {
          row: "administrator",
          title: t("rolesPage.administrator"),
          desc: t("rolesPage.administratorDesc"),
          own: admin ? 1 : 0,
          level: admin ? 1 : 0,
          fromEveryone: false,
          holders: [],
          held: holdsAll(viewer, ["administrator"]),
        },
      ],
    });
  const q = query.trim();
  if (!q) return groups;
  return groups
    .map((g) => ({ ...g, rows: g.rows.filter((r) => matchesWords(`${r.title} ${r.desc} ${g.title}`, q)) }))
    .filter((g) => g.rows.length > 0);
}

/** What a switch does on a cargo: save its keys, or ask who keeps what everyone has ("Quem pode", P5). */
export type RowIntent = { kind: "save"; permissions: string[] } | { kind: "who" } | { kind: "admin" };

/**
 * Turning a row on or off on `role` (Todos too, W10): on gives it (Todos: to everyone); off takes the cargo's own,
 * unless everyone has it (then "Quem pode", set to "Só alguns cargos"); on Todos off always asks, with the cargos that
 * hold it ticked. Administrador on asks first.
 */
export function rowIntent(role: OrgRole, everyone: OrgRole | undefined, row: string, on: boolean): RowIntent {
  if (row === "administrator")
    return on ? { kind: "admin" } : { kind: "save", permissions: role.permissions.filter((k) => k !== row) };
  const s = rowState(role, everyone, row);
  if (on) return { kind: "save", permissions: withRow(role.permissions, row, rowMax(row)) };
  if (isEveryone(role) || s.fromEveryone) return { kind: "who" };
  return { kind: "save", permissions: withRow(role.permissions, row, 0) };
}

/**
 * Picking a computers' step on `role`: at or above Todos' it saves (a cargo keeps no key Todos already gives); below
 * Todos' it asks who keeps Todos' step, Todos going down to the one picked (W3, W10).
 */
export function stepIntent(
  role: OrgRole,
  everyone: OrgRole | undefined,
  step: number,
): { kind: "save"; permissions: string[] } | { kind: "who" } {
  const s = rowState(role, everyone, COMPUTERS_ROW);
  if (isEveryone(role))
    return step >= s.own
      ? { kind: "save", permissions: withRow(role.permissions, COMPUTERS_ROW, step) }
      : { kind: "who" };
  if (step < s.everyone) return { kind: "who" };
  return { kind: "save", permissions: withRow(role.permissions, COMPUTERS_ROW, step > s.everyone ? step : 0) };
}

// ── Quem pode ───────────────────────────────────────────────────────────────

/**
 * "Quem pode {{short}}" (P5): Todos or only some cargos, and which. `step` is the computers' step Todos goes to
 * (0 for a key: nobody but the ticked); `keep` the level a ticked cargo keeps (1, or Todos' old step).
 */
export interface WhoCan {
  row: string;
  mode: "everyone" | "some";
  ticked: ReadonlySet<string>;
  step: number;
  keep: number;
  /** The cargo the change started on (not Todos): unticked, it goes to exactly `step`, the one picked on it. */
  from?: string;
}

/** A cargo the viewer may tick: below them (`editable`), and not Administrador (it may everything, never written). */
export const tickable = (r: OrgRole) => !isEveryone(r) && r.editable && !isAdmin(r);

/**
 * Where "Quem pode" opens. From a cargo turning off what everyone has: "Só alguns cargos", every other cargo the
 * viewer may change ticked, this one not (W4). From Todos: the cargos that already hold it ticked. For the computers
 * `step` is the one picked below Todos': Todos goes down to it, the ticked keep Todos' old step.
 */
export function whoCanStart(roles: readonly OrgRole[], row: string, from: OrgRole, step?: number): WhoCan {
  const everyone = roles.find(isEveryone);
  const old = everyone ? levelOn(everyone.permissions, row) : 0;
  const keep = row === COMPUTERS_ROW ? Math.max(old, 1) : 1;
  const ticked = custom(roles).filter((r) =>
    isEveryone(from) ? tickable(r) && levelOn(r.permissions, row) >= keep : tickable(r) && r.id !== from.id,
  );
  return {
    row,
    mode: "some",
    ticked: new Set(ticked.map((r) => r.id)),
    step: step ?? 0,
    keep,
    ...(isEveryone(from) ? {} : { from: from.id }),
  };
}

/**
 * What saving it sends (`PUT …/permissions/{row}`): Todos at the top (Todos) or at `step`; each cargo the viewer may
 * change, a ticked one at `keep` (or its own when higher), the one it started on at `step`, any other unticked one
 * keeping what it has below `keep` (the web's `rowHolders`). Administrador cargos and cargos above the viewer are left
 * out: the server never changes them.
 */
export function whoCanHolders(roles: readonly OrgRole[], who: WhoCan): RowHolders {
  const everyone = who.mode === "everyone" ? Math.max(who.keep, who.step) : who.step;
  return {
    everyone,
    roles: custom(roles)
      .filter(tickable)
      .map((r) => {
        const own = levelOn(r.permissions, who.row);
        if (who.mode === "everyone") return { id: r.id, level: own };
        if (who.ticked.has(r.id)) return { id: r.id, level: Math.max(own, who.keep) };
        return { id: r.id, level: r.id === who.from ? who.step : Math.min(own, who.keep - 1) };
      }),
  };
}

/** Whether saving would change anything: Todos' level or a cargo's own. */
export function whoCanChanged(roles: readonly OrgRole[], who: WhoCan) {
  const next = whoCanHolders(roles, who);
  const everyone = roles.find(isEveryone);
  if ((everyone ? levelOn(everyone.permissions, who.row) : 0) !== next.everyone) return true;
  return next.roles.some((h) => {
    const r = roles.find((x) => x.id === h.id);
    return !r || levelOn(r.permissions, who.row) !== h.level;
  });
}

/** The people a list names, "você" first ("Deixam de poder: você, Carla e mais 3."). */
export function peopleNames(t: TFunction, people: readonly Pick<Person, "userId" | "name">[], meId: string) {
  const mine = people.filter((p) => p.userId === meId);
  const names = [...mine.map(() => t("common.you")), ...people.filter((p) => p.userId !== meId).map((p) => p.name)];
  return namesText(t, names, 2);
}

/**
 * The live line under "Quem pode": who loses it ("Deixam de poder: Carla, Diego e mais 3."), "Todo mundo passa a
 * poder." when everyone gets it, else "Ninguém perde."; for the computers what Todos goes to first.
 */
export function whoCanLines(
  t: TFunction,
  roles: readonly OrgRole[],
  people: readonly Person[],
  who: WhoCan,
  meId: string,
): string[] {
  const holders = whoCanHolders(roles, who);
  const { losing, gaining } = holdersAfter(people, roles, who.row, holders);
  const lines: string[] = [];
  if (who.row === COMPUTERS_ROW && who.mode === "some")
    lines.push(
      who.step === 0
        ? t("mobile.roles.computers.everyoneNone")
        : t("mobile.roles.computers.everyoneTo", {
            step: t(`mobile.roles.computers.stepsIn.${who.step}` as "mobile.roles.computers.stepsIn.1"),
          }),
    );
  if (losing.length > 0) lines.push(t("mobile.roles.losing", { names: peopleNames(t, losing, meId) }));
  else if (who.mode === "everyone" && gaining.length > 0) lines.push(t("mobile.roles.everyoneGets"));
  else lines.push(t("mobile.roles.nobodyLoses"));
  lines.push(t("mobile.roles.ownersAlways"));
  return lines;
}

// ── Canais ──────────────────────────────────────────────────────────────────

/** #general: everyone is in it, so it is always ticked. */
export const isGeneral = (c: Pick<Channel, "name">) => c.name === "general";

/** Whether the cargo's people see the channel: public ones for anyone, a limited one when it lists the cargo. */
export function channelTicked(role: OrgRole, channel: Pick<Channel, "visibility" | "audienceRoleIds">) {
  const a = accessOf(channel);
  return a.mode === "public" || (!isEveryone(role) && a.mode === "roles" && a.roleIds.includes(role.id));
}

/** The names of some cargos, top first ("Suporte e Financeiro", "Suporte, Admin e mais 2"). */
export function roleNames(t: TFunction, ids: readonly string[], roles: readonly OrgRole[]) {
  const named = sortRoles(roles.filter((r) => ids.includes(r.id))).map((r) => r.name);
  return namesText(t, named, 2);
}

/** Who sees a channel, under its name: "Todos veem", "Só Suporte e Financeiro", "Privado". */
export function channelAudienceLine(
  t: TFunction,
  channel: Pick<Channel, "visibility" | "audienceRoleIds">,
  roles: readonly OrgRole[],
) {
  const a = accessOf(channel);
  if (a.mode === "public") return t("mobile.roles.channels.everyone");
  if (a.mode === "private") return t("mobile.roles.channels.private");
  return t("mobile.roles.only", { names: roleNames(t, a.roleIds, roles) });
}

/** What a tap on a channel does on a cargo's Canais (W5's table; Todos as W10). */
export type ChannelIntent =
  | { kind: "who" }
  | { kind: "save"; input: ReturnType<typeof accessInput>; open?: "role" | "everyone" }
  | { kind: "fixed" }
  | { kind: "locked" };

/**
 * A public channel unticked asks who sees it (set to "Só alguns cargos", every other cargo ticked). A limited one
 * listing the cargo drops it (who leaves is asked by the screen, it knows the members); one not listing it adds it.
 * Invite only, ticked: it opens to the cargo (Todos: to everyone) after a question.
 */
export function channelIntent(role: OrgRole, channel: Channel, manages: boolean): ChannelIntent {
  if (isGeneral(channel)) return { kind: "fixed" };
  if (!manages) return { kind: "locked" };
  const a = accessOf(channel);
  if (a.mode === "public") return { kind: "who" };
  if (isEveryone(role)) return { kind: "save", input: accessInput({ mode: "public", roleIds: [] }), open: "everyone" };
  if (a.mode === "roles" && a.roleIds.includes(role.id))
    return { kind: "save", input: accessInput({ mode: "roles", roleIds: a.roleIds.filter((id) => id !== role.id) }) };
  if (a.mode === "roles")
    return { kind: "save", input: accessInput({ mode: "roles", roleIds: [...a.roleIds, role.id] }) };
  return { kind: "save", input: accessInput({ mode: "roles", roleIds: [role.id] }), open: "role" };
}

/** "Quem vê #canal" (P6b): Todos, only some cargos (which), or only who is added. */
export interface WhoSees {
  mode: "public" | "roles" | "private";
  roleIds: ReadonlySet<string>;
}

/**
 * Where "Quem vê" opens when a public channel is unticked: "Só alguns cargos", every other cargo ticked (every cargo
 * from Todos). A channel that isn't public opens as it is.
 */
export function whoSeesStart(roles: readonly OrgRole[], channel: Channel, from: OrgRole): WhoSees {
  const a = accessOf(channel);
  if (a.mode !== "public") return { mode: a.mode, roleIds: new Set(a.roleIds) };
  return {
    mode: "roles",
    roleIds: new Set(
      custom(roles)
        .filter((r) => r.id !== from.id)
        .map((r) => r.id),
    ),
  };
}

/** What saving "Quem vê" sends: "Só alguns cargos" with none ticked is invite only. */
export const whoSeesInput = (w: WhoSees) =>
  accessInput(
    w.mode === "roles" && w.roleIds.size === 0
      ? { mode: "private", roleIds: [] }
      : { mode: w.mode, roleIds: [...w.roleIds] },
  );

/**
 * The live line under "Quem vê": who leaves the channel, who stops seeing it ("Quem já está continua. Deixam de ver:
 * Carla e mais 2."), "Todo o histórico fica aberto para o workspace." when it opens, else "Ninguém perde.".
 */
export function whoSeesLines(
  t: TFunction,
  channel: Channel,
  next: WhoSees,
  memberIds: readonly string[],
  people: readonly Person[],
  roles: readonly OrgRole[],
  meId: string,
) {
  const input = whoSeesInput(next);
  if (input.visibility === "public")
    return channel.visibility === "public" ? [t("mobile.roles.nobodyLoses")] : [t("mobile.roles.channels.openAllText")];
  const { leave, unsee } = channelLeavers(
    channel,
    { visibility: input.visibility ?? channel.visibility, audienceRoleIds: input.audienceRoleIds ?? [] },
    memberIds,
    people,
    roles,
  );
  const lines: string[] = [];
  if (leave.length > 0)
    lines.push(t("mobile.roles.channels.leave", { count: leave.length, names: peopleNames(t, leave, meId) }));
  if (unsee.length > 0) lines.push(t("mobile.roles.channels.unsee", { names: peopleNames(t, unsee, meId) }));
  return lines.length ? lines : [t("mobile.roles.nobodyLoses")];
}

/** The channels a cargo's Canais lists, in the sidebar's groups and order: no category first, then each one. */
export function channelGroups<C extends Pick<Channel, "id" | "name" | "categoryId" | "position">>(
  channels: readonly C[],
  categories: readonly { id: string; name: string }[],
  query = "",
) {
  const known = new Set(categories.map((c) => c.id));
  const hits = channels.filter((c) => matchesWords(c.name, query.trim().replace(/^#/, "")));
  const order = (a: C, b: C) =>
    (isGeneral(b) ? 1 : 0) - (isGeneral(a) ? 1 : 0) ||
    (a.position ?? 0) - (b.position ?? 0) ||
    a.name.localeCompare(b.name);
  const of = (id: string | null) =>
    hits.filter((c) => (c.categoryId && known.has(c.categoryId) ? c.categoryId : null) === id).sort(order);
  return [
    { id: null, name: null, channels: of(null) },
    ...categories.map((c) => ({ id: c.id, name: c.name, channels: of(c.id) })),
  ].filter((g) => g.channels.length > 0);
}

// ── Agentes ─────────────────────────────────────────────────────────────────

/** The agents a cargo's Agentes lists: the team's, without the right hand (everyone has it) and those gone. */
export const listedAgents = <A extends Pick<Agent, "builtin" | "former" | "name">>(agents: readonly A[]) =>
  agents.filter((a) => a.builtin !== "right_hand" && !a.former).sort((a, b) => a.name.localeCompare(b.name));

/** Whether the cargo's people talk to the agent: it answers everyone, or its audience lists the cargo. */
export function agentTicked(role: OrgRole, agent: Agent) {
  const mode = modeOf(agent);
  return mode === "everyone" || (!isEveryone(role) && mode === "people" && audienceOf(agent).roleIds.includes(role.id));
}

/** Who talks to an agent, under its name: "Todos falam", "Só Suporte e Ana", "Só Ana". */
export function agentAudienceLine(
  t: TFunction,
  agent: Agent,
  roles: readonly OrgRole[],
  nameOf: (userId: string) => string | undefined,
) {
  const mode = modeOf(agent);
  if (mode === "everyone") return t("mobile.roles.agents.everyone");
  const owner = agent.ownerUserId ? nameOf(agent.ownerUserId) : undefined;
  if (mode === "owner") return owner ? t("mobile.roles.only", { names: owner }) : t("audience.mode.owner");
  const a = audienceOf(agent);
  const named = [
    ...sortRoles(roles.filter((r) => a.roleIds.includes(r.id))).map((r) => r.name),
    ...a.userIds.flatMap((id) => nameOf(id) ?? []),
  ];
  return named.length ? t("mobile.roles.only", { names: namesText(t, named, 2) }) : t("audience.mode.owner");
}

/** What a tap on an agent does on a cargo's Agentes (W7's table; Todos as W10). */
export type AgentIntent = { kind: "who"; start: AgentAudience } | { kind: "save"; audience: AgentAudience };

/**
 * One that answers everyone, unticked: who talks to it, set to "Só alguns cargos e pessoas" with every other cargo.
 * One whose audience lists the cargo: dropped from it (only its owner left when nobody else is). One listing others:
 * the cargo joins. One only its owner talks to: who talks to it, with this cargo ticked. On Todos a tick opens it to
 * everyone (after today's questions), an untick asks who.
 */
export function agentIntent(role: OrgRole, agent: Agent, roles: readonly OrgRole[]): AgentIntent {
  const mode = modeOf(agent);
  const a = audienceOf(agent);
  // "Outros agentes podem consultar" stays as saved: on someone's plan only its owner turns it back on (ADR 0059 §5).
  const to = (next: AudienceMode, roleIds: string[] = [], userIds: string[] = []): AgentAudience => ({
    mode: next,
    userIds,
    roleIds,
    consultable: a.consultable,
  });
  const others = custom(roles)
    .filter((r) => r.id !== role.id)
    .map((r) => r.id);
  if (isEveryone(role))
    return mode === "everyone"
      ? { kind: "who", start: to("people", others) }
      : { kind: "save", audience: to("everyone") };
  if (mode === "everyone") return { kind: "who", start: to("people", others) };
  if (mode === "owner") return { kind: "who", start: to("people", [role.id]) };
  if (a.roleIds.includes(role.id)) {
    const roleIds = a.roleIds.filter((id) => id !== role.id);
    if (roleIds.length === 0 && a.userIds.length === 0)
      return agent.ownerUserId
        ? { kind: "save", audience: to("owner") }
        : { kind: "who", start: to("people", roleIds) };
    return { kind: "save", audience: to("people", roleIds, a.userIds) };
  }
  return { kind: "save", audience: to("people", [...a.roleIds, role.id], a.userIds) };
}

/** What Quem fala com's Salvar sends (P7b): the choice, "Outros agentes podem consultar" as saved. */
export const agentWhoPatch = (who: AgentAudience, saved: Pick<AgentAudience, "consultable">) =>
  audiencePatch({ ...who, consultable: saved.consultable });

/** A people audience needs someone in it (the owner always talks to it); everyone and only the owner don't. */
export const audienceValid = (a: AgentAudience, agent: Pick<Agent, "ownerUserId">) =>
  a.mode === "everyone" ||
  (a.mode === "owner" ? Boolean(agent.ownerUserId) : a.userIds.length + (a.roleIds?.length ?? 0) > 0);

/** Who stops talking to the agent with `next` ("Deixam de falar com Max: Carla e mais 2."), or "Ninguém perde.". */
export function agentLosingLine(
  t: TFunction,
  agent: Agent,
  next: AgentAudience,
  people: readonly Person[],
  meId: string,
) {
  const after: Agent = { ...agent, audience: next, audienceMode: next.mode };
  const losing = people.filter(
    (p) => audienceAdmits(agent, p.userId, p.roleIds ?? []) && !audienceAdmits(after, p.userId, p.roleIds ?? []),
  );
  return losing.length
    ? t("mobile.roles.agents.losing", { agent: agent.name, names: peopleNames(t, losing, meId) })
    : t("mobile.roles.nobodyLoses");
}

/** Whether neither Todos nor this cargo lets its people talk to agents: the Agentes tab says so first (W7). */
export function talkGate(role: OrgRole, everyone: OrgRole | undefined) {
  return !isAdmin(role) && rowState(role, everyone, "talk_to_agents").level === 0;
}

// ── A cargo's people, and the order ─────────────────────────────────────────

/**
 * The question before a cargo takes mailboxes from agents (W9's mailbox step as the system's alert): one line per
 * mailbox ("Max perde bruno@example.com, a caixa de e-mail de Bruno."), then who gives it back.
 */
export function mailLossQuestion(
  t: TFunction,
  losses: readonly { agentName: string; address: string; ownerName: string | null }[],
) {
  const lines = losses.map((l) =>
    l.ownerName
      ? t("mobile.roles.mail.loses", { agent: l.agentName, address: l.address, owner: l.ownerName })
      : t("mobile.roles.mail.losesAddress", { agent: l.agentName, address: l.address }),
  );
  return {
    title: t("mobile.roles.mail.title", { count: losses.length }),
    text: [...lines, t("mobile.roles.mail.only")].join("\n"),
  };
}

/** Moves the cargo one step up (-1) or down (+1) in the order being edited: only among the cargos the viewer may move. */
export function moveRole(order: readonly OrgRole[], id: string, by: -1 | 1): OrgRole[] {
  const i = order.findIndex((r) => r.id === id);
  const j = i + by;
  const a = order[i];
  const b = order[j];
  if (!a || !b || !a.editable || !b.editable) return [...order];
  const next = [...order];
  next[i] = b;
  next[j] = a;
  return next;
}

/** Whether a cargo can go up and down in the order being edited (Ordenar's ▲ and ▼). */
export function orderSteps(order: readonly OrgRole[], id: string) {
  const i = order.findIndex((r) => r.id === id);
  const at = order[i];
  return {
    up: Boolean(at?.editable && order[i - 1]?.editable),
    down: Boolean(at?.editable && order[i + 1]?.editable),
  };
}

/** The order being edited differs from the saved one: OK saves it. */
export const orderChanged = (order: readonly OrgRole[], saved: readonly OrgRole[]) =>
  order.some((r, i) => r.id !== saved[i]?.id);

/** Whether the viewer gives and takes this cargo (P8): not Todos, below them, and they manage people. */
export const givesRole = (org: Parameters<typeof can>[0], role: Pick<OrgRole, "kind" | "givable">) =>
  !isEveryone(role) && role.givable && can(org, "manage_members");

/** The cargos a person may get from the viewer (P11): those below them whose keys they hold (`givable`). */
export const givableRoles = (roles: readonly OrgRole[]) => custom(roles).filter((r) => r.givable);

/** "Começar de" for a new cargo: the templates, then "Igual a" each cargo whose keys the viewer holds. */
export function copyableRoles(roles: readonly OrgRole[], viewer: Viewer) {
  return custom(roles).filter((r) => holdsAll(viewer, r.permissions));
}

/**
 * What a new cargo starts from on the server: a cargo below the viewer is copied whole (`copyFrom`: its keys, look,
 * channels and agents, Duplicar's rule); one above them only by its keys; a template by its own.
 */
export const copiesWhole = (role: Pick<OrgRole, "editable" | "kind">) => !isEveryone(role) && role.editable;
