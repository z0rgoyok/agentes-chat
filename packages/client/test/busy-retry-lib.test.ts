import { expect, test } from "bun:test";
import { ApiError, createRequester } from "../src/api/http";
import { BUSY_RETRIES, busyRetryDelay, retryBusy } from "../src/lib/busy-retry";

const busy = new ApiError(503, "server_busy", "busy", undefined, 7_000);

test("a read the server was too busy for is tried again after the wait it asked for, the rest as before", () => {
  const retry = retryBusy((count) => count < 1);
  expect(retry(BUSY_RETRIES - 1, busy)).toBe(true);
  expect(retry(BUSY_RETRIES, busy)).toBe(false);
  expect(retry(0, new ApiError(500, "internal_error", "x"))).toBe(true);
  expect(retry(1, new ApiError(500, "internal_error", "x"))).toBe(false);
  expect(busyRetryDelay(0, busy)).toBe(7_000);
  expect(busyRetryDelay(2, new ApiError(503, "http_503", "proxy"))).toBe(4_000);
  expect(busyRetryDelay(9, new Error("x"))).toBe(30_000);
});

test("a busy server's Retry-After reaches the ApiError", async () => {
  const fetch = (async () =>
    Response.json(
      { error: { code: "server_busy", message: "busy" } },
      { status: 503, headers: { "retry-after": "9" } },
    )) as unknown as typeof globalThis.fetch;
  const error = await createRequester({ fetch })("/a").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).retryAfterMs).toBe(9_000);
});
