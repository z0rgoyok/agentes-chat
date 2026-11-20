import type {
  Agent,
  BatchInviteResult,
  Channel,
  InvitationWithStatus,
  InviteLink,
  InviteLinkChoices,
  InviteLinkTtl,
  JoinRequest,
  Member,
  OrgRole,
  Person,
} from "@agenteschat/client";
import {
  daysBetween,
  formatInt,
  formatShortDate,
  joinNames,
  lowerFirst,
  namesText,
  relativeTime,
  timeLeft,
} from "@agenteschat/client/lib/format";
import {
  changedLists,
  INVITE_LINK_TTL,
  type InviteAgentCase,
  type InviteLists,
  type InviteStart,
  inviteAgentCase,
  invitePickable,
  inviteStart,
  type LinkChoices,
} from "@agenteschat/client/lib/invite-start";
import { askedLabel } from "@agenteschat/client/lib/join-requests";
import { personalHelperRole, personalRoleKey } from "@agenteschat/client/lib/personal-view";
import { everyoneOf, grants, isEveryone, rolesOf, sortRoles } from "@agenteschat/client/lib/roles";
import { addressesIn } from "@agenteschat/client/lib/text";
import { matchesWords } from "@agenteschat/ui/search";
import type { TFunction } from "i18next";
import { channelGroups, channelMatches } from "../roles/logic";
import type { InviteDraft } from "./draft";

/** "agora", "há 2 h", "ontem", "em 22 out": when something happened, to follow a verb. */
export function whenWords(t: TFunction, locale: string, iso: string, now = new Date()) {
  if (daysBetween(iso, now) > 1) return t("members.when.on", { date: formatShortDate(locale, iso) });
  return relativeTime(t, locale, iso, now);
}

/**
 * A request to join's chips, as on the web: "Not verified" only where nobody proved the address (a server without
 * email, or a request typed before codes), then when it was asked. A server from before codes sends only
 * `confirmed`, which meant the same there. A member's suggestion says who made it instead: nobody at that address
 * asked, and approving it sends the email invitation, so its address has nothing to prove here (ADR 0090 §7). An
 * outside collaborator's request says who they work for (ADR 0191).
 */
export function requestChips(
  t: TFunction,
  locale: string,
  r: Pick<JoinRequest, "createdAt" | "verified" | "confirmed" | "suggestedBy" | "outsideOf">,
  now = new Date(),
): { unverified: string | null; asked: string } {
  const by = r.suggestedBy ?? null;
  const when = whenWords(t, locale, r.createdAt, now);
  return {
    unverified: by || (r.verified ?? r.confirmed) ? null : t("members.requests.unverified"),
    asked: r.outsideOf
      ? t("members.requests.outside", { outsideOf: r.outsideOf, when })
      : by
        ? t("members.requests.suggested", { name: by, when })
        : askedLabel(t, locale, r.createdAt, now),
  };
}

/** A waiting request's line on Membros: how it came, the address, and that nobody proved it. */
export function waitingLine(
  t: TFunction,
  locale: string,
  r: Pick<JoinRequest, "email" | "createdAt" | "verified" | "confirmed" | "suggestedBy" | "outsideOf">,
  now = new Date(),
) {
  const when = whenWords(t, locale, r.createdAt, now);
  const how = r.outsideOf
    ? t("members.requests.outside", { outsideOf: r.outsideOf, when })
    : r.suggestedBy
      ? t("members.requests.suggested", { name: r.suggestedBy, when })
      : t("members.requests.viaLink", { when });
  const { unverified } = requestChips(t, locale, r, now);
  return [how, r.email, unverified ? lowerFirst(unverified, locale) : null].filter(Boolean).join(" · ");
}

/** The tapped request on top of the review, the others as they came. */
export function focusedFirst<R extends { id: string }>(requests: readonly R[], focus: string | undefined): R[] {
  return [...requests].sort((a, b) => (a.id === focus ? 0 : 1) - (b.id === focus ? 0 : 1));
}

