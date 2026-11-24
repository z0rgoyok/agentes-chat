import type { BlobStore, ByteRange } from "@agenteschat/adapters";
import { NotFoundError } from "@agenteschat/engine";

/**
 * Bytes served in parts (`Range: bytes=a-b`), so a player starts at once and jumps anywhere without fetching the whole
 * file first: voice clips and uploaded videos.
 */

/** `bytes=a-b` of an object of `size`: where it starts and ends; null when absent; "bad" when it can't be served. */
export function rangeOf(header: string | undefined, size: number): ByteRange | "bad" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return "bad";
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start > end || start >= size ? "bad" : { start, end };
}

/** What a part is sent as: the bytes at hand, or as the store reads them. */
type Body = Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;

const unsatisfiable = (headers: Record<string, string>, size: number) =>
  new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });

/** The answer for `part` of an object of `size` (the whole when null), `body` holding just those bytes. */
function partResponse(body: Body, part: ByteRange | null, size: number, headers: Record<string, string>) {
  if (!part) return new Response(body, { headers: { ...headers, "content-length": String(size) } });
  return new Response(body, {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(part.end - part.start + 1),
      "content-range": `bytes ${part.start}-${part.end}/${size}`,
    },
  });
}

/**
 * `bytes` with `headers`, whole (200) or the part `range` asks for (206); 416 for a part that isn't there. Always says
 * it takes ranges.
 */
export function rangedResponse(bytes: Uint8Array, range: string | undefined, headers: Record<string, string>) {
  const all = { ...headers, "accept-ranges": "bytes" };
  const part = rangeOf(range, bytes.length);
  if (part === "bad") return unsatisfiable(all, bytes.length);
  const body = part ? bytes.subarray(part.start, part.end + 1) : bytes;
  return partResponse(body as Uint8Array<ArrayBuffer>, part, bytes.length, all);
}

/**
 * A stored object of `size` bytes answered as `rangedResponse` answers bytes, read from its store as it is sent: never
 * whole in memory, and only the part asked. A store that can't stream (Postgres) reads it whole first.
 */
export async function storedResponse(
  object: { store: BlobStore; key: string; size: number },
  range: string | undefined,
  headers: Record<string, string>,
): Promise<Response> {
  const all = { ...headers, "accept-ranges": "bytes" };
  const part = rangeOf(range, object.size);
  if (part === "bad") return unsatisfiable(all, object.size);
  const { store, key } = object;
  let body: Body | null;
  if (store.stream) body = await store.stream(key, part ?? undefined);
  else {
    const whole = (await store.get(key))?.body;
    body = whole ? ((part ? whole.subarray(part.start, part.end + 1) : whole) as Uint8Array<ArrayBuffer>) : null;
  }
  if (!body) throw new NotFoundError("The stored file is missing");
  return partResponse(body, part, object.size, all);
}

/** Whether `If-None-Match` (one tag, a list, weak tags or `*`) names `etag`. */
export const etagMatches = (header: string | undefined, etag: string) =>
  header?.split(",").some((tag) => {
    const t = tag.trim();
    return t === "*" || t.replace(/^W\//, "") === etag;
  }) ?? false;
