import type { TFunction } from "i18next";
import type { OrgRole, PermissionArea, Person, RowHolders } from "../api/types";
import { joinNames } from "./format";
import { can, type RolePermission } from "./permissions";

/**
 * A workspace's roles on screen (ADR 0085): each area of permissions at a level, the line that sums a role up, and
 * the order. Pure, for the web and the phone app.
 */

/** The permission areas (`PERMISSION_AREAS` on the server). */
export type PermissionAreaId = "chat" | "agents" | "tools" | "knowledge" | "org";

/** An area's level: nothing past `everyone` ("Como Todos"), its "use" keys, all of them, or a mix. */
export type AreaLevel = "none" | "use" | "manage" | "custom";

/** Every key with `administrator` spread out, and what each computer key gives (`IMPLIED` on the server). */
export function grants(keys: readonly string[]): Set<string> {
  const out = new Set(keys);
  if (out.has("administrator")) for (const k of ALL_KEYS) out.add(k);
  for (const k of [...out]) for (const i of IMPLIED[k] ?? []) out.add(i);
  return out;
}

const IMPLIED: Record<string, readonly string[]> = {
  control_computers: ["control_browsers", "own_computers", "own_browsers"],
  control_browsers: ["own_computers", "own_browsers"],
  own_computers: ["own_browsers"],
};

/**
 * The agents' computers on the roles screen: one choice per role, not keys one by one. `everyone` chooses for what
 * is a person's own (their agents, the computers they connected, what they're asked or asked for: `own_*`), any
 * other role for every agent (`control_*`).
 */
export type ComputerLevel = "none" | "browser" | "full";
/** The computers' ladder, lowest first: step n holds the n-th (`COMPUTER_STEPS` on the server), step 0 none. */
export const COMPUTER_KEYS: readonly string[] = [
  "own_browsers",
  "own_computers",
  "control_browsers",
  "control_computers",
];
const computerKeysOf = (role: Pick<OrgRole, "kind">) =>
  isEveryone(role)
    ? ({ browser: "own_browsers", full: "own_computers" } as const)
    : ({ browser: "control_browsers", full: "control_computers" } as const);

/** The level a set of keys gives on `role`'s reach. */
const levelIn = (keys: Set<string>, role: Pick<OrgRole, "kind">): ComputerLevel => {
  const k = computerKeysOf(role);
  return keys.has(k.full) ? "full" : keys.has(k.browser) ? "browser" : "none";
};

/** The role's computer level (`administrator` and its own keys), and what `everyone` already gives it (`base`). */
export function computerLevelOf(role: OrgRole, everyone: OrgRole | undefined) {
  return { level: levelIn(grants(role.permissions), role), base: levelIn(baseOf(role, everyone), role) };
}

const COMPUTER_LEVELS: readonly ComputerLevel[] = ["none", "browser", "full"];

/**
 * The computers' choice on `role`: the levels from what `everyone` already gives up (below it isn't offered), the one
 * shown, and the reach its lines speak of (`rolesPage.computer.<reach>.<level>`).
 */
export function computerChoice(role: OrgRole, everyone: OrgRole | undefined) {
  const { level, base } = computerLevelOf(role, everyone);
  const options = COMPUTER_LEVELS.slice(COMPUTER_LEVELS.indexOf(base));
  return {
    options,
    shown: options.includes(level) ? level : base,
    reach: isEveryone(role) ? ("own" as const) : ("every" as const),
  };
}

/** The role's keys with its computer level set (the rest untouched). */
export function withComputerLevel(role: OrgRole, level: ComputerLevel): string[] {
  const keep = role.permissions.filter((k) => !COMPUTER_KEYS.includes(k));
  return level === "none" ? keep : [...keep, computerKeysOf(role)[level]];
}

/** The one row the four computer keys make (`COMPUTERS_ROW` on the server): a ladder of five steps. */
export const COMPUTERS_ROW = "computers";

/** An area's rows on the roles screen: its keys, the four computer keys as one row in their place. */
export const areaRows = (area: Pick<PermissionArea, "keys">): string[] =>
  area.keys.flatMap((k) => (k === COMPUTER_KEYS[0] ? [COMPUTERS_ROW] : COMPUTER_KEYS.includes(k) ? [] : [k]));

