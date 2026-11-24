import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiskBlobStore, createMemoryBlobStore } from "@agenteschat/adapters";
import { NotFoundError } from "@agenteschat/engine";
import { etagMatches, storedResponse } from "../src/http/byte-range";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentes-range-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const headers = { "content-type": "video/mp4" };

test("a stored object in parts: streamed from a store that can, read whole first from one that can't", async () => {
  // The disk streams its part; memory, as Postgres, has no stream.
  for (const store of [createDiskBlobStore(dir), createMemoryBlobStore({ sign: false })]) {
    await store.put("orgs/o1/clip", new TextEncoder().encode("0123456789"), { contentType: "video/mp4" });
    const object = { store, key: "orgs/o1/clip", size: 10 };
    const whole = await storedResponse(object, undefined, headers);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe("10");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(await whole.text()).toBe("0123456789");
    const part = await storedResponse(object, "bytes=2-5", headers);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("content-length")).toBe("4");
    expect(part.headers.get("content-type")).toBe("video/mp4");
    expect(await part.text()).toBe("2345");
    expect(await (await storedResponse(object, "bytes=-3", headers)).text()).toBe("789");
    const past = await storedResponse(object, "bytes=10-", headers);
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */10");
    const gone = { ...object, key: "orgs/o1/gone" };
    await expect(storedResponse(gone, undefined, headers)).rejects.toBeInstanceOf(NotFoundError);
  }
});

test("If-None-Match names the tag: alone, in a list, weak, or any", () => {
  expect(etagMatches('"abc"', '"abc"')).toBe(true);
  expect(etagMatches('"x", W/"abc"', '"abc"')).toBe(true);
  expect(etagMatches("*", '"abc"')).toBe(true);
  expect(etagMatches('"abcd"', '"abc"')).toBe(false);
  expect(etagMatches(undefined, '"abc"')).toBe(false);
});
