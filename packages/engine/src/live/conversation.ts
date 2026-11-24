import { and, type Database, type Executor, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { type ArtifactDeps, fileRefOf, type LiveArtifactKind, liveFileAccess } from "../artifacts";
import { caches } from "../cache";
import { NotFoundError, ValidationError } from "../errors";
import { clockOf } from "../format";
import { quietNoticeSql } from "../notices";
import { fileConversationReaderSql } from "../task-access";
import { neutralizeUntrusted, untrustedBlock } from "../untrusted";
import { isMediaKind, type MediaKind, mediaOfType, talkKindOf } from "./media";

const { artifacts, channels, channelMembers, messages, users, agents } = schema;

/**
 * A file's conversation (ADR 0199; pictures, videos and PDFs too, ADR 0208), the task's (ADR 0145) for a file: a channel of kind `file` of its own, read by
 * whoever reads the file, and one thread in it, whose root (`meta.fileConversation`) stands for the file and is never
 * shown; the conversation is that thread's replies, so posting, mentions, runs, receipts, reactions and the thread's
 * screens are the chat's. A message there may point at what its writer had selected in the file (`meta.liveRef`).
 */
export interface FileConversationMeta {
  artifactId: string;
  kind: string;
  title: string;
}

/** `meta.fileConversation` of a file conversation's root, when it reads right. */
export const fileConversationOf = (meta: Record<string, unknown> | null | undefined): FileConversationMeta | null => {
  const v = meta?.fileConversation as Partial<FileConversationMeta> | undefined;
  if (!v || typeof v.artifactId !== "string" || typeof v.kind !== "string" || typeof v.title !== "string") return null;
  return { artifactId: v.artifactId, kind: v.kind, title: v.title };
};

export interface FileConversationRef {
  channelId: string;
  rootId: string;
}

// ── What a message points at ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What a person had selected in the file when they wrote (`meta.liveRef.selection`), as the apps describe it: a range
 * of a sheet, a slide, canvas shapes, a point on the canvas (a comment pinned there, in world units), a quote of a
 * document and its block; on a picture, a video or a PDF (ADR 0208) a mark (a point or an area, in fractions of the
 * picture, the video's frame or the page), the video's moment, the PDF's page, the version it was made on and the
 * two pictures the app took of it.
 */
export interface LiveAskSelection {
  /** How it reads: "Sheet 1!B2:C9", "slide 3", "2 images". */
  label: string;
  sheet?: string;
  range?: string;
  slide?: string;
  shapes?: string[];
  /** A canvas comment's pin, in world units. */
  point?: { x: number; y: number };
  /** A document's quoted words (at most 200 characters). */
  text?: string;
  /** A document's block id. */
  block?: string;
  /** A point (`w` and `h` absent) or an area of a picture, a video's frame or a PDF's page, in fractions (0 to 1). */
  mark?: { x: number; y: number; w?: number; h?: number };
  /** A video's moment, in seconds. */
  time?: number;
  /** A PDF's page, from 1. */
  page?: number;
  /** The file's version the mark was made on. */
  version?: number;
  /** The app's picture of what was marked, readable size (a picture of the file, `putMarkPicture`). */
  crop?: string;
  /** The app's picture of the whole picture, frame or page with the mark drawn, small. */
  frame?: string;
}

/** The longest video a moment points into: a day. */
const MAX_TIME_S = 86_400;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fraction of a side (0 to 1), rounded to a ten-thousandth; null otherwise. */
const fraction = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? Math.round(value * 10_000) / 10_000
    : null;

/** A mark as stored: a point, or an area inside the picture (a side of zero is a point). */
function cleanMark(raw: unknown): LiveAskSelection["mark"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const x = fraction(m.x);
  const y = fraction(m.y);
  if (x === null || y === null) return undefined;
  const w = fraction(m.w);
  const h = fraction(m.h);
  if (w === null || h === null || w === 0 || h === 0) return { x, y };
  return {
    x,
    y,
    w: Math.min(w, Math.round((1 - x) * 10_000) / 10_000),
    h: Math.min(h, Math.round((1 - y) * 10_000) / 10_000),
  };
}

/** `meta.liveRef`: the file a message is about and what was selected in it. */
export interface LiveRef {
  artifactId: string;
  kind: string;
  title: string;
  selection?: LiveAskSelection;
}

const textOf = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max).trimEnd() : undefined;

/** Ids the editors use (a sheet's, a slide's, a shape's, a block's): plain and short. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A point's coordinate: a finite number within the canvas's reach, rounded to a tenth. */
const coordinate = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e7 ? Math.round(value * 10) / 10 : null;

/** The selection as stored: known fields only, each cut to its size, ids only where ids go. */
export function cleanSelection(raw: LiveAskSelection | undefined): LiveAskSelection | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const label = textOf(raw.label, 200);
  if (!label) return undefined;
  const out: LiveAskSelection = { label };
  const sheet = textOf(raw.sheet, 100);
  const range = textOf(raw.range, 100);
  const slide = textOf(raw.slide, 100);
  if (sheet) out.sheet = sheet;
  if (range) out.range = range;
  if (slide) out.slide = slide;
  const shapes = Array.isArray(raw.shapes)
    ? raw.shapes.filter((s): s is string => typeof s === "string" && ID.test(s)).slice(0, 200)
    : [];
  if (shapes.length > 0) out.shapes = shapes;
  const point = raw.point && typeof raw.point === "object" ? raw.point : null;
  const x = point ? coordinate(point.x) : null;
  const y = point ? coordinate(point.y) : null;
  if (x !== null && y !== null) out.point = { x, y };
  const text = textOf(raw.text, 200);
  if (text) out.text = text;
  if (typeof raw.block === "string" && ID.test(raw.block)) out.block = raw.block;
  const mark = cleanMark(raw.mark);
  if (mark) out.mark = mark;
  if (typeof raw.time === "number" && Number.isFinite(raw.time) && raw.time >= 0 && raw.time <= MAX_TIME_S) {
    out.time = Math.round(raw.time * 10) / 10;
  }
  if (Number.isInteger(raw.page) && (raw.page as number) >= 1 && (raw.page as number) <= 100_000) out.page = raw.page;
  if (Number.isInteger(raw.version) && (raw.version as number) >= 1) out.version = raw.version;
  if (typeof raw.crop === "string" && UUID_ID.test(raw.crop)) out.crop = raw.crop.toLowerCase();
  if (typeof raw.frame === "string" && UUID_ID.test(raw.frame)) out.frame = raw.frame.toLowerCase();
  return out;
}