/** The highest level of a row: 1 for a key, the last step for the computers. */
export const rowMax = (row: string) => (row === COMPUTERS_ROW ? COMPUTER_KEYS.length : 1);

/**
 * A set of keys' level on a row: 0 or 1 for a key, the computers' step (0 to 4). `administrator` aside: what it gives
 * isn't a role's own, and what is comes back when it goes off (`rowLevel` on the server).
 */
export function levelOn(keys: readonly string[], row: string): number {
  const own = grants(keys.filter((k) => k !== "administrator"));
  if (row !== COMPUTERS_ROW) return own.has(row) ? 1 : 0;
  return COMPUTER_KEYS.reduce((step, k, i) => (own.has(k) ? i + 1 : step), 0);
}

/** `keys` with `row` at `level` (the computers: its step's key alone), the rest untouched (`withRowLevel`). */
export function withRow(keys: readonly string[], row: string, level: number): string[] {
  const rowKeys = row === COMPUTERS_ROW ? COMPUTER_KEYS : [row];
  const key = row === COMPUTERS_ROW ? COMPUTER_KEYS[level - 1] : level > 0 ? row : undefined;
  return [...keys.filter((k) => !rowKeys.includes(k)), ...(key ? [key] : [])];
}

/**
 * A row on a role: its own level, `everyone`'s, and what its people get (the higher one). `fromEveryone`: everyone
 * has at least as much, so the row shows the Todos chip and turning it off asks "Quem pode" (ADR 0085 addendum of
 * 2026-11-13). On `everyone` itself, both are its own.
 */
export function rowState(role: OrgRole, everyone: OrgRole | undefined, row: string) {
  const own = levelOn(role.permissions, row);
  const base = isEveryone(role) ? own : everyone ? levelOn(everyone.permissions, row) : 0;
  return { own, everyone: base, level: Math.max(own, base), fromEveryone: base > 0 && base >= own };
}

const isAdmin = (r: Pick<OrgRole, "kind" | "permissions">) => !isEveryone(r) && r.permissions.includes("administrator");

/**
 * The roles once a "Quem pode" change is saved, as the server applies it (`setRowHolders`): `everyone` at its level,
 * each listed role at its level, every other role the viewer may change at 0; roles above them and Administrador
 * roles as they were.
 */
export function withRowHolders(roles: readonly OrgRole[], row: string, holders: RowHolders): OrgRole[] {
  const listed = new Map(holders.roles.map((r) => [r.id, r.level]));
  return roles.map((r) => {
    if (!isEveryone(r) && (!r.editable || isAdmin(r))) return r;
    const level = isEveryone(r) ? holders.everyone : (listed.get(r.id) ?? 0);
    return { ...r, permissions: withRow(r.permissions, row, level) };
  });
}

/** A person's level on a row: an owner's is the highest, anyone else's the most `everyone` or a role of theirs gives. */
const personLevel = (p: Pick<Person, "role" | "roleIds">, roles: readonly OrgRole[], row: string) =>
  p.role === "owner"
    ? rowMax(row)
    : Math.max(
        0,
        ...roles
          .filter((r) => isEveryone(r) || (p.roleIds ?? []).includes(r.id))
          .map((r) => (isAdmin(r) ? rowMax(row) : levelOn(r.permissions, row))),
      );

/**
 * Who a "Quem pode" change takes the row from, or lowers on the computers' ladder, and who it gives it to
 * ("Deixam de poder: Carla, Diego e mais 3."). Owners always can.
 */
export function holdersAfter<P extends Pick<Person, "role" | "roleIds">>(
  people: readonly P[],
  roles: readonly OrgRole[],
  row: string,
  holders: RowHolders,
) {
  const next = withRowHolders(roles, row, holders);
  const losing: P[] = [];
  const gaining: P[] = [];
  for (const p of people) {
    const was = personLevel(p, roles, row);
    const now = personLevel(p, next, row);
    if (now < was) losing.push(p);
    else if (now > was) gaining.push(p);
  }
  return { losing, gaining };
}

/** The rows a role adds: past what `everyone` gives (for `everyone`, every row it holds). */
export const reachRows = (
  role: OrgRole,
  everyone: OrgRole | undefined,
  areas: readonly Pick<PermissionArea, "keys">[],
) =>
  areas.flatMap(areaRows).filter((row) => {
    const s = rowState(role, everyone, row);
    return isEveryone(role) ? s.own > 0 : s.own > s.everyone;
  });

