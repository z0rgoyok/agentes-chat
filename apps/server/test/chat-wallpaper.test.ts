import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }), env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

type Prefs = { wallpaper?: unknown; wallpapers?: Record<string, unknown> } & Record<string, unknown>;
type Me = { organizations: { id: string; chatPrefs?: Prefs }[] };

/** The smallest JPEG-shaped bytes (SOI, scan, EOI); `n` makes another file of the same shape. */
const jpeg = (n: number) =>
  Buffer.from(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, n, 0xff, 0xd9])).toString("base64");

async function setUp() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (b: typeof owner, path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const prefsOf = async (b: typeof owner) =>
    ((await (await b("/api/app/me")).json()) as Me).organizations.find((o) => o.id === orgId)?.chatPrefs ?? {};
  const channels = (await (await api(owner, "/channels")).json()) as { channels: { id: string }[] };
  const channelId = channels.channels[0]?.id;
  if (!channelId) throw new Error("no channel");
  return { owner, orgId, api, prefsOf, channelId };
}

test("one background behind every conversation: each person's own, validated, `wallpapers` never replaced here", async () => {
  const { owner, orgId, api, prefsOf } = await setUp();
  const put = (json: Record<string, unknown>) => api(owner, "/me/chat", { method: "PUT", json });

  expect((await put({ wallpaper: { kind: "sky", color: "auto" } })).status).toBe(200);
  expect((await prefsOf(owner)).wallpaper).toEqual({ kind: "sky", color: "auto" });
  expect((await put({ wallpaper: { kind: "drawings", color: "paper" } })).status).toBe(200);
  expect((await prefsOf(owner)).wallpaper).toEqual({ kind: "drawings", color: "paper" });

  // Unknown kinds and colors are refused, and the choice before stays.
  expect((await put({ wallpaper: { kind: "stripes" } })).status).toBe(400);
  expect((await put({ wallpaper: { kind: "color", color: "auto" } })).status).toBe(400);
  expect((await prefsOf(owner)).wallpaper).toEqual({ kind: "drawings", color: "paper" });

  // The conversations' own map changes one conversation at a time, never through here.
  const id = crypto.randomUUID();
  expect((await put({ wallpapers: { [id]: { kind: "agents" } } })).status).toBe(200);
  expect((await prefsOf(owner)).wallpapers).toBeUndefined();

  // Someone else's choice is untouched.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect((await prefsOf(member)).wallpaper).toBeUndefined();
});

test("a conversation's own background: set, kept beside the others, cleared; members only", async () => {
  const { owner, orgId, api, prefsOf, channelId } = await setUp();
  const set = (b: typeof owner, id: string, wallpaper: unknown) =>
    api(b, `/channels/${id}/wallpaper`, { method: "PUT", json: { wallpaper } });

  const first = await set(owner, channelId, { kind: "color", color: "sand" });
  expect(first.status).toBe(200);
  expect(((await first.json()) as Prefs).wallpapers).toEqual({ [channelId]: { kind: "color", color: "sand" } });

  // "None here" is a choice of its own, unlike no entry.
  expect((await set(owner, channelId, { kind: "none" })).status).toBe(200);
  expect((await prefsOf(owner)).wallpapers).toEqual({ [channelId]: { kind: "none" } });

  // The background for every conversation changes beside it, and the map stays.
  await api(owner, "/me/chat", { method: "PUT", json: { wallpaper: { kind: "agents" } } });
  expect(await prefsOf(owner)).toMatchObject({
    wallpaper: { kind: "agents" },
    wallpapers: { [channelId]: { kind: "none" } },
  });

  const cleared = await api(owner, `/channels/${channelId}/wallpaper`, { method: "DELETE" });
  expect(cleared.status).toBe(200);
  expect((await prefsOf(owner)).wallpapers).toEqual({});
  expect((await prefsOf(owner)).wallpaper).toEqual({ kind: "agents" });

  expect((await set(owner, channelId, { kind: "sky", color: "neon" })).status).toBe(400);
  // Not a conversation of mine.
  expect((await set(owner, crypto.randomUUID(), { kind: "agents" })).status).toBe(404);

  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect((await prefsOf(member)).wallpapers).toBeUndefined();
});

test("a background's photo: only its owner sees it, only its owner can use it, unused ones go", async () => {
  const { owner, orgId, api, prefsOf, channelId } = await setUp();
  const send = (b: typeof owner, n: number) =>
    api(b, "/me/wallpaper-photo", { method: "PUT", json: { imageBase64: jpeg(n), contentType: "image/jpeg" } });

  expect(
    (
      await api(owner, "/me/wallpaper-photo", {
        method: "PUT",
        json: { imageBase64: Buffer.from("<svg/>").toString("base64"), contentType: "image/jpeg" },
      })
    ).status,
  ).toBe(400);

  const a = (await (await send(owner, 1)).json()) as { url: string };
  expect(a.url).toMatch(/^\/api\/app\/wallpapers\/[^/]+\/[0-9a-f]{16}\.jpg$/);
  expect((await owner(a.url)).status).toBe(200);
  expect((await t.app.request(a.url)).status).toBe(401);

  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect((await member(a.url)).status).toBe(404);

  // Someone else's photo can't be anyone's background.
  const photo = (url: string) => ({ kind: "photo", url, dim: 0.4, x: 0.3, y: 0.7 });
  const stolen = await api(member, "/me/chat", { method: "PUT", json: { wallpaper: photo(a.url) } });
  expect(stolen.status).toBe(400);
  expect((await prefsOf(member)).wallpaper).toBeUndefined();

  // A new photo takes the place of one no background shows.
  const b = (await (await send(owner, 2)).json()) as { url: string };
  expect((await owner(a.url)).status).toBe(404);
  expect((await owner(b.url)).status).toBe(200);

  // One a background shows stays when another comes.
  expect(
    (await api(owner, `/channels/${channelId}/wallpaper`, { method: "PUT", json: { wallpaper: photo(b.url) } })).status,
  ).toBe(200);
  expect((await prefsOf(owner)).wallpapers?.[channelId]).toEqual(photo(b.url));
  const c = (await (await send(owner, 3)).json()) as { url: string };
  expect((await owner(b.url)).status).toBe(200);
  expect((await owner(c.url)).status).toBe(200);
});
