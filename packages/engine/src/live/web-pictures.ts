import { OutboundAddressError } from "@agenteschat/adapters";
import { sniffModelImage } from "../avatars";
import { ValidationError } from "../errors";
import { imageSize } from "../image-size";
import { assertPublicHttpsUrl, outboundFetch, type ResolveHost } from "../net-guard";
import { looksLikeSvg, SVG_TYPE } from "./svg";

/**
 * A picture from the public web, for a live file (ADR 0196 §8): what an agent found with `image_search` or was given
 * by a person, downloaded by the server. One GET at a time through the public-address guard (https only, no
 * internal name, every address the host resolves to public, the socket pinned to one of them), each redirect checked
 * the same way before it is followed, at most `WEB_PICTURE_LIMITS.bytes` read while it streams, and kept only when
 * the server says it is a picture and its bytes are one: PNG, JPEG, WebP, GIF, or an SVG that the sanitizer then
 * rebuilds (`svg.ts`).
 */

/** `pixels`: a few megabytes can say 100,000 × 100,000, which every app that draws it would try to hold. */
export const WEB_PICTURE_LIMITS = {
  bytes: 15 * 1024 * 1024,
  pixels: 50_000_000,
  redirects: 5,
  timeoutMs: 20_000,
} as const;

/** How the server reaches the web: a `fetch` (tests give their own) and how a host's addresses are found. */
export interface WebPictureDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  resolveHost?: ResolveHost;
}

/** A picture downloaded: its bytes, what they are, and the address it came from in the end. */
export interface WebPicture {
  bytes: Uint8Array;
  contentType: string;
  url: string;
}

const USER_AGENT = "Mozilla/5.0 (compatible; agentes.chat; +https://agentes.chat)";
const ACCEPT = "image/webp,image/png,image/jpeg,image/gif,image/svg+xml;q=0.9,image/*;q=0.5";

const refuse = (message: string, code = "live.web_picture") => new ValidationError(message, code);

/** Downloads the picture at `raw` (see the file's comment); refused with a reason an agent can act on. */
export async function fetchWebPicture(
  raw: string,
  deps: WebPictureDeps = {},
  signal?: AbortSignal,
): Promise<WebPicture> {
  const asked = raw.trim().replace(/^http:\/\//i, "https://");
  const limit = AbortSignal.timeout(WEB_PICTURE_LIMITS.timeoutMs);
  const wait = signal ? AbortSignal.any([signal, limit]) : limit;
  // Not the server's own `fetch`: an address someone named is checked and pinned at every request.
  const open = deps.fetch ?? outboundFetch({ resolveHost: deps.resolveHost });
  let next = asked;
  for (let hop = 0; ; hop++) {
    let at: URL;
    try {
      at = await assertPublicHttpsUrl(next, deps.resolveHost);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw refuse(`Can't download ${next.slice(0, 200)}: ${why}.`, "live.web_picture_address");
    }
    let res: Response;
    try {
      res = await open(at.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: ACCEPT },
        signal: wait,
      });
    } catch (error) {
      if (error instanceof OutboundAddressError) {
        throw refuse(`Can't download from ${at.host}: it points to an internal network.`, "live.web_picture_address");
      }
      const why = limit.aborted ? "it took too long" : error instanceof Error ? error.message : String(error);
      throw refuse(`Couldn't reach ${at.host} (${why}). Try another picture.`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      if (hop >= WEB_PICTURE_LIMITS.redirects) throw refuse(`${at.host} redirects too many times.`);
      // Never plain http, here either: a redirect to it is asked over https, checked like the first address.
      next = new URL(location, at).toString().replace(/^http:\/\//i, "https://");
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw refuse(`${at.host} answered ${res.status} for that picture. Try another one.`);
    }
    const declared = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!declared.startsWith("image/")) {
      await res.body?.cancel().catch(() => undefined);
      throw refuse(
        `${at.toString().slice(0, 200)} is ${declared ? `a ${declared} file` : "no picture"}, not a picture: give the picture's own address (image_search's picture line), not its page's.`,
      );
    }
    const length = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > WEB_PICTURE_LIMITS.bytes) {
      await res.body?.cancel().catch(() => undefined);
      throw refuse(tooLarge(at.host));
    }
    const bytes = await readCapped(res, at.host);
    const contentType = sniffModelImage(bytes) ?? (looksLikeSvg(bytes) ? SVG_TYPE : null);
    if (!contentType) {
      throw refuse(
        `The file at ${at.host} isn't a PNG, JPEG, WebP, GIF or SVG picture (it says ${declared}). Try another one.`,
      );
    }
    const size = contentType === SVG_TYPE ? null : imageSize(bytes);
    if (size && size.width * size.height > WEB_PICTURE_LIMITS.pixels) {
      throw refuse(`The picture at ${at.host} is ${size.width}×${size.height}: too many pixels. Pick a smaller size.`);
    }
    return { bytes, contentType, url: at.toString() };
  }
}

const tooLarge = (host: string) =>
  `The picture at ${host} is over ${WEB_PICTURE_LIMITS.bytes / 1024 / 1024} MB: pick a smaller one (a thumbnail or another size).`;

/** A body as bytes, refused past the limit while it streams: a body with no length can't run us out of memory. */
async function readCapped(res: Response, host: string): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WEB_PICTURE_LIMITS.bytes) {
      await reader.cancel().catch(() => undefined);
      throw refuse(tooLarge(host));
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