/**
 * What a role adds, for its row in the list and its glance line ("+3 permissões · +2 canais · +1 agente"): its rows
 * past what `everyone` gives (for `everyone`, every row it holds), its channels (those the viewer doesn't see counted
 * too) and its agents. `all`: Administrador, which may everything.
 */
export function reachOf(role: OrgRole, everyone: OrgRole | undefined, areas: readonly Pick<PermissionArea, "keys">[]) {
  return {
    all: isAdmin(role),
    permissions: reachRows(role, everyone, areas).length,
    channels: (role.channelIds?.length ?? 0) + (role.hiddenChannels ?? 0),
    agents: role.agentIds?.length ?? 0,
  };
}

/** The roles a "Quem pode" save writes: the custom ones the viewer may change, Administrador ones aside. */
export const writableRoles = (roles: readonly OrgRole[]) =>
  roles.filter((r) => !isEveryone(r) && r.editable && !isAdmin(r));

/**
 * A "Quem pode" dialog's choice: everyone at `keep` (the row's level, or the computers' step Todos had), or only the
 * ticked roles keep it while `everyone` goes to `low`. `from`: the role the change started on, set to exactly its
 * level (a computers' step picked below Todos'). Every writable role is listed, so none goes to 0 by being left out;
 * an unticked one keeps what it has below `keep`.
 */
export function rowHolders(
  roles: readonly OrgRole[],
  row: string,
  choice: { everyone: boolean; ticked: ReadonlySet<string> },
  step: { keep: number; low: number; from?: { id: string; level: number } },
): RowHolders {
  return {
    everyone: choice.everyone ? step.keep : step.low,
    roles: writableRoles(roles).map((r) => {
      const own = levelOn(r.permissions, row);
      const level = choice.everyone
        ? own
        : choice.ticked.has(r.id)
          ? Math.max(own, step.keep)
          : r.id === step.from?.id
            ? step.from.level
            : Math.max(0, Math.min(own, step.keep - 1));
      return { id: r.id, level };
    }),
  };
}

/**
 * Who a "Quem pode" dialog starts with ticked: `holders`, the writable roles that hold the row at `keep` already;
 * `all`, every writable role; else every writable role but that one (the role it was turned off on).
 */
export function whoStart(
  roles: readonly OrgRole[],
  row: string,
  keep: number,
  start: "holders" | "all" | { but: string },
) {
  const w = writableRoles(roles);
  const picked =
    start === "holders"
      ? w.filter((r) => levelOn(r.permissions, row) >= keep)
      : start === "all"
        ? w
        : w.filter((r) => r.id !== start.but);
  return new Set(picked.map((r) => r.id));
}

/** Whether a "Quem pode" choice changes anything: some role's or `everyone`'s level on the row. */
export function rowChanges(roles: readonly OrgRole[], row: string, holders: RowHolders) {
  const next = withRowHolders(roles, row, holders);
  return roles.some((r, i) => levelOn(r.permissions, row) !== levelOn(next[i]?.permissions ?? [], row));
}

/** Who sees a channel: every member (public), the people of some roles (ADR 0125), or only who is added. */
export type ChannelReach = { kind: "everyone" } | { kind: "roles"; roleIds: string[] } | { kind: "private" };
export const channelReach = (c: { visibility: string; audienceRoleIds?: readonly string[] }): ChannelReach =>
  c.visibility === "public"
    ? { kind: "everyone" }
    : c.audienceRoleIds?.length
      ? { kind: "roles", roleIds: [...c.audienceRoleIds] }
      : { kind: "private" };

/** Whether people with `role` see a channel through it: a public one, or one limited to it (`everyone`: public). */
export const roleSees = (
  role: Pick<OrgRole, "id" | "kind">,
  c: { visibility: string; audienceRoleIds?: readonly string[] },
) => c.visibility === "public" || (!isEveryone(role) && (c.audienceRoleIds ?? []).includes(role.id));

/**
 * Who deleting a role takes out of channels (the server's `dropRoleLeavers`, ADR 0125): the members of a channel
 * limited to it who hold none of its other roles, its creator aside. Only the channels the viewer sees.
 */