/** A comment that points at a place in a picture, a video or a PDF (ADR 0208): it has a pin there. */
export const isPinned = (s: LiveAskSelection | undefined) =>
  Boolean(s && (s.mark || s.time !== undefined || s.page !== undefined));

/** `meta.liveRef` when it reads right (what the apps and the agent's context read of it); null otherwise. */
export function liveRefOf(meta: Record<string, unknown> | null | undefined): LiveRef | null {
  const raw = meta?.liveRef as Partial<LiveRef> | undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.artifactId !== "string" || typeof raw.kind !== "string") return null;
  const selection = cleanSelection(raw.selection);
  return {
    artifactId: raw.artifactId,
    kind: raw.kind,
    title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "",
    ...(selection ? { selection } : {}),
  };
}

/**
 * The `meta.liveRef` of a person's message in a file's conversation: the conversation's own file (any other is
 * refused, `message.live_ref`), its kind and title as stored now, and the selection cleaned.
 */
export async function liveRefFor(
  db: Executor,
  orgId: string,
  channelId: string,
  raw: { artifactId: string; selection?: LiveAskSelection },
): Promise<LiveRef> {
  const file = await fileOfConversation(db, orgId, channelId);
  if (!file || file.id !== raw.artifactId) {
    throw new ValidationError("A message can only point at its own conversation's file", "message.live_ref");
  }
  const selection = cleanSelection(raw.selection);
  const kind = (await talkKindOf(db, file)) ?? file.kind;
  return { artifactId: file.id, kind, title: file.title, ...(selection ? { selection } : {}) };
}

