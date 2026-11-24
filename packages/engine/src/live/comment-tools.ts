import { randomUUID } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { and, asc, eq, isNull, schema } from "@agenteschat/db";
import type { ToolImage } from "@agenteschat/providers";
import type { ArtifactActor, ArtifactDeps } from "../artifacts";
import { getChannelCached } from "../context";
import { publishMessageCreated } from "../events";
import type { Judge } from "../judge";
import { insertMessage, messageView } from "../messages";
import { replyThreadOf } from "../runs";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { untrustedBlock } from "../untrusted";
import { getAsset, readPictureFile } from "./assets";
import {
  cleanSelection,
  fileOfConversation,
  isPinned,
  type LiveAskSelection,
  liveRefOf,
  markWords,
} from "./conversation";
import { type MediaKind, mediaKindOf } from "./media";
import { resolveComment, resolvedOf } from "./resolve";

const { messages } = schema;

/**
 * An agent's tools in a picture's, a video's or a PDF's conversation (ADR 0208): `look_at_comment` (the pictures the
 * app took of the place a comment points at), `comment_on_file` (the agent's own comment with a pin, posted as its
 * answer) and `resolve_comment`. Listed only in such a conversation, for a run there.
 */

export const LOOK_AT_COMMENT = "look_at_comment";
export const COMMENT_ON_FILE = "comment_on_file";
export const RESOLVE_COMMENT = "resolve_comment";

export interface CommentToolDeps {
  artifacts: ArtifactDeps;
  pubsub?: PubSub;
  /** Finds where a target is in a picture (`box`); null or failing: the agent gives the place itself. */
  judge?: Judge | null;
}

type ConversationFile = { id: string; title: string; kind: MediaKind; currentVersion: number };

const actorOf = (ctx: ToolContext): Extract<ArtifactActor, { type: "agent" }> => ({
  type: "agent",
  agentId: ctx.agentId,
  channelId: ctx.channelId,
  threadId: replyThreadOf(ctx),
  runId: ctx.runId,
});

const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** A comment with a pin in this conversation, numbered as the apps number its pins: oldest first, from 1. */
interface PinnedComment {
  n: number;
  id: string;
  authorType: string;
  body: string;
  selection: LiveAskSelection;
  resolved: boolean;
}

/** The conversation's comments with a pin, oldest first (the apps' numbers). */
async function pinnedComments(ctx: ToolContext, file: ConversationFile): Promise<PinnedComment[]> {
  const rows = await ctx.db
    .select({ id: messages.id, authorType: messages.authorType, body: messages.body, meta: messages.meta })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, ctx.orgId),
        eq(messages.channelId, ctx.channelId),
        eq(messages.threadId, ctx.threadRootId),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const out: PinnedComment[] = [];
  for (const r of rows) {
    const ref = liveRefOf(r.meta);
    if (!ref || ref.artifactId !== file.id || !ref.selection || !isPinned(ref.selection)) continue;
    out.push({
      n: out.length + 1,
      id: r.id,
      authorType: r.authorType,
      body: r.body,
      selection: ref.selection,
      resolved: resolvedOf(r.meta) !== null,
    });
  }
  return out;
}

/** The comment `which` names: its number ("4"), or one of the ids its line gives (a picture's). */
function findComment(list: PinnedComment[], which: unknown): PinnedComment | null {
  const v = typeof which === "number" ? String(which) : typeof which === "string" ? which.trim().replace(/^#/, "") : "";
  if (!v) return null;
  if (/^\d{1,5}$/.test(v)) return list.find((c) => c.n === Number(v)) ?? null;
  const id = v.toLowerCase();
  return list.find((c) => c.id === id || c.selection.crop === id || c.selection.frame === id) ?? null;
}

/** A picture of the file's as the model takes it, or null when it is gone. */
async function pictureOf(deps: CommentToolDeps, ctx: ToolContext, fileId: string, assetId: string) {
  const found = await getAsset(deps.artifacts, actorOf(ctx), ctx.orgId, fileId, assetId).catch(() => null);
  if (!found) return null;
  const bytes = "bytes" in found ? found.bytes : new Uint8Array(await new Response(found.stream).arrayBuffer());
  return { mediaType: found.contentType, data: Buffer.from(bytes).toString("base64") } satisfies ToolImage;
}

function lookTool(deps: CommentToolDeps, file: ConversationFile): ToolDefinition {
  return {
    name: LOOK_AT_COMMENT,
    description: `See the place a comment on this ${file.kind === "pdf" ? "PDF" : file.kind} points at: the pictures the person's app took of it (what they marked, and the whole ${file.kind === "image" ? "picture" : file.kind === "video" ? "frame at that moment" : "page"} with the mark drawn), where it is, and its words. \`comment\` is the comment's number (its pin's) or the id its line gives. Look before you answer about a comment.`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        comment: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: 'The comment\'s number ("4") or the id its line gives.',
        },
      },
      required: ["comment"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title: "Look at a comment",
      detail: typeof input.comment === "string" ? input.comment : undefined,
    }),
    async execute(input, ctx) {
      try {
        const list = await pinnedComments(ctx, file);
        const c = findComment(list, input.comment);
        if (!c) {
          return {
            content: list.length
              ? `No such comment here. The comments with a pin are numbered 1 to ${list.length}.`
              : "No comment here points at a place in the file yet.",
            isError: true,
          };
        }
        const ids = [c.selection.crop, c.selection.frame].filter((v): v is string => Boolean(v));
        const images = (await Promise.all(ids.map((id) => pictureOf(deps, ctx, file.id, id)))).filter(
          (v): v is ToolImage => v !== null,
        );
        const where = markWords(file.kind, c.selection);
        const newer = c.selection.version !== undefined && c.selection.version < file.currentVersion;
        const lines = [
          `Comment ${c.n}${c.resolved ? " (resolved)" : ""}, by ${c.authorType === "agent" ? "an agent" : "a person"}: ${where || "the whole file"}.`,
          newer
            ? `It was made on version ${c.selection.version}; the file is at version ${file.currentVersion} now.`
            : "",
          images.length === 0
            ? "Their app sent no pictures of it: read the file itself to see the place."
            : images.length === 2
              ? "The first picture is what they marked; the second, the whole with the mark drawn."
              : "The picture is what they marked.",
          untrustedBlock("the comment's words", c.body, 2_000),
        ].filter(Boolean);
        return { content: lines.join("\n"), images };
      } catch (error) {
        return failed(error);
      }
    },
  };
}