export function deleteLeavers<P extends Pick<Person, "userId" | "roleIds">>(
  role: Pick<OrgRole, "id">,
  channels: readonly {
    id: string;
    visibility: string;
    audienceRoleIds?: readonly string[];
    createdByUserId?: string | null;
  }[],
  membersOf: (channelId: string) => readonly string[],
  people: readonly P[],
) {
  const out = new Set<P>();
  for (const c of channels) {
    const ids = c.audienceRoleIds ?? [];
    if (c.visibility !== "private" || !ids.includes(role.id)) continue;
    const kept = ids.filter((id) => id !== role.id);
    const members = new Set(membersOf(c.id));
    for (const p of people) {
      const mine = p.roleIds ?? [];
      if (
        members.has(p.userId) &&
        p.userId !== c.createdByUserId &&
        mine.includes(role.id) &&
        !kept.some((id) => mine.includes(id))
      )
        out.add(p);
    }
  }
  return [...out];
}

/**
 * The cargos' order once `id` moves one place up (`-1`) or down, or null when it can't: the viewer never moves a cargo
 * above one they can't change, so those stay on top in their order. `order` is every custom cargo's id, top first.
 */
export function movedOrder(order: readonly string[], editable: (id: string) => boolean, id: string, by: -1 | 1) {
  const i = order.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return null;
  const next = [...order];
  [next[i], next[j]] = [next[j] as string, next[i] as string];
  return keepsFixedOnTop(next, editable) ? next : null;
}

/** Whether every cargo the viewer can't change still stands above every one they can. */
export function keepsFixedOnTop(order: readonly string[], editable: (id: string) => boolean) {
  const last = order.reduce((at, id, i) => (editable(id) ? at : i), -1);
  return order.every((id, i) => i > last || !editable(id));
}

/** The cargo page's tabs, in order (`?tab=`): `everyone` has no people of its own. */
export type RoleTab = "permissions" | "channels" | "agents" | "people";
export const roleTabs = (role: Pick<OrgRole, "kind">): RoleTab[] =>
  isEveryone(role) ? ["permissions", "channels", "agents"] : ["permissions", "channels", "agents", "people"];
export const isRoleTab = (v: unknown): v is RoleTab =>
  v === "permissions" || v === "channels" || v === "agents" || v === "people";

/** Past this many cargos the list gets a search, and past as many channels, agents or people a tab does. */
export const ROLES_SEARCH_FROM = 8;
/** A workspace's cargos at most (`ROLES_MAX` on the server). */
export const ROLES_MAX = 100;

/**
 * What changing a channel's roles does to people (ADR 0125; `dropRoleLeavers` on the server): `leave`, its members
 * taken out (they hold a role it drops and none it keeps; its creator stays, and going public or invite only takes
 * nobody out); `unsee`, everyone else who saw it and no longer does. Administrators and owners see every channel.
 */
export function channelLeavers<P extends Pick<Person, "userId" | "role" | "roleIds">>(
  channel: { visibility: string; audienceRoleIds?: readonly string[]; createdByUserId?: string | null },
  next: { visibility: string; audienceRoleIds: readonly string[] },
  memberIds: readonly string[],
  people: readonly P[],
  roles: readonly OrgRole[],
) {
  const before = channel.audienceRoleIds ?? [];
  const dropped = before.filter((id) => !next.audienceRoleIds.includes(id));
  const holds = (p: P, ids: readonly string[]) => ids.some((id) => (p.roleIds ?? []).includes(id));
  const admin = (p: P) => p.role === "owner" || roles.some((r) => isAdmin(r) && (p.roleIds ?? []).includes(r.id));
  const sees = (p: P, c: { visibility: string; audienceRoleIds: readonly string[] }) =>
    c.visibility === "public" || admin(p) || (c.visibility === "private" && holds(p, c.audienceRoleIds));
  const members = new Set(memberIds);
  const limited = next.visibility === "private" && next.audienceRoleIds.length > 0;
  return {
    leave: limited
      ? people.filter(
          (p) =>
            members.has(p.userId) &&
            p.userId !== channel.createdByUserId &&
            holds(p, dropped) &&
            !holds(p, next.audienceRoleIds),
        )
      : [],
    unsee: people.filter(
      (p) =>
        !members.has(p.userId) &&
        sees(p, { visibility: channel.visibility, audienceRoleIds: before }) &&
        !sees(p, next),
    ),
  };
}

