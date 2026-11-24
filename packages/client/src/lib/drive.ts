import type { Artifact, ArtifactKind, DriveFolder } from "../api/types";
import { ARTIFACT_KINDS } from "./artifacts";
import { daysBetween } from "./format";
import type { OpenTarget } from "./notifications";

/** The Drive's arrangement. */
export type DriveView = "grid" | "list";
export type DriveWho = "all" | "agents" | "people";
export type DriveGroup = "date" | "channel" | "author" | "none";
export type DriveSort = "recent" | "name" | "kind";

export const DRIVE_GROUPS: DriveGroup[] = ["date", "channel", "author", "none"];
export const DRIVE_SORTS: DriveSort[] = ["recent", "name", "kind"];

export const isDriveView = (v: unknown): v is DriveView => v === "grid" || v === "list";

/** Made by an agent, by a person, or anyone. */
export const byWho = (a: Pick<Artifact, "createdBy">, who: DriveWho) =>
  who === "all" || a.createdBy.type === (who === "agents" ? "agent" : "person");

const newest = (a: Artifact, b: Artifact) => b.updatedAt.localeCompare(a.updatedAt);

export function sortArtifacts(list: Artifact[], sort: DriveSort, locale: string): Artifact[] {
  const kindOrder = (k: ArtifactKind) => ARTIFACT_KINDS.indexOf(k);
  return [...list].sort(
    sort === "name"
      ? (a, b) => a.title.localeCompare(b.title, locale, { sensitivity: "base" }) || newest(a, b)
      : sort === "kind"
        ? (a, b) => kindOrder(a.kind) - kindOrder(b.kind) || newest(a, b)
        : newest,
  );
}

/** "today", "week" (the last 7 days) or "earlier", by the last update. */
export function dateBucket(iso: string, now = new Date()): "today" | "week" | "earlier" {
  const days = daysBetween(iso, now);
  return days <= 0 ? "today" : days < 7 ? "week" : "earlier";
}

export interface DriveSection {
  /** "" without groups; a date bucket; a channel id ("" = no channel); "agent:id" / "person:id". */
  key: string;
  items: Artifact[];
}

/** Sections in a stable order: dates newest first, the rest as they first appear in the (sorted) list. */
export function groupArtifacts(list: Artifact[], group: DriveGroup, now = new Date()): DriveSection[] {
  if (group === "none") return list.length ? [{ key: "", items: list }] : [];
  const keyOf = (a: Artifact) =>
    group === "date"
      ? dateBucket(a.updatedAt, now)
      : group === "channel"
        ? (a.channelId ?? "")
        : `${a.createdBy.type}:${a.createdBy.id}`;
  const map = new Map<string, Artifact[]>();
  for (const a of list) {
    const k = keyOf(a);
    const items = map.get(k);
    if (items) items.push(a);
    else map.set(k, [a]);
  }
  const order = group === "date" ? ["today", "week", "earlier"] : [...map.keys()];
  return order.filter((k) => map.has(k)).map((key) => ({ key, items: map.get(key) ?? [] }));
}

/** The Drive's section of files only some people see: a DM's sides, a private channel's members, a Drive file's maker. */
export const PRIVATE_SECTION = "private";

/**
 * Where a file lives isn't open to the whole workspace, so its sharing has something to add (ADR 0157): a DM, a
 * private channel, or the Drive itself, where a file lives with its maker (amendment 2026-11-17).
 */
export const livesInPrivate = (audience: Artifact["audience"]) =>
  audience.kind === "dm" || audience.kind === "workspace" || (audience.kind === "channel" && audience.private);

/**
 * Not open to the whole workspace: from a DM or a private channel (ADR 0111), or a file of the Drive itself, unless
 * shared with everyone (ADR 0157). A Drive file from a server that sends no sharing is the workspace's, as it was.
 */
export const isPrivateArtifact = (a: Pick<Artifact, "audience"> & Partial<Pick<Artifact, "sharing">>) =>
  livesInPrivate(a.audience) &&
  (a.audience.kind !== "workspace" || a.sharing !== undefined) &&
  a.sharing?.mode !== "everyone";

/**
 * Only the private conversation it lives in sees it, or only its maker a file of the Drive itself (ADR 0157): a link
 * to it opens for nobody else, so copying one goes through the share dialog, which says so.
 */