/** A file in words, as the agent reads it. */
const KIND_WORD: Record<string, string> = {
  spreadsheet: "spreadsheet",
  slides: "presentation",
  canvas: "canvas",
  document: "document",
  image: "image",
  video: "video",
  pdf: "PDF",
};
/** The tools that read and change each kind (the agent's own, ADR 0196 §6). */
const KIND_TOOLS: Record<string, { read: string; edit: string }> = {
  spreadsheet: { read: "read_spreadsheet", edit: "edit_spreadsheet" },
  slides: { read: "read_presentation", edit: "edit_presentation" },
  canvas: { read: "read_canvas", edit: "edit_canvas" },
  document: { read: "read_document", edit: "edit_document" },
};
const kindWord = (kind: string) => KIND_WORD[kind] ?? "file";
/** A fraction as a percentage, as the agent reads a mark. */
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** Where a comment points in a picture, a video or a PDF, in the agent's words (ADR 0208). */
export function markWords(kind: string, s: LiveAskSelection): string {
  const where = kind === "pdf" ? "of the page" : kind === "video" ? "of the frame" : "of the picture";
  const m = s.mark;
  const mark = !m
    ? ""
    : m.w !== undefined && m.h !== undefined
      ? `an area ${where} from ${pct(m.x)} to ${pct(m.x + m.w)} across and ${pct(m.y)} to ${pct(m.y + m.h)} down`
      : `a point ${where} at ${pct(m.x)} across and ${pct(m.y)} down`;
  return [
    s.page !== undefined ? `page ${s.page}` : "",
    s.time !== undefined ? `the moment ${clockOf(s.time)}` : "",
    mark,
    s.version !== undefined ? `on version ${s.version}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
/** A sheet's or a slide's id, or an A1 range (`$B$2:C9`), as written; anything else undefined. */
const placeWord = (value: string | undefined) => (value && /^[A-Za-z0-9_$:-]{1,100}$/.test(value) ? value : undefined);
/** A file's title as the agent reads it: people write it, so neutralized as other titles are (`neutralizeUntrusted`). */
const titleWords = (title: string) =>
  neutralizeUntrusted(
    title
      .replace(/["\s]+/g, " ")
      .trim()
      .slice(0, 120),
  ) || "untitled";

/**
 * What a message points at in its file, as the agent reads it under the message (`attachedLine`): the file and what
 * was selected. A document's quoted words are the file's content, so they come as outside text (`untrustedBlock`).
 */
export function liveRefLine(meta: Record<string, unknown> | null | undefined): string {
  const ref = liveRefOf(meta);
  if (!ref) return "";
  const file = `the ${kindWord(ref.kind)} "${titleWords(ref.title)}" (artifact ${ref.artifactId})`;
  const s = ref.selection;
  if (!s) return `\n(about ${file})`;
  // A client writes these: outside the block only when they read as an id or an A1 range, so no words of theirs pass
  // for the server's own (the label, outside text, still says the place).
  const range = placeWord(s.range);
  const sheet = placeWord(s.sheet);
  const slide = placeWord(s.slide);
  const parts = [
    range ? `range ${range}${sheet ? ` of sheet id ${sheet}` : ""}` : sheet ? `sheet id ${sheet}` : "",
    slide ? `slide id ${slide}` : "",
    s.shapes?.length ? `shapes ${s.shapes.slice(0, 20).join(", ")}` : "",
    s.point ? `a comment pinned at x ${s.point.x}, y ${s.point.y}` : "",
    s.block ? `block ${s.block}` : "",
    isMediaKind(ref.kind) && isPinned(s) ? markWords(ref.kind, s) : "",
  ].filter(Boolean);
  const label = untrustedBlock("what the person selected, as their app names it", s.label, 200);
  const quote = s.text ? `\nThe words they selected:\n${untrustedBlock("the file's words", s.text, 200)}` : "";
  // The app's pictures of the place: the agent sees them with one call, as it sees a file (ADR 0208).
  const pictures =
    s.crop || s.frame
      ? `\nTo see the place they marked, call look_at_comment with comment "${s.crop ?? s.frame}".`
      : "";
  return `\n(about what they selected in ${file}${parts.length ? `: ${parts.join("; ")}` : ""})\n${label}${quote}${pictures}`;
}

// ── The conversation ─────────────────────────────────────────────────────────────────────────────────────────────────

type FileRow = Pick<
  typeof artifacts.$inferSelect,
  | "id"
  | "orgId"
  | "kind"
  | "title"
  | "channelId"
  | "threadId"
  | "createdByType"
  | "createdById"
  | "deletedAt"
  | "currentVersion"
>;

/** The live file whose conversation `channelId` is, or null for any other channel. */
export async function fileOfConversation(db: Executor, orgId: string, channelId: string): Promise<FileRow | null> {
  const [row] = await db
    .select({
      id: artifacts.id,
      orgId: artifacts.orgId,
      kind: artifacts.kind,
      title: artifacts.title,
      channelId: artifacts.channelId,
      threadId: artifacts.threadId,
      createdByType: artifacts.createdByType,
      createdById: artifacts.createdById,
      deletedAt: artifacts.deletedAt,
      currentVersion: artifacts.currentVersion,
    })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.conversationChannelId, channelId)));
  return row ?? null;
}

/**
 * The file's conversation, made on first use: its channel, the root and the agent that made the file as a member.
 * Taken under the file's row lock, so two first uses make one. Only a live file, a picture, a video or a PDF has one.
 */
export async function ensureFileConversation(db: Database, artifactId: string): Promise<FileConversationRef> {
  return db.transaction(async (tx) => {
    const [file] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).for("update");
    if (!file) throw new NotFoundError("Artifact not found", "artifact.not_found");
    if (file.conversationChannelId && file.conversationRootId) {
      return { channelId: file.conversationChannelId, rootId: file.conversationRootId };
    }
    const kind = await talkKindOf(tx, file);
    if (!kind) {
      throw new ValidationError(
        "Only a live file, a picture, a video or a PDF has a conversation of its own",
        "artifact.no_conversation",
      );
    }
    // The maker's account may be gone (deleted): the root and the channel then have no author.
    const creator = file.createdByType === "person" ? await liveUser(tx, file.createdById) : null;
    const [channel] = await tx
      .insert(channels)
      .values({
        orgId: file.orgId,
        // Internal (never listed): unique per workspace.
        name: `file-${file.id}`,
        kind: "file",
        visibility: "private",
        createdByUserId: creator,
      })
      .returning({ id: channels.id });
    if (!channel) throw new Error("channel insert returned nothing");
    // Written directly: the root is never shown, indexed, routed or notified.
    const maker = file.createdByType === "agent" ? await liveAgent(tx, file.createdById) : null;
    const [root] = await tx
      .insert(messages)
      .values({
        createdAt: file.createdAt,
        orgId: file.orgId,
        channelId: channel.id,
        authorType: maker ? "agent" : "person",
        authorUserId: creator,
        authorAgentId: maker,
        body: `File: ${file.title}`.slice(0, 2_000),
        meta: { fileConversation: { artifactId: file.id, kind, title: file.title } },
      })
      .returning({ id: messages.id });
    if (!root) throw new Error("root insert returned nothing");
    await tx
      .update(artifacts)
      .set({ conversationChannelId: channel.id, conversationRootId: root.id })
      .where(eq(artifacts.id, file.id));
    // The agent that made the file is there from the start, to be named and to answer.
    await admitFileAgents(tx, file.orgId, channel.id, { maker: true });
    return { channelId: channel.id, rootId: root.id };
  });
}

async function liveUser(tx: Executor, userId: string) {
  const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return u?.id ?? null;
}

async function liveAgent(tx: Executor, agentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const [a] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
  return a?.id ?? null;
}

/**
 * The file's conversation for a person who reads the file, made on first use (opening it). Not found for a file
 * they don't read (or one in the trash); refused for a file of a kind with no conversation.
 */
export async function openFileConversation(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
): Promise<FileConversationRef> {
  const access = await liveFileAccess(deps, { type: "person", userId }, orgId, artifactId);
  if (!access) {
    const ref = await fileRefOf(deps.db, userId, orgId, artifactId);
    if (!ref) throw new NotFoundError("Artifact not found", "artifact.not_found");
    // A picture, a video or a PDF (ADR 0208): whoever reads it talks about it, as a live file's readers do.
    if (ref.artifactKind !== "file" || !mediaOfType(ref.contentType)) {
      throw new ValidationError(
        "Only a live file, a picture, a video or a PDF has a conversation of its own",
        "artifact.no_conversation",
      );
    }
    const [row] = await deps.db
      .select({ deletedAt: artifacts.deletedAt })
      .from(artifacts)
      .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, artifactId)));
    if (!row || row.deletedAt) throw new NotFoundError("Artifact not found", "artifact.not_found");
    return ensureFileConversation(deps.db, artifactId);
  }
  if (access.artifact.deletedAt) throw new NotFoundError("Artifact not found", "artifact.not_found");
  return ensureFileConversation(deps.db, artifactId);
}

/**
 * Agents join a file's conversation as members (so a mention there reaches them like anywhere else) when they may
 * work on the file: the agent that made it (`maker`), by id (the server's own choice), and by current handle (a
 * person's or an agent's mention) when the file is where the agent is too: the Drive itself or shared past its
 * conversation (who mentioned it reads it, and an agent reaches what they reach; a Drive file not shared with
 * everyone is its maker's, who asks, ADR 0157 amendment 2026-11-17), or a conversation the agent is in or a public
 * channel. Mirrors `admitTaskAgents`. Returns the agents added now.
 */
export async function admitFileAgents(
  db: Executor,
  orgId: string,
  channelId: string,
  who: { handles?: string[]; ids?: string[]; maker?: boolean },
): Promise<string[]> {
  const handles = (who.handles ?? []).filter((h) => /^[a-z0-9_-]+$/.test(h));
  const ids = (who.ids ?? []).filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  const maker = who.maker === true;
  if (handles.length === 0 && ids.length === 0 && !maker) return [];
  const rows = rowsOf<{ agent_id: string }>(
    await db.execute(sql`insert into ${channelMembers} (org_id, channel_id, agent_id)
      select a.org_id, ${channelId}::uuid, a.id from ${agents} a
      join ${artifacts} f on f.conversation_channel_id = ${channelId}::uuid and f.org_id = a.org_id
      where a.org_id = ${orgId}::uuid and a.archived_at is null and a.deleted_at is null
        and (a.id = any(${`{${ids.join(",")}}`}::uuid[])
          or (${maker}::boolean and f.created_by_type = 'agent' and f.created_by_id = a.id::text)
          or (a.handle = any(${`{${handles.join(",")}}`}::text[]) and (f.channel_id is null or f.share <> 'conversation'
            or exists (select 1 from ${channelMembers} am where am.channel_id = f.channel_id and am.agent_id = a.id)
            or exists (select 1 from ${channels} ac where ac.id = f.channel_id and ac.visibility = 'public'
              and ac.kind = 'channel'))))
      on conflict do nothing
      returning agent_id`),
  );
  if (rows.length > 0) caches.channelMembers.delete(`${orgId}:${channelId}`);
  // Its search reaches the conversation it's in now (`agentSearchChannels`).
  for (const r of rows) caches.scopes.deletePrefix(`${orgId}:${r.agent_id}:visible`);
  return rows.map((r) => r.agent_id);
}

/** Of `userIds`, who reads the conversation `channelId` of a live file now (`fileConversationReaderSql`). */
export async function fileReadersAmong(db: Executor, channelId: string, userIds: readonly string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`select u.id from ${users} u where u.id = any(${`{${ids.join(",")}}`}::text[])
      and ${fileConversationReaderSql(sql`${channelId}::uuid`, sql`u.id`)}`),
  );
  return rows.map((r) => r.id);
}

// ── What the file's page shows of it ─────────────────────────────────────────────────────────────────────────────────

/** What a file's page and card show of its conversation: its replies, who took part, an agent at work now. */
export interface FileConversationSummary extends FileConversationRef {
  count: number;
  lastAt: string | null;
  /** The first ones to write, oldest first (at most 5). */
  participants: { type: "person" | "agent"; id: string }[];
  working: boolean;
}

const LIVE_RUN = sql`('queued', 'running', 'waiting_approval', 'waiting_input')`;

/** The conversations of these files that have one, in one query (a page of the Drive), by file id. */
export async function fileConversationSummaries(
  db: Executor,
  orgId: string,
  artifactIds: readonly string[],
): Promise<Map<string, FileConversationSummary>> {
  const out = new Map<string, FileConversationSummary>();
  const ids = [...new Set(artifactIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (ids.length === 0) return out;
  const shown = sql`m.org_id = f.org_id and m.channel_id = f.conversation_channel_id
    and m.thread_id = f.conversation_root_id and m.deleted_at is null and not ${quietNoticeSql(sql`m.meta`)}`;
  const found = rowsOf<{
    id: string;
    channel_id: string;
    root_id: string;
    count: number | string;
    last_at: Date | string | null;
    participants: { type: "person" | "agent"; id: string }[] | string | null;
    working: boolean | string;
  }>(
    await db.execute(sql`select f.id, f.conversation_channel_id as channel_id, f.conversation_root_id as root_id,
        s.count, s.last_at,
        (select coalesce(json_agg(json_build_object('type', p.author_type, 'id', p.who) order by p.first), '[]')
          from (select m.author_type, coalesce(m.author_user_id, m.author_agent_id::text) as who,
              min(m.created_at) as first
            from ${messages} m where ${shown} and coalesce(m.author_user_id, m.author_agent_id::text) is not null
            group by 1, 2 order by min(m.created_at) limit 5) p) as participants,
        exists (select 1 from ${schema.agentRuns} r where r.org_id = f.org_id
          and r.channel_id = f.conversation_channel_id and r.status in ${LIVE_RUN}) as working
      from ${artifacts} f
      cross join lateral (select count(*)::int as count, max(m.created_at) as last_at from ${messages} m
        where ${shown}) s
      where f.org_id = ${orgId}::uuid and f.id = any(${`{${ids.join(",")}}`}::uuid[])
        and f.conversation_channel_id is not null and f.conversation_root_id is not null`),
  );
  for (const r of found) {
    out.set(r.id, {
      channelId: r.channel_id,
      rootId: r.root_id,
      count: Number(r.count),
      lastAt: r.last_at === null ? null : new Date(r.last_at).toISOString(),
      participants: typeof r.participants === "string" ? JSON.parse(r.participants) : (r.participants ?? []),
      working: r.working === true || r.working === "t",
    });
  }
  return out;
}

// ── The agent's context ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The block a run in a file's conversation gets (ADR 0199): the file in focus, read from the artifact now, and that
 * its tools act on it without an id. What each message points at comes under it (`liveRefLine`).
 */
export async function fileConversationBrief(
  db: Executor,
  orgId: string,
  rootMeta: Record<string, unknown> | null | undefined,
  agentId: string,
): Promise<string | null> {
  const ref = fileConversationOf(rootMeta);
  if (!ref) return null;
  const [file] = await db
    .select({
      id: artifacts.id,
      kind: artifacts.kind,
      title: artifacts.title,
      createdByType: artifacts.createdByType,
      createdById: artifacts.createdById,
      deletedAt: artifacts.deletedAt,
    })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, ref.artifactId)));
  if (!file) return null;
  const mine = file.createdByType === "agent" && file.createdById === agentId;
  if (isMediaKind(ref.kind)) return mediaBrief(ref.kind, file, mine);
  const word = kindWord(file.kind);
  const tools = KIND_TOOLS[file.kind];
  return [
    `# This conversation: the ${word} "${titleWords(file.title)}"`,
    `This is the conversation of the live ${word} "${titleWords(file.title)}" (artifact ${file.id}), the file in focus here${mine ? ", which you made" : ""}. Everyone who reads the file reads and writes here, and your replies land here, next to the file.`,
    file.deletedAt
      ? "The file is in the Drive's trash now: say so if asked to change it; a person can restore it."
      : tools
        ? `Read it with \`${tools.read}\` before you answer about it, and change it with \`${tools.edit}\`: here both act on this file when you name no other. People see your changes as you make them.`
        : "",
    'A message may say what its writer had selected in the file ("about what they selected"): that is what it is about.',
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The brief of a picture's, a video's or a PDF's conversation (ADR 0208): the file, how to see it, and the comments
 * that point at a place in it (a numbered pin), which the agent sees, makes and resolves with its own tools.
 */
function mediaBrief(
  kind: MediaKind,
  file: { id: string; title: string; deletedAt: Date | null },
  mine: boolean,
): string {
  const word = kindWord(kind);
  const title = titleWords(file.title);
  const place =
    kind === "image"
      ? "an area or a point of it"
      : kind === "video"
        ? "a moment of it (and maybe an area of that frame)"
        : "a page of it (and maybe an area of that page)";
  return [
    `# This conversation: the ${word} "${title}"`,
    `This is the conversation of the ${word} "${title}" (artifact ${file.id}), the file in focus here${mine ? ", which you made" : ""}. Everyone who reads the file reads and writes here, and your replies land here, next to the file.`,
    file.deletedAt
      ? "The file is in the Drive's trash now: say so if asked about it; a person can restore it."
      : kind === "video"
        ? "No AI here watches videos: what you see of it is what people mark (the frame at that moment, with `look_at_comment`)."
        : `See the whole ${word} with \`read_artifact\`.`,
    `People comment on ${place}: each such comment has a numbered pin on the file, and its message says where it points. \`look_at_comment\` shows you the pictures their app took of that place (what they marked, and the whole with the mark drawn): look before you answer about it.`,
    `To point at a place yourself, use \`comment_on_file\`: it posts your words with a pin there, as your answer. When what a comment asked is done, mark it with \`resolve_comment\` (its pin leaves the file; the comment stays here).`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The live file of the conversation a run is in, for its tools' default (ADR 0199): null outside one. */
export async function conversationFileId(
  db: Executor,
  orgId: string,
  channelId: string,
  kind?: LiveArtifactKind,
): Promise<string | null> {
  const file = await fileOfConversation(db, orgId, channelId);
  if (!file || file.deletedAt || (kind && file.kind !== kind)) return null;
  return file.id;
}
