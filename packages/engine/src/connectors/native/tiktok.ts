import type { ConnectionSecret } from "../connections";
import { json, type NativeCall, NativeError, type NativeService, type NativeTool, pageSize, str } from "./types";

/**
 * TikTok (ADR 0170): the creator who signed in through this server's TikTok app (Login Kit for Web, `client_key`, no
 * PKCE). Reads, and videos sent to the creator's drafts, where they finish the post in TikTok; each upload asks a person
 * first, as TikTok wants consent per upload. Direct Post waits for TikTok's audit and its own post card.
 */

const API = "https://open.tiktokapis.com";
const VIDEO_MAX = 4 * 1024 * 1024 * 1024;
/** TikTok's chunks: 5 to 64 MB, the last up to 128 MB; a video under 64 MB goes whole. */
const CHUNK = 10 * 1024 * 1024;

interface TikTokAnswer<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

const tokenOf = (secret: ConnectionSecret) => {
  if (!secret.accessToken)
    throw new NativeError("connector.needs_reconnect", "The TikTok sign-in is missing: reconnect it.");
  return secret.accessToken;
};

async function tiktokCall<T>(
  call: Pick<NativeCall, "http" | "secret">,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  writes = false,
): Promise<T> {
  let res: Response;
  try {
    res = await call.http(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${tokenOf(call.secret)}`,
        ...(body ? { "content-type": "application/json; charset=UTF-8" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw writes
      ? new NativeError(
          "connector.unknown_result",
          "TikTok didn't answer in time: it may have happened. Check with get_post_status.",
        )
      : new NativeError("connector.failed", "TikTok didn't answer. Try again in a minute.");
  }
  const answer = (await res.json().catch(() => ({}))) as TikTokAnswer<T>;
  const code = answer.error?.code ?? (res.ok ? "ok" : `http_${res.status}`);
  if (code === "ok") return answer.data as T;
  const said = (answer.error?.message ?? code).slice(0, 300);
  if (code === "access_token_invalid" || code === "scope_not_authorized" || res.status === 401) {
    throw new NativeError(
      "connector.needs_reconnect",
      "TikTok refused the sign-in (it ended or a permission was taken back): someone who manages connectors reconnects TikTok.",
    );
  }
  if (
    code === "rate_limit_exceeded" ||
    code === "spam_risk_too_many_posts" ||
    code === "spam_risk_too_many_pending_share" ||
    res.status === 429
  ) {
    const at = new Date(Date.now() + (code === "rate_limit_exceeded" ? 60_000 : 24 * 3600_000));
    throw new NativeError(
      "connector.rate_limited",
      code === "rate_limit_exceeded"
        ? "TikTok takes no more calls for a minute. Nothing was sent."
        : "TikTok takes no more posts or drafts from this creator today (5 drafts may wait at once). Nothing was sent.",
      at,
    );
  }
  if (res.status >= 500) throw new NativeError("connector.failed", "TikTok is busy right now. Try again in a minute.");
  throw new NativeError("connector.refused", `TikTok refused it: "${said}"`);
}

const tools: Record<string, NativeTool> = {
  get_profile: {
    description: "The creator's profile: name, @username, bio, followers, following, likes and video count.",
    input: { properties: {} },
    async run(_input, call) {
      const data = await tiktokCall<{ user?: unknown }>(
        call,
        "GET",
        "/v2/user/info/?fields=open_id,display_name,username,bio_description,profile_deep_link,follower_count,following_count,likes_count,video_count",
      );
      return json(data?.user ?? null);
    },
  },
  list_videos: {
    description: "The creator's public videos, newest first: title, link, date, views, likes, comments and shares.",
    input: {
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, description: "How many (default 10, at most 20)." },
        cursor: { type: "integer", description: "From the previous page's cursor." },
      },
    },
    async run(input, call) {
      const data = await tiktokCall<{ videos?: unknown[]; cursor?: number; has_more?: boolean }>(
        call,
        "POST",
        "/v2/video/list/?fields=id,title,create_time,share_url,duration,view_count,like_count,comment_count,share_count",
        {
          max_count: Math.min(pageSize(input.limit), 20),
          ...(typeof input.cursor === "number" ? { cursor: input.cursor } : {}),
        },
      );
      return json({ videos: data?.videos ?? [], cursor: data?.cursor ?? null, has_more: data?.has_more ?? false });
    },
  },
  get_creator_info: {
    description:
      "What the creator may post now: their nickname, privacy options, whether comments, duets and stitches are off, and the longest video.",
    input: { properties: {} },
    async run(_input, call) {
      return json(await tiktokCall(call, "POST", "/v2/post/publish/creator_info/query/", {}));
    },
  },
  get_post_status: {
    description:
      "Where an upload is: processing, sent to the creator's drafts (they finish it in TikTok), published, or failed and why.",
    input: { properties: { publish_id: { type: "string", minLength: 1, maxLength: 200 } }, required: ["publish_id"] },
    async run(input, call) {
      return json(
        await tiktokCall(call, "POST", "/v2/post/publish/status/fetch/", { publish_id: str(input.publish_id) }),
      );
    },
  },
  upload_draft: {
    description:
      "Send a video from the Drive to the creator's TikTok drafts, with its caption on the approval card: they get a notification and finish the post in TikTok. Asks a person every time. At most 5 drafts may wait at once.",
    input: {
      properties: {
        file: { type: "string", description: "The Drive video's id." },
        caption: {
          type: "string",
          maxLength: 2200,
          description: "What the creator will see as the suggested caption.",
        },
      },
      required: ["file"],
    },
    async run(input, call) {
      const file = await call.file(str(input.file));
      if (!file.contentType.startsWith("video/")) {
        return { content: `${file.name} isn't a video: TikTok drafts take videos.`, isError: true };
      }
      const size = file.bytes.byteLength;
      if (size > VIDEO_MAX) return { content: `${file.name} is over TikTok's 4 GB.`, isError: true };
      const whole = size <= 64 * 1024 * 1024;
      const chunkSize = whole ? size : CHUNK;
      const count = whole ? 1 : Math.floor(size / CHUNK);
      const init = await tiktokCall<{ publish_id?: string; upload_url?: string }>(
        call,
        "POST",
        "/v2/post/publish/inbox/video/init/",
        { source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count } },
        true,
      );
      if (!init?.upload_url || !init.publish_id) {
        throw new NativeError("connector.failed", "TikTok didn't open an upload. Try again in a minute.");
      }
      for (let i = 0; i < count; i++) {
        const start = i * chunkSize;
        // The last chunk takes the rest.
        const end = i === count - 1 ? size : start + chunkSize;
        const res = await call
          .http(init.upload_url, {
            method: "PUT",
            headers: {
              "content-type": file.contentType,
              "content-length": String(end - start),
              "content-range": `bytes ${start}-${end - 1}/${size}`,
            },
            body: file.bytes.slice(start, end),
          })
          .catch(() => null);
        if (!res || res.status >= 400) {
          throw new NativeError(
            "connector.unknown_result",
            "The upload to TikTok broke off: check with get_post_status before sending it again.",
          );
        }
      }
      return {
        content: `Sent ${file.name} to the creator's TikTok drafts: they get a notification and finish the post in TikTok${str(input.caption) ? `, with the caption "${str(input.caption)}" to paste` : ""}.`,
        data: { publishId: init.publish_id },
      };
    },
  },
};

export const tiktok: NativeService = {
  tools,
  async account(secret, http) {
    const data = await tiktokCall<{ user?: { open_id?: string; username?: string; display_name?: string } }>(
      { http, secret },
      "GET",
      "/v2/user/info/?fields=open_id,username,display_name",
    );
    const user = data?.user;
    if (!user?.open_id)
      throw new NativeError("connector.failed", "TikTok didn't say which account signed in. Try again.");
    return { label: user.username ? `@${user.username}` : (user.display_name ?? user.open_id), id: user.open_id };
  },
  async revoke(secret, http, app) {
    if (!app || !secret.accessToken) return;
    await http(`${API}/v2/oauth/revoke/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: app.clientId,
        client_secret: app.clientSecret,
        token: secret.accessToken,
      }),
    });
  },
};