export const onlyItsConversation = (a: Pick<Artifact, "audience" | "sharing">) =>
  isPrivateArtifact(a) && (a.sharing?.mode ?? "conversation") === "conversation";

/** `groupArtifacts` over the files the team can see, then the private ones in a section of their own, last. */
export function driveSections(list: Artifact[], group: DriveGroup, now = new Date()): DriveSection[] {
  const own = list.filter(isPrivateArtifact);
  const sections = groupArtifacts(
    list.filter((a) => !isPrivateArtifact(a)),
    group,
    now,
  );
  return own.length ? [...sections, { key: PRIVATE_SECTION, items: own }] : sections;
}

/**
 * Where "Abrir na conversa" goes: its thread, else its DM (by the other side) or channel. Null for a file
 * of no conversation, one shared with me from a conversation I don't read (ADR 0157), or a DM whose other side is
 * gone (missing, an archived agent, a person who left).
 */
export function artifactPlace(a: Pick<Artifact, "channelId" | "threadId" | "audience">): OpenTarget | null {
  if (!a.channelId) return null;
  const aud = a.audience;
  if ((aud.kind === "channel" && aud.outside) || (aud.kind === "dm" && aud.between)) return null;
  if (a.threadId) return { to: "/org/$orgId/threads/$threadId", params: { threadId: a.threadId } };
  if (a.audience.kind !== "dm") return { to: "/org/$orgId/c/$channelId", params: { channelId: a.channelId } };
  const other = a.audience.with;
  if (!other || a.audience.gone) return null;
  return other.type === "agent"
    ? { to: "/org/$orgId/dm/agent/$agentId", params: { agentId: other.id } }
    : { to: "/org/$orgId/dm/person/$userId", params: { userId: other.id } };
}

/** Shift-click: everything between the last clicked item and this one (inclusive), in the shown order. */
export function rangeOf(ids: string[], anchor: string | null, target: string): string[] {
  const from = anchor ? ids.indexOf(anchor) : -1;
  const to = ids.indexOf(target);
  if (to < 0) return [];
  if (from < 0) return [target];
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Whole days left before the trash purges it (0 once it's due). */
export const daysLeft = (purgeAt: string, now = new Date()) =>
  Math.max(0, Math.ceil((new Date(purgeAt).getTime() - now.getTime()) / 86_400_000));

/** The Drive's folders by parent ("" = the top level), each list by name. */
export function folderChildren(folders: DriveFolder[]): Map<string, DriveFolder[]> {
  const map = new Map<string, DriveFolder[]>();
  for (const f of folders) {
    const key = f.parentId ?? "";
    const list = map.get(key);
    if (list) list.push(f);
    else map.set(key, [f]);
  }
  return map;
}

/** From the top level down to this folder (empty at the top level, or when it's gone). */
export function folderTrail(folders: DriveFolder[], id: string | null): DriveFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: DriveFolder[] = [];
  let at = id ? byId.get(id) : undefined;
  // Bounded: a loop in bad data never hangs the page.
  while (at && trail.length <= folders.length) {
    trail.unshift(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return trail;
}

/** This folder and every folder inside it: where a folder can't be moved to. */
export function folderAndInside(folders: DriveFolder[], id: string): Set<string> {
  const children = folderChildren(folders);
  const out = new Set<string>();
  const walk = (at: string) => {
    if (out.has(at)) return;
    out.add(at);
    for (const c of children.get(at) ?? []) walk(c.id);
  };
  walk(id);
  return out;
}

/** Every folder as a flat tree for a picker: depth-first, each with its depth. */
export function folderOutline(folders: DriveFolder[]): { folder: DriveFolder; depth: number }[] {
  const children = folderChildren(folders);
  const out: { folder: DriveFolder; depth: number }[] = [];
  const walk = (parent: string, depth: number) => {
    for (const f of children.get(parent) ?? []) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** The drag of Drive items between folders (web): its data type, and what it carries. */
export const DRIVE_DRAG_TYPE = "application/x-agentes-drive";
export interface DriveDrag {
  files: string[];
  folders: string[];
}

/** What a drag between folders carries, or null for anything else (files from the computer, text). */
export function parseDriveDrag(raw: string | undefined | null): DriveDrag | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DriveDrag>;
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
    const drag = { files: ids(v.files), folders: ids(v.folders) };
    return drag.files.length + drag.folders.length > 0 ? drag : null;
  } catch {
    return null;
  }
}
