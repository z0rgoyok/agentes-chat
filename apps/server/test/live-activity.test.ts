import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { LIVE_ACTIVITY_JOB } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, signUp, type TestServer } from "./harness";

/** The phone's Live Activity registration (ADR 0210): `POST`/`DELETE /api/app/push/live-activity`. */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const MOBILE = { "x-agentes-client": "mobile" };
const START = "c".repeat(160);
const ACTIVITY = "d".repeat(160);
const WIDGETS = "file:///private/var/mobile/Containers/Shared/AppGroup/0A1B2C3D/widgets";

/** A request the way the app sends it: no Origin, the app header, the stored cookie. */
const fromApp = (b: Browser, init: { method?: string; json?: unknown } = {}) =>
  b("/api/app/push/live-activity", { method: "POST", ...init, origin: null, headers: MOBILE });

const rows = () => t.db.select().from(schema.liveActivityDevices);

describe("Live Activity registration", () => {
  test("registers, replaces the activity, refuses junk, removes only one's own", async () => {
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const device = { installId: "install-1", pushToStartToken: START, widgetsDir: WIDGETS, locale: "pt-BR" };

    for (const bad of [
      { ...device, pushToStartToken: "not-hex" },
      { ...device, pushToStartToken: "0".repeat(63) },
      { ...device, activity: { id: "act-1", token: "ExponentPushToken[x]" } },
      { ...device, activity: { id: "", token: ACTIVITY } },
      { ...device, widgetsDir: "widgets" },
      { ...device, widgetsDir: "https://example.com/widgets" },
      { ...device, installId: "has spaces" },
      { ...device, installId: "x".repeat(201) },
      { ...device, appId: "not a bundle id" },
      { ...device, sandbox: "yes" },
      { pushToStartToken: START, widgetsDir: WIDGETS },
    ]) {
      expect({ bad, status: (await fromApp(ana, { json: bad })).status }).toEqual({ bad, status: 400 });
    }

    expect((await fromApp(ana, { json: { ...device, appId: "chat.agentes.app", sandbox: true } })).status).toBe(204);
    expect(await rows()).toMatchObject([
      {
        installId: "install-1",
        pushToStartToken: START,
        activityId: null,
        activityToken: null,
        widgetsDir: WIDGETS,
        appId: "chat.agentes.app",
        apnsSandbox: true,
        locale: "pt-BR",
      },
    ]);
    // Its person's activity is computed again a moment later.
    const jobs = await t.db.select().from(schema.outbox).where(eq(schema.outbox.kind, LIVE_ACTIVITY_JOB));
    expect(jobs.map((j) => j.payload)).toEqual([{ userId: (await rows())[0]?.userId }]);

    // The activity the push started hands its token over; a new one replaces it; none runs any more.
    await t.db.update(schema.liveActivityDevices).set({ startedAt: new Date() });
    const withActivity = { ...device, activity: { id: "act-1", token: ACTIVITY } };
    expect((await fromApp(ana, { json: withActivity })).status).toBe(204);
    expect(await rows()).toMatchObject([{ activityId: "act-1", activityToken: ACTIVITY, startedAt: null }]);
    const next = { ...device, activity: { id: "act-2", token: START } };
    expect((await fromApp(ana, { json: next })).status).toBe(204);
    expect(await rows()).toMatchObject([{ activityId: "act-2", activityToken: START, appId: "chat.agentes.app" }]);
    // Left out, a field stays; null clears it.
    expect((await fromApp(ana, { json: { installId: "install-1", widgetsDir: WIDGETS } })).status).toBe(204);
    expect(await rows()).toMatchObject([{ activityId: "act-2", pushToStartToken: START }]);
    const none = { installId: "install-1", widgetsDir: "/private/var/widgets", activity: null, pushToStartToken: null };
    expect((await fromApp(ana, { json: none })).status).toBe(204);
    expect(await rows()).toMatchObject([
      { activityId: null, activityToken: null, pushToStartToken: null, widgetsDir: "/private/var/widgets" },
    ]);

    // Someone else's delete is a no-op; one's own removes it.
    const bia = browser(t);
    await signUp(bia, "bia@example.com");
    const forget = { method: "DELETE", json: { installId: "install-1" } };
    expect((await fromApp(bia, forget)).status).toBe(204);
    expect(await rows()).toHaveLength(1);
    expect((await fromApp(ana, { method: "DELETE", json: {} })).status).toBe(400);
    expect((await fromApp(ana, forget)).status).toBe(204);
    expect(await rows()).toEqual([]);
  });

  test("a session is needed, and a browser's write needs its own origin", async () => {
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const device = { installId: "install-1", widgetsDir: WIDGETS };
    expect((await fromApp(browser(t), { json: device })).status).toBe(401);
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const path = "/api/app/push/live-activity";
    expect((await ana(path, { json: device, origin: "https://evil.example" })).status).toBe(403);
    expect((await ana(path, { json: device, origin: null })).status).toBe(403);
    expect(await rows()).toEqual([]);
    expect((await ana(path, { json: device })).status).toBe(204);
    expect(await rows()).toMatchObject([{ installId: "install-1", locale: "en", pushToStartToken: null }]);
  });
});
