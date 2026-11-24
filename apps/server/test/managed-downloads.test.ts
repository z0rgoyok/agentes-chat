import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerManagedDownloads } from "../src/managed-downloads";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("only the explicitly published APK is public; missing release returns 404", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooms-download-"));
  dirs.push(dir);
  const app = new OpenAPIHono();
  registerManagedDownloads(app, dir);
  expect((await app.request("/downloads/tich-rooms.apk")).status).toBe(404);
  await mkdir(join(dir, "managed-releases"));
  await Bun.write(join(dir, "managed-releases/tich-rooms.apk"), "signed-apk-fixture");
  await Bun.write(join(dir, "private.txt"), "private-fixture");
  const res = await app.request("/downloads/tich-rooms.apk");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
  expect(res.headers.get("content-disposition")).toContain("attachment;");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(await res.text()).toBe("signed-apk-fixture");
  for (const path of ["/downloads/private.txt", "/downloads/../private.txt", "/downloads/%2e%2e/private.txt"])
    expect((await app.request(path)).status).toBe(404);
});
