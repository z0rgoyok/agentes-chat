import type { ConnectionSecret } from "../connections";
import { json, type NativeCall, NativeError, type NativeService, type NativeTool, pageSize, str } from "./types";

/**
 * X (ADR 0170): posts on the account a person signed in with, through this server's X app (OAuth 2.0 with PKCE, the
 * client in HTTP Basic). X bills the app per post written and read, so reads take small pages, each call's price
 * counts against the workspace's `connectorUsdPerMonth` (`X_PRICES`), and a workspace may be capped per month in calls
 * (`CONNECTOR_X_CALLS_PER_MONTH`, a server's own cap with no plan). Both are checked by the tool source. Not built, by X's rules: replies (until X approves AI-written
 * ones for the app), quotes, likes, follows and direct messages.
 */

const API = "https://api.x.com";
const POST_MAX = 280;
const PICTURES_MAX = 4;
const PICTURE_BYTES = 5 * 1024 * 1024;
const VIDEO_BYTES = 512 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const POST_FIELDS = "tweet.fields=created_at,public_metrics,author_id,conversation_id";

const tokenOf = (secret: ConnectionSecret) => {
  if (!secret.accessToken)
    throw new NativeError("connector.needs_reconnect", "The X sign-in is missing: reconnect it.");
  return secret.accessToken;
};

interface XAnswer {
  data?: unknown;
  includes?: unknown;
  meta?: unknown;
  errors?: { message?: string; detail?: string }[];
  detail?: string;
  title?: string;
}

/** One X API call. `writes`: a timeout may have happened on X's side. */
export async function xCall<T = XAnswer>(
  call: Pick<NativeCall, "http" | "secret">,
  method: string,
  path: string,
  body?: Record<string, unknown> | FormData,
  writes = false,
): Promise<T> {
  let res: Response;
  try {
    res = await call.http(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${tokenOf(call.secret)}`,
        ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    });
  } catch {
    throw writes
      ? new NativeError(
          "connector.unknown_result",
          "X didn't answer in time: it may have posted. Check with get_my_posts before posting again.",
        )
      : new NativeError("connector.failed", "X didn't answer. Try again in a minute.");
  }
  if (res.status === 204) return {} as T;
  const answer = (await res.json().catch(() => ({}))) as XAnswer;
  if (res.ok && !(answer.errors && !answer.data)) return answer as T;
  const said = (
    answer.detail ??
    answer.errors?.[0]?.detail ??
    answer.errors?.[0]?.message ??
    answer.title ??
    `HTTP ${res.status}`
  ).slice(0, 300);
  if (res.status === 401) {
    throw new NativeError(
      "connector.needs_reconnect",
      "X refused the sign-in (it ended, or the same X account was connected in another workspace): someone who manages connectors reconnects X.",
    );
  }
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-rate-limit-reset"));
    const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : new Date(Date.now() + 15 * 60_000);
    throw new NativeError(
      "connector.rate_limited",
      `X takes no more of this from the account until ${at.toISOString().slice(11, 16)} UTC. Nothing was ${writes ? "posted" : "read"}.`,
      at,
    );
  }
  if (res.status === 402 || /credit|usage.?cap|spend/i.test(said)) {
    throw new NativeError(
      "connector.capped",
      `X refused it for this server's app: "${said}". Whoever runs this server tops up its X credits or raises its spending limit at console.x.com.`,
    );
  }
  if (res.status >= 500) throw new NativeError("connector.failed", "X is busy right now. Try again in a minute.");
  throw new NativeError("connector.refused", `X refused it: "${said}"`);
}

/**
 * X's pay-per-use prices (read 2026-11), in nano-US$: billed to this server's app per post written or deleted and per
 * post or user an answer holds; a failed request bills nothing, so only an answer is priced. Media uploads are free.
 */
export const X_PRICES = { post: 15e6, postWithLink: 200e6, postRead: 5e6, userRead: 10e6, delete: 10e6 } as const;
/** Anything X may turn into a link: its own parser knows the TLDs, so this errs toward the dearer price. */
const LINK = /https?:\/\/|\b[\w-]+\.[a-z]{2,}\b/i;
const count = (v: unknown) => (Array.isArray(v) ? v.length : v ? 1 : 0);
/** An answer's price: its posts, and the users its expansion brought. */
const readCost = (answer: { data?: unknown; includes?: unknown }) =>
  count(answer.data) * X_PRICES.postRead +
  count((answer.includes as { users?: unknown } | undefined)?.users) * X_PRICES.userRead;