/** Where a target is on the picture, as the judge sees it; null when it can't tell. */
async function locate(
  deps: CommentToolDeps,
  ctx: ToolContext,
  fileId: string,
  target: string,
): Promise<LiveAskSelection["mark"] | null> {
  if (!deps.judge) return null;
  const picture = await readPictureFile(deps.artifacts, actorOf(ctx), ctx.orgId, fileId).catch(() => null);
  if (!picture || (picture.contentType !== "image/png" && picture.contentType !== "image/jpeg")) return null;
  const placeholder = `picture_${randomUUID()}`;
  const answers = await deps.judge
    .ask({
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      kind: "comment_locate",
      state: { picture: placeholder, target },
      images: {
        [placeholder]: {
          data: Buffer.from(picture.bytes).toString("base64"),
          format: picture.contentType === "image/png" ? "png" : "jpeg",
        },
      },
      questions: {
        where: { type: "box", instructions: "Where the target is on the picture." },
        present: {
          type: "noul",
          instructions: "Whether the target is on the picture.",
          criteria: { true: "It is on the picture.", false: "It isn't on the picture." },
        },
      },
    })
    .catch(() => null);
  const box = answers?.where?.box;
  if (!box || (answers?.present?.noul ?? 0) < 0.5) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x = clamp(box.left);
  const y = clamp(box.top);
  const w = clamp(box.right) - x;
  const h = clamp(box.bottom) - y;
  return w > 0.01 && h > 0.01 ? { x, y, w, h } : { x, y };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function commentTool(deps: CommentToolDeps, file: ConversationFile): ToolDefinition {
  const where =
    file.kind === "image"
      ? "`target` (what to point at, in a few words: the judge finds it on the picture), or `x` and `y` (and `w`, `h` for an area) in fractions of the picture from its top left"
      : file.kind === "video"
        ? "`time` (the moment, in seconds), and `x`, `y` (and `w`, `h`) in fractions of the frame when you know the place"
        : "`page` (from 1), and `x`, `y` (and `w`, `h`) in fractions of the page when you know the place";
  return {
    name: COMMENT_ON_FILE,
    description: `Comment on a place in this ${file.kind === "pdf" ? "PDF" : file.kind} with a pin there, as your answer: your words go in the conversation as a comment, and its numbered pin shows on the file. Say where with ${where}. It is posted at once: after it, write text only if there is something to add; otherwise end your turn with an empty reply. For words that point at no place, just reply.`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 4_000, description: "Your comment." },
        target: { type: "string", maxLength: 200, description: "What to point at, in a few words (a picture only)." },
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
        w: { type: "number", minimum: 0, maximum: 1 },
        h: { type: "number", minimum: 0, maximum: 1 },
        time: { type: "number", minimum: 0, description: "A video's moment, in seconds." },
        page: { type: "integer", minimum: 1, description: "A PDF's page, from 1." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Comment on the file" }),
    async execute(input, ctx) {
      try {
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (!text) return { content: "Say what the comment says (`text`).", isError: true };
        const target = typeof input.target === "string" ? input.target.trim() : "";
        const given = num(input.x) !== undefined && num(input.y) !== undefined;
        let mark: LiveAskSelection["mark"] | null = null;
        if (file.kind === "image" && target) mark = await locate(deps, ctx, file.id, target);
        if (!mark && given) {
          const x = num(input.x) as number;
          const y = num(input.y) as number;
          const w = num(input.w);
          const h = num(input.h);
          mark = w && h ? { x, y, w, h } : { x, y };
        }
        const time = file.kind === "video" ? num(input.time) : undefined;
        const page = file.kind === "pdf" && Number.isInteger(input.page) ? (input.page as number) : undefined;
        if (!mark && time === undefined && page === undefined) {
          return {
            content:
              file.kind === "image"
                ? target
                  ? `Couldn't find "${target}" on the picture. Give \`x\` and \`y\` in fractions of the picture instead, or just reply.`
                  : "Say where: `target`, or `x` and `y`."
                : file.kind === "video"
                  ? "Say the moment (`time`, in seconds)."
                  : "Say the page (`page`).",
            isError: true,
          };
        }
        // Its label is its pin's number, as the apps write theirs: the next one. Kept as a person's selection is
        // (`cleanSelection`): an area stays inside the file, fractions and the moment rounded.
        const label = String((await pinnedComments(ctx, file)).length + 1);
        const selection: LiveAskSelection = cleanSelection({
          label,
          ...(mark ? { mark } : {}),
          ...(time !== undefined ? { time } : {}),
          ...(page !== undefined ? { page } : {}),
          version: file.currentVersion,
        }) ?? { label };
        const [run] = await ctx.db
          .select({ hop: schema.agentRuns.hop })
          .from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.orgId, ctx.orgId), eq(schema.agentRuns.id, ctx.runId)));
        if (!run) return { content: "Only an answer in a conversation comments on its file.", isError: true };
        const message = await insertMessage(ctx.db, {
          orgId: ctx.orgId,
          channelId: ctx.channelId,
          threadId: replyThreadOf(ctx),
          author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: run.hop },
          body: text,
          meta: { liveRef: { artifactId: file.id, kind: file.kind, title: file.title, selection } },
        });
        if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
        const n = (await pinnedComments(ctx, file)).find((c) => c.id === message.id)?.n;
        return {
          content: `Posted as comment ${n ?? ""} (${markWords(file.kind, selection) || "on the file"}). If you have nothing to add, end your turn with an empty reply.`,
          data: { mediaSent: { messageId: message.id, kind: "comment" } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };
}

function resolveTool(deps: CommentToolDeps, file: ConversationFile): ToolDefinition {
  return {
    name: RESOLVE_COMMENT,
    description:
      "Mark a comment on this file resolved when what it asked is done (its pin leaves the file; the comment stays in the conversation), or open it again with `resolved` false. `comment` is its number or the id its line gives.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        comment: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: 'The comment\'s number ("4") or the id its line gives.',
        },
        resolved: { type: "boolean", description: "False opens it again. Default true." },
      },
      required: ["comment"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title: "Resolve a comment",
      detail: typeof input.comment === "string" ? input.comment : undefined,
    }),
    async execute(input, ctx) {
      try {
        const list = await pinnedComments(ctx, file);
        const c = findComment(list, input.comment);
        if (!c) return { content: `No such comment here (1 to ${list.length}).`, isError: true };
        const resolved = input.resolved !== false;
        await resolveComment(
          { db: ctx.db, pubsub: deps.pubsub },
          { type: "agent", agentId: ctx.agentId },
          ctx.orgId,
          c.id,
          resolved,
        );
        return { content: resolved ? `Comment ${c.n} is resolved.` : `Comment ${c.n} is open again.` };
      } catch (error) {
        return failed(error);
      }
    },
  };
}