/** One name order per language, made once: `localeCompare` with a language builds a collator on every comparison. */
const nameOrders = new Map<string, Intl.Collator>();
const nameOrder = (locale?: string): Intl.Collator => {
  const key = locale ?? "";
  let order = nameOrders.get(key);
  if (!order) {
    order = new Intl.Collator(locale, { sensitivity: "base" });
    nameOrders.set(key, order);
  }
  return order;
};

/** The people of the workspace as Membros lists them: by name, in the person's language's order. */
export function membersByName<M extends { name: string }>(members: readonly M[], locale?: string): M[] {
  const order = nameOrder(locale);
  return [...members].sort((a, b) => order.compare(a.name, b.name));
}

/**
 * A person's roles on Membros (ADR 0085): "Dono" first for an owner, then their roles top first, joined; nothing for
 * someone with no role (what everyone may do goes without saying).
 */
export function roleLine(
  t: TFunction,
  person: Pick<Member, "role" | "roleIds">,
  roles: readonly OrgRole[],
): string | undefined {
  const names = [...(person.role === "owner" ? [t("roles.owner")] : []), ...rolesOf(person, roles).map((r) => r.name)];
  return names.length > 0 ? names.join(" · ") : undefined;
}

/** A person's line on Membros: their @handle, their roles ("Membro" with none), then when they were last here. */
export function memberLine(
  t: TFunction,
  locale: string,
  person: Pick<Person, "role" | "roleIds" | "online" | "lastSeenAt" | "joinedAt"> & { handle?: string },
  roles: readonly OrgRole[],
  now = new Date(),
) {
  const handle = person.handle ? `@${person.handle} · ` : "";
  const seen = person.online
    ? t("members.activeNow")
    : person.lastSeenAt
      ? t("members.seen", { when: relativeTime(t, locale, person.lastSeenAt, now) })
      : t("members.joined", { when: formatShortDate(locale, person.joinedAt) });
  return `${handle}${roleLine(t, person, roles) ?? t("roles.member")} · ${lowerFirst(seen, locale)}`;
}

/** An outside collaborator's line on Membros (ADR 0191): "Outside · Northwind"; null for anyone else. */
export const outsideLine = (t: TFunction, person: Pick<Person, "outsideOf">) =>
  person.outsideOf ? `${t("members.outside.chip")} · ${person.outsideOf}` : null;

/**
 * What a person's row offers in its menu, in order: a message to anyone but oneself, their cargos when the viewer may
 * give one (P11, "Cargos de Carla"), then removing them (or leaving, on one's own row) when the viewer may. Empty: the
 * row has no menu.
 */
export function memberActions(
  mine: boolean,
  removable: boolean,
  cargos = false,
): ("dm" | "roles" | "remove" | "leave")[] {
  return [
    ...(mine ? [] : (["dm"] as const)),
    ...(cargos ? (["roles"] as const) : []),
    ...(removable ? ([mine ? "leave" : "remove"] as const) : []),
  ];
}

/** The people who may invite here (ADR 0085): the owners, and whoever holds a role that gives it. */
export function invitersOf(people: readonly Pick<Person, "name" | "role" | "roleIds">[], roles: readonly OrgRole[]) {
  return people
    .filter((p) => p.role === "owner" || rolesOf(p, roles).some((r) => grants(r.permissions).has("invite_people")))
    .map((p) => p.name);
}