const postCost = (input: Record<string, unknown>) =>
  LINK.test(str(input.text)) ? X_PRICES.postWithLink : X_PRICES.post;

const idInput = { type: "string", pattern: "^[0-9]{1,20}$", description: "The post's id." } as const;
const limitInput = { type: "integer", minimum: 1, maximum: 50, description: "How many (default 10)." } as const;

/** X's own floor for a page: 5 posts (10 for a search). */
const xPage = (v: unknown, floor: number) => Math.max(pageSize(v), floor);

/** Picture or video bytes uploaded to X, its media id back. */
async function uploadMedia(call: NativeCall, file: { name: string; contentType: string; bytes: Uint8Array }) {
  const video = file.contentType.startsWith("video/");
  if (!video && !file.contentType.startsWith("image/")) {
    throw new NativeError("connector.refused", `${file.name} isn't a picture or a video: X takes only those.`);
  }
  if (file.bytes.byteLength > (video ? VIDEO_BYTES : PICTURE_BYTES)) {
    throw new NativeError(
      "connector.refused",
      `${file.name} is over X's ${video ? "512" : "5"} MB: nothing was posted.`,
    );
  }
  if (!video) {
    const form = new FormData();
    form.set("media", new Blob([file.bytes], { type: file.contentType }), file.name);
    form.set("media_category", "tweet_image");
    form.set("media_type", file.contentType);
    const up = await xCall<{ data?: { id?: string } }>(call, "POST", "/2/media/upload", form, true);
    if (!up.data?.id) throw new NativeError("connector.failed", `X didn't take ${file.name}. Try again in a minute.`);
    return up.data.id;
  }
  const init = await xCall<{ data?: { id?: string } }>(
    call,
    "POST",
    "/2/media/upload/initialize",
    { media_type: file.contentType, total_bytes: file.bytes.byteLength, media_category: "tweet_video" },
    true,
  );
  const id = init.data?.id;
  if (!id) throw new NativeError("connector.failed", `X didn't take ${file.name}. Try again in a minute.`);
  for (let i = 0, at = 0; at < file.bytes.byteLength; i++, at += CHUNK) {
    const form = new FormData();
    form.set("media", new Blob([file.bytes.slice(at, at + CHUNK)]), file.name);
    form.set("segment_index", String(i));
    await xCall(call, "POST", `/2/media/upload/${id}/append`, form, true);
  }
  let state = await xCall<{ data?: { processing_info?: { state?: string; check_after_secs?: number } } }>(
    call,
    "POST",
    `/2/media/upload/${id}/finalize`,
    undefined,
    true,
  );
  for (let tries = 0; tries < 30; tries++) {
    const info = state.data?.processing_info;
    if (!info || info.state === "succeeded") return id;
    if (info.state === "failed") throw new NativeError("connector.refused", `X couldn't process ${file.name}.`);
    await Bun.sleep(Math.min(info.check_after_secs ?? 2, 10) * 1000);
    state = await xCall(call, "GET", `/2/media/upload?command=STATUS&media_id=${id}`);
  }
  throw new NativeError("connector.failed", `X is still processing ${file.name}: post again in a few minutes.`);
}

