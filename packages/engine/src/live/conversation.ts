import { and, type Database, type Executor, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { type ArtifactDeps, fileRefOf, isLiveArtifactKind, type LiveArtifactKind, liveFileAccess } from "../artifacts";
import { caches } from "../cache";
import { NotFoundError, ValidationError } from "../errors";
import { quietNoticeSql } from "../notices";
import { fileConversationReaderSql } from "../task-access";
import { neutralizeUntrusted, untrustedBlock } from "../untrusted";

const { artifacts, channels, channelMembers, messages, users, agents } = schema;

/**
 * A live file's conversation (ADR 0199), the task's (ADR 0145) for a file: a channel of kind `file` of its own, read by
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
 * document and its block.
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
  return out;
}

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
  return { artifactId: file.id, kind: file.kind, title: file.title, ...(selection ? { selection } : {}) };
}

/** A live file in words, as the agent reads it. */
const KIND_WORD: Record<string, string> = {
  spreadsheet: "spreadsheet",
  slides: "presentation",
  canvas: "canvas",
  document: "document",
};
/** The tools that read and change each kind (the agent's own, ADR 0196 §6). */
const KIND_TOOLS: Record<string, { read: string; edit: string }> = {
  spreadsheet: { read: "read_spreadsheet", edit: "edit_spreadsheet" },
  slides: { read: "read_presentation", edit: "edit_presentation" },
  canvas: { read: "read_canvas", edit: "edit_canvas" },
  document: { read: "read_document", edit: "edit_document" },
};
const kindWord = (kind: string) => KIND_WORD[kind] ?? "file";
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
  ].filter(Boolean);
  const label = untrustedBlock("what the person selected, as their app names it", s.label, 200);
  const quote = s.text ? `\nThe words they selected:\n${untrustedBlock("the file's words", s.text, 200)}` : "";
  return `\n(about what they selected in ${file}${parts.length ? `: ${parts.join("; ")}` : ""})\n${label}${quote}`;
}

// ── The conversation ─────────────────────────────────────────────────────────────────────────────────────────────────

type FileRow = Pick<
  typeof artifacts.$inferSelect,
  "id" | "orgId" | "kind" | "title" | "channelId" | "threadId" | "createdByType" | "createdById" | "deletedAt"
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
    })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.conversationChannelId, channelId)));
  return row ?? null;
}

/**
 * The file's conversation, made on first use: its channel, the root and the agent that made the file as a member.
 * Taken under the file's row lock, so two first uses make one. Only a live file has one.
 */
export async function ensureFileConversation(db: Database, artifactId: string): Promise<FileConversationRef> {
  return db.transaction(async (tx) => {
    const [file] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).for("update");
    if (!file) throw new NotFoundError("Artifact not found", "artifact.not_found");
    if (file.conversationChannelId && file.conversationRootId) {
      return { channelId: file.conversationChannelId, rootId: file.conversationRootId };
    }
    if (!isLiveArtifactKind(file.kind)) {
      throw new ValidationError("Only a live file has a conversation of its own", "artifact.no_conversation");
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
        meta: { fileConversation: { artifactId: file.id, kind: file.kind, title: file.title } },
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
    if (await fileRefOf(deps.db, userId, orgId, artifactId)) {
      throw new ValidationError("Only a live file has a conversation of its own", "artifact.no_conversation");
    }
    throw new NotFoundError("Artifact not found", "artifact.not_found");
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
  const word = kindWord(file.kind);
  const tools = KIND_TOOLS[file.kind];
  const mine = file.createdByType === "agent" && file.createdById === agentId;
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