/** The invitations that still work, the newest first; past its date one no longer opens, whatever the list says. */
export function pendingInvitations<I extends Pick<InvitationWithStatus, "status" | "expiresAt" | "createdAt">>(
  invitations: readonly I[],
  now = new Date(),
): I[] {
  return invitations
    .filter((i) => i.status === "pending" && new Date(i.expiresAt).getTime() > now.getTime())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The names of an invitation's roles ("Admin, Financeiro"), "Membro" with none. */
export function invitationRoles(
  t: TFunction,
  invitation: Pick<InvitationWithStatus, "role" | "roleIds">,
  roles: readonly OrgRole[],
) {
  if (invitation.role === "owner") return t("roles.owner");
  const names = roles.filter((r) => (invitation.roleIds ?? []).includes(r.id)).map((r) => r.name);
  return names.length > 0 ? names.join(", ") : t("roles.member");
}

/** Who sent an invitation, for its sheet: "convite seu" for the person looking. */
export function invitationSender(
  t: TFunction,
  invitation: Pick<InvitationWithStatus, "invitedBy">,
  me: string | null | undefined,
) {
  if (!invitation.invitedBy) return null;
  return invitation.invitedBy === me
    ? t("members.invitations.mine")
    : t("members.invitations.by", { name: invitation.invitedBy });
}

/** An invitation that no longer opens: the list says so, or its date passed. */
export const invitationExpired = (
  invitation: Pick<InvitationWithStatus, "expiresAt"> & { status?: InvitationWithStatus["status"] },
  now = new Date(),
) => invitation.status === "expired" || new Date(invitation.expiresAt).getTime() <= now.getTime();

/** A sent invitation's line: its roles, who sent it (on its sheet), then when it stops working or when it did. */
export function invitationLine(
  t: TFunction,
  locale: string,
  invitation: Pick<InvitationWithStatus, "role" | "roleIds" | "expiresAt"> & {
    status?: InvitationWithStatus["status"];
  },
  roles: readonly OrgRole[],
  extra: { resentUntil?: string | undefined; sender?: string | null | undefined } = {},
  now = new Date(),
) {
  const state = extra.resentUntil
    ? t("members.invitations.resentState", { date: formatShortDate(locale, extra.resentUntil) })
    : invitationExpired(invitation, now)
      ? t("members.invitations.expired", { when: whenWords(t, locale, invitation.expiresAt, now) })
      : t("members.invitations.expires", { left: timeLeft(t, invitation.expiresAt, now) ?? "" });
  return [invitationRoles(t, invitation, roles), extra.sender, lowerFirst(state, locale)].filter(Boolean).join(" · ");
}

/** Convites por e-mail: every invitation still listed, working or expired, the newest first. */
export const listedInvitations = <I extends Pick<InvitationWithStatus, "createdAt">>(invitations: readonly I[]): I[] =>
  [...invitations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/**
 * The keys of what a sent invitation's actions say: a server that sends no email sends nothing again, the same link
 * for longer. One sent before links lasted gets a new link instead, and its old one stops opening (ADR 0090).
 */
export const sentWords = (emails: boolean) =>
  emails
    ? ({ copied: "copied", resent: "resent", newLink: "newLink" } as const)
    : ({ copied: "copiedNoEmail", resent: "resentNoEmail", newLink: "newLinkNoEmail" } as const);

/**
 * The cargos an invitation gives, in Convidar pessoas' words: their names, or Membro with none. A personal workspace
 * says its two plain choices instead (ADR 0159 §4, `personalRoleKey`): "Usa os agentes" for none (or only cargos no
 * longer there) and "Ajuda a cuidar daqui" for its helper role; any other cargo still by its name.
 */
export function cargoWords(t: TFunction, roles: readonly OrgRole[], roleIds: readonly string[], personal: boolean) {
  const picked = sortRoles(roles.filter((r) => roleIds.includes(r.id)));
  if (picked.length === 0) return personal ? t("members.dialog.role.uses") : t("roles.member");
  return joinNames(
    picked.map((r) => {
      const plain = personal ? personalRoleKey(roles, r.id) : null;
      return plain ? t(plain) : r.name;
    }),
    t,
  );
}

/** An address on Convidar pessoas: what was typed, and whether it reads as an e-mail. */
export interface InviteAddress {
  email: string;
  valid: boolean;
}

/** The addresses with the new ones in `text` after them, once each, read the way mail apps and spreadsheets paste them. */
export function withAddresses(addresses: readonly InviteAddress[], text: string): InviteAddress[] {
  const seen = new Set(addresses.map((a) => a.email));
  return [...addresses, ...addressesIn(text).filter((a) => !seen.has(a.email))];
}

// ── What someone gets on joining (ADR 0184) ────────────────────────────────

/**
 * A form's start from what a link, an invitation or a request already gives: its cargos, and the channels and agents
 * past those cargos' own as `added`, the cargos' own it leaves out as `removed`, so `inviteStart` gives them back.
 */
export function draftFrom(
  roles: readonly Pick<OrgRole, "id" | "channelIds" | "agentIds">[],
  given: { roleIds?: readonly string[]; channelIds?: readonly string[]; agentIds?: readonly string[] },
): Pick<InviteDraft, "roleIds" | "added" | "removed"> {
  const roleIds = [...(given.roleIds ?? [])];
  const own = inviteStart(roles, roleIds, NO_START, NO_START);
  const channelIds = given.channelIds ?? [];
  const agentIds = given.agentIds ?? [];
  return {
    roleIds,
    added: {
      channelIds: channelIds.filter((id) => !own.channelIds.includes(id)),
      agentIds: agentIds.filter((id) => !own.agentIds.includes(id)),
    },
    removed: {
      channelIds: own.channelIds.filter((id) => !channelIds.includes(id)),
      agentIds: own.agentIds.filter((id) => !agentIds.includes(id)),
    },
  };
}

const NO_START: InviteStart = { channelIds: [], agentIds: [] };

/** The channels and agents a form starts someone with: its cargos' own, then the added, less the removed. */
export const startOf = (
  roles: readonly Pick<OrgRole, "id" | "channelIds" | "agentIds">[],
  d: Pick<InviteDraft, "roleIds" | "added" | "removed">,
) => inviteStart(roles, d.roleIds, d.added, d.removed);

/** A form's link choices (Link mode, Editar link). */
export function linkChoicesOf(
  roles: readonly Pick<OrgRole, "id" | "channelIds" | "agentIds">[],
  d: InviteDraft,
): LinkChoices {
  return { roleIds: d.roleIds, ...startOf(roles, d), expiresIn: d.expiresIn ?? INVITE_LINK_TTL, maxUses: d.maxUses };
}

/**
 * The workspace's own link as listed, its address known: the one renewing it gives back (the newest), at the same
 * address, so Link mode shows it while it is renewed. One past its date since the list was read would come back as a
 * new address, so it isn't. A link from a server without `plain` is one.
 */
export const listedPlainLink = (links: readonly InviteLink[] | undefined, now = new Date()) =>
  links?.find(
    (l): l is InviteLink & { url: string } =>
      l.plain !== false && Boolean(l.url) && new Date(l.expiresAt).getTime() > now.getTime(),
  );

/**
 * Taking one channel or agent in or out of a form: one of its cargos' own goes to `removed` and comes back from it;
 * any other is `added` or dropped from it, and leaves `removed` (a cargo since dropped may have put it there).
 */
export function flipStart(
  roles: readonly Pick<OrgRole, "id" | "channelIds" | "agentIds">[],
  d: Pick<InviteDraft, "roleIds" | "added" | "removed">,
  kind: keyof InviteStart,
  id: string,
): Pick<InviteDraft, "added" | "removed"> {
  const own = inviteStart(roles, d.roleIds, NO_START, NO_START)[kind].includes(id);
  const on = startOf(roles, d)[kind].includes(id);
  const without = (ids: readonly string[]) => ids.filter((x) => x !== id);
  if (own)
    return {
      added: d.added,
      removed: { ...d.removed, [kind]: on ? [...d.removed[kind], id] : without(d.removed[kind]) },
    };
  return {
    removed: { ...d.removed, [kind]: without(d.removed[kind]) },
    added: { ...d.added, [kind]: on ? without(d.added[kind]) : [...without(d.added[kind]), id] },
  };
}

/**
 * Editar link's changes: the lists that changed (`changedLists`), then the maximum and a new Validade (null keeps its
 * own date).
 */
export function linkChanges(
  link: Pick<InviteLink, "roleIds" | "channelIds" | "agentIds" | "maxUses" | "neverExpires">,
  after: InviteLists,
  draft: Pick<InviteDraft, "expiresIn" | "maxUses">,
): InviteLinkChoices {
  return {
    ...changedLists(link, after),
    ...(draft.maxUses === (link.maxUses ?? null) ? {} : { maxUses: draft.maxUses }),
    // A link that never ends, left at "Não expira", keeps its own date too.
    ...(draft.expiresIn === null || (link.neverExpires === true && draft.expiresIn === "never")
      ? {}
      : { expiresIn: draft.expiresIn }),
  };
}

/** "Validade"'s words for a choice ("30 dias", "Não expira"). */
export const ttlWord = (t: TFunction, ttl: InviteLinkTtl) => t(`invites.ttl.${ttl}`);

/** "Máximo de pessoas"'s words for a choice ("10 pessoas", "Sem limite"). */
export const maxWord = (t: TFunction, max: number | null) =>
  max === null ? t("invites.noLimit") : t("invites.people", { count: max });

/** What a link, an invitation or a request gives past #general and the right hand: "Suporte · #suporte · Max". */
export function givesLine(
  t: TFunction,
  known: {
    roles: readonly OrgRole[];
    channels: readonly Pick<Channel, "id" | "name">[];
    agents: readonly Pick<Agent, "id" | "name">[];
  },
  given: { roleIds?: readonly string[]; channelIds?: readonly string[]; agentIds?: readonly string[] },
): string[] {
  const roles = sortRoles(known.roles.filter((r) => (given.roleIds ?? []).includes(r.id))).map((r) => r.name);
  const channels = (given.channelIds ?? []).flatMap((id) => {
    const c = known.channels.find((x) => x.id === id);
    return c ? [`#${c.name}`] : [];
  });
  const agents = (given.agentIds ?? []).flatMap((id) => known.agents.find((a) => a.id === id)?.name ?? []);
  return [
    roles.length ? namesText(t, roles, 2) : "",
    channels.length ? namesText(t, channels, 2) : "",
    agents.length ? namesText(t, agents, 2) : "",
  ].filter(Boolean);
}

/** A link's name on Convites: its cargos, or Membro with none. */
export const linkTitle = (t: TFunction, roles: readonly OrgRole[], link: Pick<InviteLink, "roleIds">) =>
  cargoWords(t, roles, link.roleIds ?? [], false);

/**
 * A link's state on Convites, as the web's row says it: the people it took ("0 de 1 pessoa", "4 pessoas entraram"),
 * when it ends ("expira em 6 dias", "não expira") and who made it when that isn't the viewer ("de Ana").
 */
export function linkLine(
  t: TFunction,
  locale: string,
  link: Pick<InviteLink, "uses" | "maxUses" | "expiresAt" | "neverExpires" | "createdBy" | "createdByUserId">,
  meId: string | null | undefined,
  now = new Date(),
) {
  const uses = link.uses ?? 0;
  const took =
    link.maxUses != null
      ? t("invites.usesOf", { uses: formatInt(locale, uses), count: link.maxUses })
      : t("invites.joined", { count: uses });
  const ends = link.neverExpires
    ? t("invites.ttl.never")
    : t("members.invitations.expires", { left: timeLeft(t, link.expiresAt, now) ?? "" });
  const by = link.createdBy && link.createdByUserId !== meId ? t("invites.by", { name: link.createdBy }) : null;
  return [took, lowerFirst(ends, locale), by].filter(Boolean).join(" · ");
}

/**
 * A row of the Cargo choice: "Membro" (no cargo past Todos) first, then each cargo this person may give, top first.
 * A cargo `held` that they can't give (someone higher's choice, on a link or an invitation) is listed too, marked, to
 * take out and never to tick again, as the web's menu. `held`: the cargos as the choice opened, so one taken out keeps
 * its place until it closes.
 */
export function cargoPicks(
  t: TFunction,
  roles: readonly OrgRole[],
  roleIds: readonly string[],
  personal: boolean,
  held: readonly string[] = [],
): { id: string | null; label: string; on: boolean; above?: boolean; sub?: string; disabled?: boolean }[] {
  const helper = personal ? personalHelperRole(roles) : null;
  const listed = sortRoles(roles.filter((r) => !isEveryone(r) && (r.givable || held.includes(r.id))));
  return [
    { id: null, label: personal ? t("members.dialog.role.uses") : t("roles.member"), on: roleIds.length === 0 },
    ...[...(helper ? [helper] : []), ...listed.filter((r) => r.id !== helper?.id)].map((r) => ({
      id: r.id,
      label: r.id === helper?.id ? t("members.dialog.role.helps") : r.name,
      on: roleIds.includes(r.id),
      ...(r.givable || r.id === helper?.id
        ? {}
        : { above: true, sub: t("rolesPage.aboveYou"), disabled: !roleIds.includes(r.id) }),
    })),
  ];
}

/** "Do cargo Suporte", "Dos cargos Suporte e Financeiro": the group of what the picked cargos bring. */
export function fromCargosTitle(t: TFunction, roles: readonly OrgRole[], roleIds: readonly string[]) {
  const names = sortRoles(roles.filter((r) => roleIds.includes(r.id))).map((r) => r.name);
  return t("invites.groupRole", { count: names.length, roles: joinNames(names, t) });
}

export interface ChannelPick {
  channel: Pick<Channel, "id" | "name" | "visibility">;
  on: boolean;
  /** #general: everyone joins it, ticked and fixed. */
  fixed: boolean;
  sub?: string;
}

/**
 * Canais' groups: what the picked cargos bring first ("Do cargo Suporte"), then the rest in the sidebar's categories
 * and order, #general on top, ticked and fixed. On offer, as the server takes them: the public channels, the private
 * ones the viewer is in, and those limited to a picked cargo. A search keeps the ones it names, and a group left
 * without any goes.
 */
export function channelPicks(
  t: TFunction,
  args: {
    channels: readonly Pick<
      Channel,
      "id" | "name" | "visibility" | "isMember" | "audienceRoleIds" | "categoryId" | "position"
    >[];
    categories: readonly { id: string; name: string }[];
    roles: readonly OrgRole[];
    draft: Pick<InviteDraft, "roleIds" | "added" | "removed">;
    query?: string;
  },
): { title: string | null; picks: ChannelPick[] }[] {
  const { roles, draft } = args;
  const picked = roles.filter((r) => draft.roleIds.includes(r.id));
  const viaCargo = (c: Pick<Channel, "audienceRoleIds">) => picked.find((r) => c.audienceRoleIds?.includes(r.id));
  const offered = args.channels.filter(
    (c) =>
      (c.name === "general" || c.visibility === "public" || c.isMember || viaCargo(c)) &&
      channelMatches(c.name, args.query ?? ""),
  );
  const own = inviteStart(roles, draft.roleIds, NO_START, NO_START).channelIds;
  const on = startOf(roles, draft).channelIds;
  const pick = (c: (typeof offered)[number]): ChannelPick => {
    const general = c.name === "general";
    const cargo = c.visibility === "private" && !c.isMember ? viaCargo(c) : undefined;
    const sub = general
      ? t("invites.general", { channel: c.name })
      : cargo
        ? t("invites.agent.byRole", { role: cargo.name })
        : c.visibility === "private"
          ? t("members.dialog.where.private")
          : undefined;
    return { channel: c, on: general || on.includes(c.id), fixed: general, ...(sub ? { sub } : {}) };
  };
  const mine = offered.filter((c) => own.includes(c.id));
  const rest = offered.filter((c) => !own.includes(c.id));
  return [
    ...(mine.length ? [{ title: fromCargosTitle(t, roles, draft.roleIds), picks: mine.map(pick) }] : []),
    ...channelGroups(rest, args.categories).map((g) => ({ title: g.name, picks: g.channels.map(pick) })),
  ];
}

export interface AgentPick {
  agent: Agent;
  case: InviteAgentCase;
  sub: string;
  on: boolean;
  /** Can't be ticked here (its row says why), or its mailboxes are still being asked. */
  disabled: boolean;
  /** Its row opens a page instead: the agent's (its mailboxes), or its plan's "Atende outras pessoas". */
  opens?: "agent" | "plan";
}

/** Whether an agent's name or função has every word of a search (Agentes, as the web's cargo Agentes). */
export const agentMatches = (a: Pick<Agent, "name" | "role">, query: string) =>
  matchesWords(`${a.name} ${a.role}`, query);

/**
 * Agentes' rows, the server's cases (`inviteAgentCase`): what the picked cargos bring first, then the team's, each
 * saying how it would go. One already in the form can always come out. A search keeps the ones it names.
 */
export function agentPicks(
  t: TFunction,
  args: {
    agents: readonly Agent[];
    viewer: { userId: string };
    roles: readonly OrgRole[];
    draft: Pick<InviteDraft, "roleIds" | "added" | "removed">;
    ownerName: (userId: string | null) => string | null;
    /** Whose mailboxes opening it would take; undefined while that is being asked. */
    mailboxOwners: (agentId: string) => readonly string[] | undefined;
    query?: string;
  },
): { fromCargo: AgentPick[]; others: AgentPick[] } {
  const { roles, draft, viewer } = args;
  const own = inviteStart(roles, draft.roleIds, NO_START, NO_START).agentIds;
  const on = startOf(roles, draft).agentIds;
  const picked = sortRoles(roles.filter((r) => draft.roleIds.includes(r.id)));
  const pick = (a: Agent): AgentPick => {
    const owners = args.mailboxOwners(a.id);
    const kind = inviteAgentCase(a, viewer, own, owners ?? []);
    const owner = args.ownerName(a.ownerUserId);
    const sub =
      kind === "everyone"
        ? a.role
        : kind === "cargo"
          ? t("invites.agent.byRole", { role: picked.find((r) => r.agentIds?.includes(a.id))?.name ?? "" })
          : kind === "opens"
            ? t("invites.agent.opens")
            : kind === "mailbox"
              ? t("invites.agent.mailbox", { names: joinNames([...(owners ?? [])], t) })
              : kind === "plan" && a.ownerUserId === viewer.userId
                ? t("invites.agent.planMine")
                : owner
                  ? t(kind === "plan" ? "invites.agent.plan" : "invites.agent.locked", { name: owner })
                  : t("invites.agent.lockedNoOwner");
    const isOn = on.includes(a.id);
    const waiting = kind === "opens" && owners === undefined;
    const opens =
      kind === "mailbox" ? "agent" : kind === "plan" && a.ownerUserId === viewer.userId ? "plan" : undefined;
    return {
      agent: a,
      case: kind,
      sub,
      on: isOn,
      disabled: !isOn && (!invitePickable(kind) || waiting) && !opens,
      ...(opens && !isOn ? { opens } : {}),
    };
  };
  const listed = args.agents
    .filter((a) => agentMatches(a, args.query ?? ""))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    fromCargo: listed.filter((a) => own.includes(a.id)).map(pick),
    others: listed.filter((a) => !own.includes(a.id)).map(pick),
  };
}

/** Whether Agentes asks whose mailboxes an agent holds: restricted, not a picked cargo's, and the viewer's to open. */
export const asksMailboxes = (a: Agent, viewer: { userId: string }, cargoAgentIds: readonly string[]) =>
  inviteAgentCase(a, viewer, cargoAgentIds) === "opens";

/**
 * The lines under Agentes: a person who won't talk to agents (neither Todos nor a picked cargo lets them, the field
 * goes off), a picked Administrador sees them all, and the restricted agents that start answering them.
 */
export function agentLines(
  t: TFunction,
  args: {
    roles: readonly OrgRole[];
    roleIds: readonly string[];
    agents: readonly Agent[];
    agentIds: readonly string[];
    viewer: { userId: string };
  },
): { off: boolean; lines: string[] } {
  const everyone = everyoneOf(args.roles);
  // Every workspace has Todos: none means the cargos are still loading, and nothing is said yet.
  if (!everyone) return { off: false, lines: [] };
  const picked = sortRoles(args.roles.filter((r) => args.roleIds.includes(r.id)));
  const talks = [everyone, ...picked].some((r) => grants(r.permissions).has("talk_to_agents"));
  if (!talks) return { off: true, lines: [t("invites.noTalk")] };
  const admin = picked.find((r) => r.permissions.includes("administrator"));
  const own = inviteStart(args.roles, args.roleIds, NO_START, NO_START).agentIds;
  const opened = args.agentIds.flatMap((id) => {
    const a = args.agents.find((x) => x.id === id);
    return a && inviteAgentCase(a, args.viewer, own) === "opens" ? [a.name] : [];
  });
  return {
    off: false,
    lines: [
      ...(admin ? [t("invites.admin", { role: admin.name })] : []),
      ...(opened.length ? [t("invites.opens", { count: opened.length, names: joinNames(opened, t) })] : []),
    ],
  };
}

/**
 * A waiting request's line on Convites: how it came ("Pediu pelo link de Paula há 3 h", "Bruno sugeriu ontem"), then
 * what its link gives ("Suporte · #suporte · Max").
 */
export function requestLine(
  t: TFunction,
  locale: string,
  r: Pick<JoinRequest, "createdAt" | "suggestedBy" | "link" | "outsideOf">,
  gives: readonly string[],
  now = new Date(),
) {
  const when = whenWords(t, locale, r.createdAt, now);
  const how = r.outsideOf
    ? t("members.requests.outside", { outsideOf: r.outsideOf, when })
    : r.suggestedBy
      ? t("members.requests.suggested", { name: r.suggestedBy, when })
      : r.link?.createdBy
        ? t("invites.viaLinkOf", { name: r.link.createdBy, when })
        : t("members.requests.viaLink", { when });
  return [how, ...gives].join(" · ");
}

/**
 * What the field holds after a change (the phone has no paste event, so a paste shows as many characters at once
 * that make a list): a paste or a separator typed at the end hands all of it to `withAddresses`.
 */
export function readTyped(before: string, after: string): { add: string; keep: string } {
  if (!after.replace(/[\s,;]/g, "")) return { add: "", keep: "" };
  const pasted = after.length - before.length > 1 && /[\s,;<]/.test(after.trim());
  return pasted || /[\s,;]$/.test(after) ? { add: after, keep: "" } : { add: "", keep: after };
}

/** What becomes of an address: goes out, needs fixing, or is left out for being in or invited already. */
export function addressState(
  address: Pick<InviteAddress, "email" | "valid">,
  members: ReadonlySet<string>,
  invited: ReadonlySet<string>,
): "ok" | "bad" | "member" | "invited" {
  if (!address.valid) return "bad";
  return members.has(address.email) ? "member" : invited.has(address.email) ? "invited" : "ok";
}

/** Who stays after sending: only addresses to fix (someone in or invited already was just said). */
export function addressesLeft(addresses: readonly InviteAddress[], results: readonly BatchInviteResult[]) {
  const fix = new Set(results.filter((r) => r.status === "invalid_email").map((r) => r.email));
  return addresses.filter((a) => !a.valid || fix.has(a.email));
}

/** The one toast of a batch (the phone shows one at a time): what went out, then whatever was refused and why. */
export function batchNews(
  t: TFunction,
  results: readonly BatchInviteResult[],
  channels: readonly string[],
): { title: string; subtitle?: string; failed: boolean } | null {
  const sent = results.filter((r) => r.status === "invited");
  const refused = results
    .filter((r) => r.status !== "invited")
    .map((r) => t(`members.batch.${r.status}`, { email: r.email }));
  const names = namesText(t, [...channels], channels.length);
  const also = channels.length > 0 ? t("members.dialog.alsoIn", { channels: names }) : null;
  const first = sent[0];
  const [title, ...rest] = first
    ? [
        sent.length === 1
          ? t("members.dialog.sent", { email: first.email })
          : t("members.dialog.sentMany", { count: sent.length }),
        ...(also ? [also] : []),
        ...refused,
      ]
    : refused;
  if (!title) return null;
  return { title, ...(rest.length > 0 ? { subtitle: rest.join(" ") } : {}), failed: !first };
}

/** The channels they can be added to, as on the web: the public ones and the private ones I'm in; #general always. */
export function offeredChannels<C extends Pick<Channel, "id" | "name" | "visibility" | "isMember">>(
  channels: readonly C[],
) {
  const general = channels.find((c) => c.name === "general");
  return {
    general,
    others: channels.filter((c) => c.id !== general?.id && (c.visibility === "public" || c.isMember)),
  };
}

/** What a suggestion's refusal says, about the person suggested (the server's codes, ADR 0090 §7). */
export function suggestRefusal(code: string | null | undefined) {
  return SUGGEST_REFUSALS[code ?? ""];
}

const SUGGEST_REFUSALS: Record<string, "member" | "invited" | "waiting" | "full" | "invalid" | undefined> = {
  "join.member": "member",
  "join.invited": "invited",
  "join.waiting": "waiting",
  "join.full": "full",
  "join.invalid_email": "invalid",
};