/** The keys the summary names first: what tells roles apart. */
export const SUMMARY_ORDER: readonly RolePermission[] = [
  "administrator",
  "approve_actions",
  "manage_agents",
  "control_computers",
  "control_browsers",
  "manage_connectors",
  "manage_credentials",
  "manage_members",
  "manage_roles",
  "view_usage",
  "configure",
  "view_audit",
  "manage_billing",
  "create_agents",
  "manage_channels",
  "mention_everyone",
  "manage_routines",
  "review_memory",
  "invite_people",
  "pair_computers",
  "own_computers",
  "own_browsers",
  "talk_to_agents",
  "assign_work",
  "post",
  "create_channels",
  "edit_wiki",
  "upload_files",
];
const ALL_KEYS = SUMMARY_ORDER.filter((k) => k !== "administrator");

export const isEveryone = (r: Pick<OrgRole, "kind">) => r.kind === "everyone";
export const everyoneOf = (roles: readonly OrgRole[]) => roles.find(isEveryone);

/** A role's name on screen: `everyone` is always "Todos". */
export const roleName = (t: TFunction, r: Pick<OrgRole, "kind" | "name">) =>
  isEveryone(r) ? t("rolesPage.everyoneName") : r.name;

/** Top first, `everyone` last. */
export const sortRoles = (roles: readonly OrgRole[]) =>
  [...roles].sort(
    (a, b) =>
      (isEveryone(a) ? 1 : 0) - (isEveryone(b) ? 1 : 0) || a.position - b.position || a.name.localeCompare(b.name),
  );

/** What `everyone` already gives (for a role that isn't it). */
const baseOf = (role: OrgRole, everyone: OrgRole | undefined) =>
  isEveryone(role) || !everyone ? new Set<string>() : grants(everyone.permissions);

/** An area's keys but the computers' (their own choice, `computerLevelOf`). */
const areaKeys = (area: PermissionArea) => area.keys.filter((k) => !COMPUTER_KEYS.includes(k));

/** The area's keys this role reaches, `everyone`'s included. */
export function areaReach(role: OrgRole, area: PermissionArea, everyone: OrgRole | undefined) {
  const own = grants(role.permissions);
  const base = baseOf(role, everyone);
  return areaKeys(area).filter((k) => own.has(k) || base.has(k));
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export function levelOf(role: OrgRole, area: PermissionArea, everyone: OrgRole | undefined): AreaLevel {
  const base = new Set(areaKeys(area).filter((k) => baseOf(role, everyone).has(k)));
  const reach = new Set(areaReach(role, area, everyone));
  if (same(reach, base)) return "none";
  if (same(reach, new Set([...base, ...area.use]))) return "use";
  if (same(reach, new Set(areaKeys(area)))) return "manage";
  return "custom";
}

/** The levels to offer: "use" only when it gives more than `everyone` already does. */
export function levelOptions(role: OrgRole, area: PermissionArea, everyone: OrgRole | undefined): AreaLevel[] {
  const base = baseOf(role, everyone);
  return area.use.some((k) => !base.has(k)) ? ["none", "use", "manage"] : ["none", "manage"];
}

/** The role's keys with the area set to `level` (the rest untouched). */
export function withLevel(role: OrgRole, area: PermissionArea, level: AreaLevel): string[] {
  if (level === "custom") return role.permissions;
  const keys = areaKeys(area);
  const keep = role.permissions.filter((k) => !keys.includes(k));
  const add = level === "use" ? area.use : level === "manage" ? keys : [];
  return [...keep, ...add];
}

/** One key of a role: on, and where it comes from when the role can't turn it off (Administrador or Todos). */
export function keyState(role: OrgRole, everyone: OrgRole | undefined, key: string) {
  const viaAdmin = role.permissions.includes("administrator");
  const viaAll = !isEveryone(role) && !role.permissions.includes(key) && grants(everyone?.permissions ?? []).has(key);
  const from = viaAdmin ? ("admin" as const) : viaAll ? ("everyone" as const) : null;
  return { on: role.permissions.includes(key) || from !== null, from };
}

/** The role's keys with one key on or off. */
export const withKey = (role: OrgRole, key: string, on: boolean) =>
  on ? [...new Set([...role.permissions, key])] : role.permissions.filter((k) => k !== key);

/**
 * What sums a role up, most telling first: its own keys past what `everyone` gives (every key of `everyone` for
 * itself). `administrator` stands alone.
 */
export function summaryKeys(role: OrgRole, everyone: OrgRole | undefined): RolePermission[] {
  if (role.permissions.includes("administrator")) return ["administrator"];
  const base = baseOf(role, everyone);
  const own = new Set(role.permissions);
  return SUMMARY_ORDER.filter((k) => own.has(k) && !base.has(k));
}

/** "a, b e c" in the person's language; the phone's JavaScript engine has no `Intl.ListFormat`. */
const wordList = (t: TFunction, locale: string, items: string[]) =>
  typeof Intl.ListFormat === "function"
    ? new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items)
    : joinNames(items, t);

