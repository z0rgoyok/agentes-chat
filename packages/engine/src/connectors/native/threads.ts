import type { ConnectionSecret } from "../connections";
import { graphAnswer, graphFetch } from "./meta";
import {
  json,
  type NativeCall,
  NativeError,
  type NativeService,
  type NativeToken,
  type NativeTool,
  pageSize,
  str,
} from "./types";

/**
 * Threads (ADR 0170): the account a person signed in with, through this server's Meta app with the Threads use case.
 * The code's 1-hour token is exchanged for a 60-day one, renewed by `th_refresh_token` within 7 days of its end (on
 * use, or by the worker's sweep). A post is a container, then a publish; pictures and videos go by a link of ours
 * Meta fetches, so they need a server the internet reaches.
 */

const GRAPH = "https://graph.threads.com";
const API = `${GRAPH}/v1.0`;
const TEXT_MAX = 500;
const CAROUSEL_MAX = 20;
const POST_FIELDS = "id,text,timestamp,permalink,media_type,username,is_reply";

const tokenOf = (secret: ConnectionSecret) => {
  if (!secret.accessToken) {
    throw new NativeError("connector.needs_reconnect", "The Threads sign-in is missing: reconnect it.");
  }
  return secret.accessToken;
};

async function threadsCall<T>(
  call: Pick<NativeCall, "http" | "secret">,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | undefined> = {},
  writes = false,
): Promise<T> {
  const query = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  const url = `${API}${path}${method === "GET" && query.size ? `?${query}` : ""}`;
  const res = await graphFetch(
    call.http,
    url,
    {
      method,
      headers: {
        authorization: `Bearer ${tokenOf(call.secret)}`,
        ...(method === "GET" ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(method === "GET" ? {} : { body: query }),
    },
    "Threads",
    writes,
  );
  return graphAnswer<T>(res, "Threads", writes);
}

const idInput = { type: "string", pattern: "^[0-9]{1,30}$", description: "The post's id." } as const;
const limitInput = { type: "integer", minimum: 1, maximum: 50, description: "How many (default 10)." } as const;

/** A media item's container: its kind from the file's type, at a link Meta fetches. */
async function mediaContainer(call: NativeCall, fileId: string, item: boolean) {
  const file = await call.file(fileId);
  const kind = file.contentType.startsWith("video/") ? "VIDEO" : file.contentType.startsWith("image/") ? "IMAGE" : null;
  if (!kind)
    throw new NativeError("connector.refused", `${file.name} isn't a picture or a video: Threads takes only those.`);
  const link = await call.mediaLink?.(fileId);
  if (!link) {
    throw new NativeError(
      "connector.refused",
      "Threads fetches pictures and videos from a link, and the internet can't reach this server: post the text alone, or the server's owner puts it on a public address.",
    );
  }
  return { kind, link, item };
}

/** Creates a container and publishes it (a video's waits until Meta has fetched it). */
async function publish(call: NativeCall, params: Record<string, string | undefined>) {
  const container = await threadsCall<{ id?: string }>(call, "POST", "/me/threads", params, true);
  if (!container.id) throw new NativeError("connector.failed", "Threads didn't take the post. Try again in a minute.");
  for (let tries = 0; params.media_type === "VIDEO" || params.media_type === "CAROUSEL"; tries++) {
    const state = await threadsCall<{ status?: string; error_message?: string }>(call, "GET", `/${container.id}`, {
      fields: "status,error_message",
    });
    if (state.status === "FINISHED" || !state.status) break;
    if (state.status === "ERROR") {
      throw new NativeError(
        "connector.refused",
        `Threads couldn't take the media: "${state.error_message ?? "error"}"`,
      );
    }
    if (tries >= 20)
      throw new NativeError("connector.failed", "Threads is still processing the media: try again in a few minutes.");
    await Bun.sleep(3000);
  }
  const done = await threadsCall<{ id?: string }>(
    call,
    "POST",
    "/me/threads_publish",
    { creation_id: container.id },
    true,
  );
  const post = done.id
    ? await threadsCall<{ permalink?: string }>(call, "GET", `/${done.id}`, { fields: "permalink" }).catch(() => ({}))
    : {};
  return { id: done.id ?? null, permalink: (post as { permalink?: string }).permalink ?? null };
}

async function createPost(call: NativeCall, input: Record<string, unknown>, replyTo?: string) {
  const text = str(input.text);
  const media = Array.isArray(input.media) ? input.media.map(str).filter(Boolean).slice(0, CAROUSEL_MAX) : [];
  const base = { text: text || undefined, ...(replyTo ? { reply_to_id: replyTo } : {}) };
  let posted: { id: string | null; permalink: string | null };
  if (media.length === 0) posted = await publish(call, { ...base, media_type: "TEXT" });
  else if (media.length === 1) {
    const m = await mediaContainer(call, media[0] as string, false);
    posted = await publish(call, {
      ...base,
      media_type: m.kind,
      [m.kind === "VIDEO" ? "video_url" : "image_url"]: m.link,
    });
  } else {
    const children: string[] = [];
    for (const id of media) {
      const m = await mediaContainer(call, id, true);
      const child = await threadsCall<{ id?: string }>(
        call,
        "POST",
        "/me/threads",
        { media_type: m.kind, is_carousel_item: "true", [m.kind === "VIDEO" ? "video_url" : "image_url"]: m.link },
        true,
      );
      if (child.id) children.push(child.id);
    }
    posted = await publish(call, { ...base, media_type: "CAROUSEL", children: children.join(",") });
  }
  return {
    content: `${replyTo ? "Replied" : "Posted"} on Threads${posted.permalink ? `: ${posted.permalink}` : ""}.`,
    data: { postId: posted.id },
  };
}

const postInput = {
  text: { type: "string", maxLength: TEXT_MAX, description: "Up to 500 characters." },
  media: {
    type: "array",
    items: { type: "string" },
    maxItems: CAROUSEL_MAX,
    description: "Drive file ids: one picture or video, or 2 to 20 for a carousel.",
  },
} as const;

const tools: Record<string, NativeTool> = {
  get_my_posts: {
    description: "The account's latest posts and replies on Threads, newest first.",
    input: { properties: { limit: limitInput } },
    async run(input, call) {
      const page = await threadsCall<{ data?: unknown[] }>(call, "GET", "/me/threads", {
        fields: POST_FIELDS,
        limit: String(pageSize(input.limit)),
      });
      return json(page.data ?? []);
    },
  },
  get_replies: {
    description: "The replies to one of the account's posts, with who wrote them.",
    input: { properties: { id: idInput, limit: limitInput }, required: ["id"] },
    external: true,
    async run(input, call) {
      const page = await threadsCall<{ data?: unknown[] }>(call, "GET", `/${str(input.id)}/replies`, {
        fields: `${POST_FIELDS},hide_status`,
        limit: String(pageSize(input.limit)),
      });
      return json(page.data ?? []);
    },
  },
  get_mentions: {
    description: "Recent posts on Threads that mention the account.",
    input: { properties: { limit: limitInput } },
    external: true,
    async run(input, call) {
      const page = await threadsCall<{ data?: unknown[] }>(call, "GET", "/me/mentions", {
        fields: POST_FIELDS,
        limit: String(pageSize(input.limit)),
      });
      return json(page.data ?? []);
    },
  },
  get_insights: {
    description: "Views, likes, replies, reposts and quotes: of one post (by id), or of the whole account (no id).",
    input: { properties: { id: { ...idInput, description: "A post's id; none: the account's." } } },
    async run(input, call) {
      const id = str(input.id);
      const page = await threadsCall<{ data?: unknown[] }>(
        call,
        "GET",
        id ? `/${id}/insights` : "/me/threads_insights",
        { metric: id ? "views,likes,replies,reposts,quotes" : "views,likes,replies,reposts,quotes,followers_count" },
      );
      return json(page.data ?? []);
    },
  },
  create_post: {
    description:
      "Post on Threads: text up to 500 characters, with one picture or video from the Drive or a carousel of 2 to 20. Public at once. Threads allows 250 posts a day per account.",
    input: { properties: postInput },
    run: (input, call) => createPost(call, input),
  },
  reply: {
    description: "Reply to a post on Threads (one of the account's, or one that mentions it), as the account.",
    input: { properties: { id: { ...idInput, description: "The post to reply to." }, ...postInput }, required: ["id"] },
    run: (input, call) => createPost(call, input, str(input.id)),
  },
  hide_reply: {
    description: "Hide a reply to one of the account's posts (or show it again with hide false).",
    input: {
      properties: {
        id: { ...idInput, description: "The reply's id." },
        hide: { type: "boolean", description: "Default true." },
      },
      required: ["id"],
    },
    async run(input, call) {
      const hide = input.hide !== false;
      await threadsCall(call, "POST", `/${str(input.id)}/manage_reply`, { hide: String(hide) }, true);
      return { content: hide ? "Hidden." : "Shown again." };
    },
  },
  delete_post: {
    description: "Delete one of the account's posts. It can't be undone; Threads allows 100 deletes a day.",
    input: { properties: { id: idInput }, required: ["id"] },
    async run(input, call) {
      await threadsCall(call, "DELETE", `/${str(input.id)}`, {}, true);
      return { content: "Deleted." };
    },
  },
};

async function tokenCall(http: typeof fetch, path: string, params: Record<string, string>): Promise<NativeToken> {
  const res = await graphFetch(
    http,
    `${GRAPH}${path}?${new URLSearchParams(params)}`,
    { method: "GET" },
    "Threads",
    false,
  );
  const body = await graphAnswer<{ access_token?: string; expires_in?: number }>(res, "Threads", false);
  if (!body.access_token) throw new NativeError("connector.failed", "Threads gave no token. Try connecting again.");
  return { accessToken: body.access_token, ...(body.expires_in ? { expiresIn: body.expires_in } : {}) };
}

export const threads: NativeService = {
  tools,
  refreshBefore: 7 * 24 * 3600_000,
  async account(secret, http) {
    const me = await threadsCall<{ id?: string; username?: string }>({ http, secret }, "GET", "/me", {
      fields: "id,username",
    });
    if (!me.id) throw new NativeError("connector.failed", "Threads didn't say which account signed in. Try again.");
    return { label: me.username ? `@${me.username}` : me.id, id: me.id };
  },
  exchange: (token, app, http) =>
    tokenCall(http, "/access_token", {
      grant_type: "th_exchange_token",
      client_secret: app.clientSecret,
      access_token: token.accessToken,
    }),
  refresh: (secret, _app, http) =>
    tokenCall(http, "/refresh_access_token", { grant_type: "th_refresh_token", access_token: tokenOf(secret) }),
};