const tools: Record<string, NativeTool> = {
  get_my_posts: {
    description: "The account's own latest posts, newest first, with their counts (likes, reposts, replies, views).",
    input: { properties: { limit: limitInput } },
    most: (input) => xPage(input.limit, 5) * X_PRICES.postRead,
    async run(input, call) {
      const me = call.connection.accountId;
      const page = await xCall(
        call,
        "GET",
        `/2/users/${me}/tweets?max_results=${xPage(input.limit, 5)}&${POST_FIELDS}`,
      );
      return { ...json(page.data ?? []), costNanoUsd: readCost(page) };
    },
  },
  get_mentions: {
    description: "The latest posts that mention the account, newest first.",
    input: { properties: { limit: limitInput } },
    external: true,
    most: (input) => xPage(input.limit, 5) * (X_PRICES.postRead + X_PRICES.userRead),
    async run(input, call) {
      const me = call.connection.accountId;
      const page = await xCall(
        call,
        "GET",
        `/2/users/${me}/mentions?max_results=${xPage(input.limit, 5)}&${POST_FIELDS}&expansions=author_id&user.fields=username`,
      );
      return {
        ...json({ posts: page.data ?? [], users: (page.includes as { users?: unknown } | undefined)?.users ?? [] }),
        costNanoUsd: readCost(page),
      };
    },
  },
  get_post: {
    description: "One post by its id, with its author and counts.",
    input: { properties: { id: idInput }, required: ["id"] },
    external: true,
    most: () => X_PRICES.postRead + X_PRICES.userRead,
    async run(input, call) {
      const page = await xCall(
        call,
        "GET",
        `/2/tweets/${str(input.id)}?${POST_FIELDS}&expansions=author_id&user.fields=username`,
      );
      return { ...json(page), costNanoUsd: readCost(page) };
    },
  },
  search_recent: {
    description:
      'Posts from the last 7 days matching a search (X\'s query words: `from:acme`, `#launch`, `"exact words"`, `-is:retweet`). X bills each post returned: ask for few.',
    input: {
      properties: { query: { type: "string", minLength: 1, maxLength: 512 }, limit: limitInput },
      required: ["query"],
    },
    external: true,
    most: (input) => xPage(input.limit, 10) * (X_PRICES.postRead + X_PRICES.userRead),
    async run(input, call) {
      const q = encodeURIComponent(str(input.query));
      const page = await xCall(
        call,
        "GET",
        `/2/tweets/search/recent?query=${q}&max_results=${xPage(input.limit, 10)}&${POST_FIELDS}&expansions=author_id&user.fields=username`,
      );
      return {
        ...json({ posts: page.data ?? [], users: (page.includes as { users?: unknown } | undefined)?.users ?? [] }),
        costNanoUsd: readCost(page),
      };
    },
  },
  get_user: {
    description: "An X account by its @username: its name, bio and counts.",
    input: {
      properties: { username: { type: "string", pattern: "^@?[A-Za-z0-9_]{1,15}$" } },
      required: ["username"],
    },
    external: true,
    most: () => X_PRICES.userRead,
    async run(input, call) {
      const name = str(input.username).replace(/^@/, "");
      const user = await xCall(
        call,
        "GET",
        `/2/users/by/username/${name}?user.fields=description,public_metrics,created_at,verified`,
      );
      return { ...json(user.data ?? null), costNanoUsd: count(user.data) * X_PRICES.userRead };
    },
  },
  create_post: {
    description:
      "Post on the account: up to 280 characters, with up to 4 pictures or one video from the Drive. It is public at once. A link in the post costs this server's app more at X.",
    input: {
      properties: {
        text: { type: "string", minLength: 1, maxLength: POST_MAX },
        media: {
          type: "array",
          items: { type: "string" },
          maxItems: PICTURES_MAX,
          description: "Drive file ids: up to 4 pictures, or one video.",
        },
      },
      required: ["text"],
    },
    most: postCost,
    async run(input, call) {
      const ids = Array.isArray(input.media) ? input.media.map(str).filter(Boolean) : [];
      const files = await Promise.all(ids.map((id) => call.file(id)));
      if (files.some((f) => f.contentType.startsWith("video/")) && files.length > 1) {
        return { content: "X takes one video alone, or up to 4 pictures: nothing was posted.", isError: true };
      }
      const media: string[] = [];
      for (const f of files) media.push(await uploadMedia(call, f));
      const posted = await xCall<{ data?: { id?: string } }>(
        call,
        "POST",
        "/2/tweets",
        { text: str(input.text), ...(media.length ? { media: { media_ids: media } } : {}) },
        true,
      );
      const id = posted.data?.id;
      const handle = call.connection.accountLabel?.replace(/^@/, "") ?? "i";
      return {
        content: `Posted on X${id ? `: https://x.com/${handle}/status/${id}` : ""}.`,
        data: { postId: id ?? null },
        costNanoUsd: postCost(input),
      };
    },
  },
  delete_post: {
    description: "Delete one of the account's posts. It can't be undone.",
    input: { properties: { id: idInput }, required: ["id"] },
    most: () => X_PRICES.delete,
    async run(input, call) {
      await xCall(call, "DELETE", `/2/tweets/${str(input.id)}`, undefined, true);
      return { content: "Deleted.", costNanoUsd: X_PRICES.delete };
    },
  },
};

export const x: NativeService = {
  tools,
  async account(secret, http) {
    const me = await xCall<{ data?: { id: string; username: string } }>({ http, secret }, "GET", "/2/users/me");
    if (!me.data) throw new NativeError("connector.failed", "X didn't say which account signed in. Try again.");
    return { label: `@${me.data.username}`, id: me.data.id };
  },
  async revoke(secret, http, app) {
    const token = secret.refreshToken ?? secret.accessToken;
    if (!app || !token) return;
    const basic = Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`);
    await http(`${API}/2/oauth2/revoke`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic.toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token, token_type_hint: secret.refreshToken ? "refresh_token" : "access_token" }),
    });
  },
};