/** An area's level as said on screen: `everyone`'s lowest is "Nada", any other role's "Como Todos". */
export const levelLabel = (t: TFunction, role: Pick<OrgRole, "kind">, level: AreaLevel) =>
  level === "none" && isEveryone(role) ? t("rolesPage.levels.nothing") : t(`rolesPage.levels.${level}`);

/** The line under an area: what the role reaches there (`everyone`'s included), or all of it as Administrador. */
export function areaLine(t: TFunction, locale: string, role: OrgRole, area: PermissionArea, everyone?: OrgRole) {
  if (!isEveryone(role) && role.permissions.includes("administrator")) return t("rolesPage.viaAdmin");
  const reach = areaReach(role, area, everyone);
  return reach.length
    ? wordList(
        t,
        locale,
        reach.map((k) => t(`permissions.${k as RolePermission}.short`)),
      )
    : t("rolesPage.nothing");
}

/** The sentence that sums a role up: its own keys past what `everyone` gives, the first three, "and N more". */
export function roleSummary(t: TFunction, locale: string, role: OrgRole, everyone: OrgRole | undefined) {
  const keys = summaryKeys(role, everyone);
  if (keys[0] === "administrator") return t("rolesPage.summary.admin");
  const words = keys.slice(0, 3).map((k) => t(`permissions.${k}.say`));
  if (keys.length > 3) words.push(t("rolesPage.summary.more", { count: keys.length - 3 }));
  if (isEveryone(role))
    return keys.length
      ? t("rolesPage.summary.everyone", { list: wordList(t, locale, words) })
      : t("rolesPage.summary.everyoneNone");
  return keys.length ? t("rolesPage.summary.extra", { list: wordList(t, locale, words) }) : t("rolesPage.summary.none");
}

/** A person's rank: their highest role's position (an owner above all, `Infinity` with none). */
export function rankOf(person: Pick<Person, "role" | "roleIds">, roles: readonly OrgRole[]) {
  if (person.role === "owner") return -1;
  const mine = roles.filter((r) => !isEveryone(r) && (person.roleIds ?? []).includes(r.id));
  return mine.length ? Math.min(...mine.map((r) => r.position)) : Number.POSITIVE_INFINITY;
}

/** Whether the viewer may touch this person's roles (the server checks it again): someone below them, or themselves. */
export const isBelow = (
  viewer: { role: string; rank?: number | null; userId: string },
  person: Pick<Person, "userId" | "role" | "roleIds">,
  roles: readonly OrgRole[],
) =>
  viewer.role === "owner" ||
  (person.role !== "owner" &&
    (person.userId === viewer.userId || rankOf(person, roles) > (viewer.rank ?? Number.POSITIVE_INFINITY)));

/**
 * Whether the viewer may remove this person from the workspace (the server checks it again, `removeMember`): who may
 * manage members, above them (an owner above all). Their own row leaves instead (`leaves`).
 */
export const removes = (
  viewer: { role: string; rank?: number | null; userId: string; permissions?: readonly string[] },
  person: Pick<Person, "userId" | "role" | "roleIds">,
  roles: readonly OrgRole[],
) => person.userId !== viewer.userId && can(viewer, "manage_members") && isBelow(viewer, person, roles);