/** Whether `channelId` is a picture's, a video's or a PDF's own conversation: its run sees the file with the Drive's tools. */
export async function isMediaConversation(db: ToolContext["db"], orgId: string, channelId: string): Promise<boolean> {
  const row = await fileOfConversation(db, orgId, channelId);
  return Boolean(row && !row.deletedAt && (await mediaKindOf(db, row)));
}

/** The tools above, for a run in a picture's, a video's or a PDF's own conversation. */
export function createCommentToolSource(deps: CommentToolDeps): ToolSource {
  return {
    name: "file-comments",
    async tools(ctx) {
      if (!ctx.runId) return [];
      // Listed on every run: only a file's own conversation (the per-process cache says) reads further.
      const channel = await getChannelCached(ctx.db, ctx.orgId, ctx.channelId).catch(() => null);
      if (String(channel?.kind ?? "") !== "file") return [];
      const row = await fileOfConversation(ctx.db, ctx.orgId, ctx.channelId);
      if (!row || row.deletedAt) return [];
      const kind = await mediaKindOf(ctx.db, row);
      if (!kind) return [];
      const file: ConversationFile = { id: row.id, title: row.title, kind, currentVersion: row.currentVersion };
      return [lookTool(deps, file), commentTool(deps, file), resolveTool(deps, file)];
    },
  };
}
