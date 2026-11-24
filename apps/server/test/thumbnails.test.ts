import { afterEach, beforeEach, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

/** A real PNG of `width`×`height` grey pixels (RGB, no filter), for the decoder. */
function png(width: number, height: number) {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = new Uint8Array(height * (1 + width * 3)).fill(180);
  for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
}

function upload(b: Browser, orgId: string, file: File, channelId?: string) {
  const form = new FormData();
  form.set("file", file);
  if (channelId) form.set("channelId", channelId);
  return t.app.request(`/api/app/organizations/${orgId}/artifacts/files`, {
    method: "POST",
    headers: { cookie: b.cookie(), origin: ORIGIN },
    body: form,
  });
}

test("a picture comes small as WebP, kept by the browser for good; anything else isn't made small", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const created = await upload(owner, orgId, new File([png(1200, 900)], "tela.png", { type: "image/png" }), channelId);
  const { id } = (await created.json()) as { id: string };
  const thumb = (w: string, version = "1", b: Browser = owner) =>
    b(`/api/app/organizations/${orgId}/artifacts/${id}/thumb?version=${version}&w=${w}`);

  const small = await thumb("480");
  expect(small.status).toBe(200);
  expect(small.headers.get("content-type")).toBe("image/webp");
  expect(small.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(small.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await new Bun.Image(new Uint8Array(await small.arrayBuffer())).metadata()).toEqual({
    width: 480,
    height: 360,
    format: "webp",
  });
  // Never bigger than the picture is.
  const big = await thumb("960");
  expect((await new Bun.Image(new Uint8Array(await big.arrayBuffer())).metadata()).width).toBe(960);

  expect((await thumb("300")).status).toBe(400);
  expect((await thumb("480", "x")).status).toBe(400);
  expect((await thumb("480", "2")).status).toBe(404);

  const pdf = await upload(owner, orgId, new File(["%PDF-1.7"], "notes.pdf", { type: "application/pdf" }));
  const pdfId = ((await pdf.json()) as { id: string }).id;
  expect((await owner(`/api/app/organizations/${orgId}/artifacts/${pdfId}/thumb?version=1&w=480`)).status).toBe(415);

  // Who can't read the file gets nothing of it.
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  await seedOrg(stranger);
  expect((await thumb("480", "1", stranger)).status).toBe(403);
});

test("a small picture is made from its own stored file: bytes changed behind one file never show for another", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const picture = () => new File([png(600, 300)], "logo.png", { type: "image/png" });
  const upload1 = (await (await upload(owner, orgId, picture())).json()) as { id: string };
  // A workspace's own bucket can change what is stored under a key; the row still names the old bytes' hash.
  const [stored] = await t.db
    .select({ key: schema.artifactVersions.blobKey })
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, upload1.id));
  await t.adapters.platformBlobs.put(stored?.key ?? "", png(100, 100), { contentType: "image/png" });
  const size = async (id: string) => {
    const res = await owner(`/api/app/organizations/${orgId}/artifacts/${id}/thumb?version=1&w=480`);
    return new Bun.Image(new Uint8Array(await res.arrayBuffer())).metadata();
  };
  expect(await size(upload1.id)).toMatchObject({ width: 100, height: 100 });
  // Another file with the same bytes (the same hash) as the first had: its own picture, not what the first now holds.
  const upload2 = (await (await upload(owner, orgId, picture())).json()) as { id: string };
  expect(await size(upload2.id)).toMatchObject({ width: 480, height: 240 });
});

test("a message's file card carries its name, type and size: the apps draw it without asking for its details", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const created = await upload(owner, orgId, new File([png(40, 30)], "tela.png", { type: "image/png" }), channelId);
  const { id } = (await created.json()) as { id: string };
  const posted = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, {
    json: { body: "", attachments: [id], clientId: "c-1" },
  });
  expect(posted.status).toBe(201);
  const message = (await posted.json()) as { meta: { artifacts: unknown[] } };
  expect(message.meta.artifacts).toEqual([
    {
      id,
      version: 1,
      title: "tela.png",
      name: "tela.png",
      contentType: "image/png",
      size: expect.any(Number),
      width: 40,
      height: 30,
    },
  ]);
});