/** Whether the viewer may leave the workspace: anyone but its last owner. */
export const leaves = (viewer: { role: string }, people: readonly Pick<Person, "role">[]) =>
  viewer.role !== "owner" || people.filter((p) => p.role === "owner").length > 1;

/** Whether the viewer holds every key of a role (an owner all): only then may they copy it or give it. */
export function holdsAll(viewer: { role: string; permissions?: readonly string[] }, keys: readonly string[]) {
  if (viewer.role === "owner") return true;
  const mine = grants(viewer.permissions ?? []);
  return keys.every((k) => mine.has(k));
}

/** A person's roles, top first. */
export const rolesOf = (person: Pick<Person, "roleIds">, roles: readonly OrgRole[]) =>
  sortRoles(roles.filter((r) => !isEveryone(r) && (person.roleIds ?? []).includes(r.id)));

/** Who holds a role (`everyone`: everybody). */
export const peopleWith = <P extends Pick<Person, "roleIds">>(role: OrgRole, people: readonly P[]) =>
  isEveryone(role) ? [...people] : people.filter((p) => (p.roleIds ?? []).includes(role.id));

/** Who holds a permission: the owners, and whoever has a role (or the `everyone` base) that grants it. */
export function holdersOf<P extends Pick<Person, "role" | "roleIds">>(
  people: readonly P[],
  roles: readonly OrgRole[],
  permission: RolePermission,
): P[] {
  const granting = roles.filter((r) => grants(r.permissions).has(permission));
  return people.filter(
    (p) => p.role === "owner" || granting.some((r) => isEveryone(r) || (p.roleIds ?? []).includes(r.id)),
  );
}

/** Why the viewer can't change a role (`rolesPage.locked.*`), or null when they can. */
export function roleLock(
  viewer: { role: string; rank?: number | null; permissions?: readonly string[] },
  role: Pick<OrgRole, "editable" | "position">,
): "noPermission" | "own" | "above" | null {
  if (role.editable) return null;
  if (!can(viewer, "manage_roles")) return "noPermission";
  return viewer.role !== "owner" && viewer.rank === role.position ? "own" : "above";
}

/** "Começar de" when creating a role (`rolesPage.templates.*`): each with its keys, icon and color. */
export const ROLE_TEMPLATES: readonly {
  id: "blank" | "mod" | "agents" | "costs";
  keys: RolePermission[];
  icon: string;
  color: string;
}[] = [
  { id: "blank", keys: [], icon: "bolt", color: "graphite" },
  { id: "mod", keys: ["create_channels", "manage_channels"], icon: "flag", color: "teal" },
  {
    id: "agents",
    keys: ["create_agents", "manage_agents", "approve_actions", "manage_routines", "review_memory"],
    icon: "code",
    color: "indigo",
  },
  { id: "costs", keys: ["view_usage", "view_audit"], icon: "chart", color: "amber" },
];

/** What a new role starts from: a template's id, or `copy:<roleId>` for one of `copies`. */
export function newRoleInput(name: string, from: string, copies: readonly OrgRole[]) {
  const copy = from.startsWith("copy:") ? copies.find((r) => `copy:${r.id}` === from) : undefined;
  const tpl = ROLE_TEMPLATES.find((x) => x.id === from);
  return {
    name,
    icon: copy?.icon ?? tpl?.icon,
    color: copy?.color ?? tpl?.color,
    permissions: copy ? copy.permissions : [...(tpl?.keys ?? [])],
  };
}

/** Past this many people to pick from, Adicionar pessoas gets its search. */
export const PEOPLE_SEARCH_FROM = 8;

/** Gives a role to each of `userIds`, one by one, on past a refusal: how many got it, and the first refusal. */
export async function giveRole(
  people: readonly Pick<Person, "userId" | "roleIds">[],
  userIds: readonly string[],
  roleId: string,
  set: (v: { userId: string; roleIds: string[] }) => Promise<unknown>,
) {
  let added = 0;
  let failed: unknown = null;
  for (const userId of userIds) {
    const p = people.find((x) => x.userId === userId);
    if (!p) continue;
    try {
      await set({ userId, roleIds: [...(p.roleIds ?? []), roleId] });
      added++;
    } catch (e) {
      failed ??= e;
    }
  }
  return { added, failed };
}
