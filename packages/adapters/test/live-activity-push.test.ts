import { describe, expect, test } from "bun:test";
import {
  createFakePushSender,
  createPhonePushSender,
  type LiveActivityMessage,
  PushError,
  type PushMessage,
} from "../src/push";
import {
  APNS_ACTIVITY_TOKEN,
  APNS_ORIGIN,
  APNS_SANDBOX_ORIGIN,
  type ApnsKey,
  apnsLiveActivityRequest,
  createApnsPushSender,
  type Http2Client,
} from "../src/push-apns";
import { createRelayPushSender, type RelayCredentials } from "../src/push-relay";

/** Live Activity pushes (ADR 0210): Apple's request, the APNs sender, the phones' sender, the push relay's client. */

const APP = "chat.agentes.app";
const RELAY_URL = "https://relay.example/api/push-relay/v1";
const NOW = 1_800_000_000_000;

/** An activity's push token (longer than a device token). */
const token = (n: number) => String(n).padStart(160, "b");

const PROPS = JSON.stringify({
  v: 1,
  tone: "working",
  headline: "Iris",
  trailing: null,
  agents: [],
  more: 0,
  url: "x",
});

const update = (n: number, extra: Partial<LiveActivityMessage> = {}): LiveActivityMessage => ({
  to: token(n),
  event: "update",
  contentState: { name: "AgentsActivity", props: PROPS },
  timestamp: NOW / 1000,
  staleDate: NOW / 1000 + 1800,
  priority: 5,
  ...extra,
});

const start = (n: number): LiveActivityMessage => ({
  to: token(n),
  event: "start",
  contentState: { name: "AgentsActivity", props: PROPS },
  timestamp: NOW / 1000,
  staleDate: NOW / 1000 + 600,
  alert: { title: "Iris", body: "Programando · #geral" },
  attributesType: "LiveActivityAttributes",
  attributes: { url: "agenteschat://island?org=o&channel=c" },
  inputPushToken: true,
  priority: 10,
  apns: { topic: APP, sandbox: true },
});

async function testKey(): Promise<ApnsKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { key: pem, keyId: "ABC123DEFG", teamId: "XYZ987WVUT" };
}

type Call = { origin: string; path: string; headers: Record<string, string>; body: unknown };

function fakeApns(answer: (call: Call) => { status: number; body?: unknown } = () => ({ status: 200 })) {
  const calls: Call[] = [];
  const http2: Http2Client = {
    async request(origin, request) {
      const call = { origin, path: request.path, headers: request.headers, body: JSON.parse(request.body) };
      calls.push(call);
      const got = answer(call);
      return { status: got.status, body: got.body === undefined ? "" : JSON.stringify(got.body) };
    },
    close() {},
  };
  return { http2, calls };
}

describe("Live Activity request to APNs", () => {
  test("Apple's liveactivity push type on the app's Live Activity topic, the props a JSON string", () => {
    const { headers, body } = apnsLiveActivityRequest(update(1), APP, NOW);
    expect(headers).toEqual({
      "apns-topic": "chat.agentes.app.push-type.liveactivity",
      "apns-push-type": "liveactivity",
      "apns-priority": "5",
      "apns-expiration": String(NOW / 1000 + 3600),
      "content-type": "application/json",
    });
    expect(body).toEqual({
      aps: {
        timestamp: NOW / 1000,
        event: "update",
        "content-state": { name: "AgentsActivity", props: PROPS },
        "stale-date": NOW / 1000 + 1800,
      },
    });
    // expo-widgets decodes `props` from a string; fields set straight in the content state would be ignored.
    expect(typeof body.aps["content-state"].props).toBe("string");
  });

  test("a start carries its alert, its attributes and asks for the activity's own token", () => {
    const { headers, body } = apnsLiveActivityRequest(start(1), APP, NOW);
    expect(headers["apns-priority"]).toBe("10");
    expect(body).toEqual({
      aps: {
        timestamp: NOW / 1000,
        event: "start",
        "content-state": { name: "AgentsActivity", props: PROPS },
        "stale-date": NOW / 1000 + 600,
        alert: { title: "Iris", body: "Programando · #geral" },
        "attributes-type": "LiveActivityAttributes",
        attributes: { url: "agenteschat://island?org=o&channel=c" },
        "input-push-token": 1,
      },
    });
  });

  test("an end keeps its dismissal date and lasts until the system would end it itself", () => {
    const end = update(1, { event: "end", dismissalDate: NOW / 1000 + 240, staleDate: undefined, priority: 10 });
    const { headers, body } = apnsLiveActivityRequest(end, APP, NOW);
    expect(headers["apns-expiration"]).toBe(String(NOW / 1000 + 8 * 3600));
    expect(body.aps).toEqual({
      timestamp: NOW / 1000,
      event: "end",
      "content-state": { name: "AgentsActivity", props: PROPS },
      "dismissal-date": NOW / 1000 + 240,
    });
  });

  test("an activity token is hex, as a device token, and may be longer", () => {
    expect(APNS_ACTIVITY_TOKEN.test(token(1))).toBe(true);
    expect(APNS_ACTIVITY_TOKEN.test("0".repeat(64))).toBe(true);
    expect(APNS_ACTIVITY_TOKEN.test("0".repeat(63))).toBe(false);
    expect(APNS_ACTIVITY_TOKEN.test("z".repeat(80))).toBe(false);
    expect(APNS_ACTIVITY_TOKEN.test("0".repeat(401))).toBe(false);
  });
});

describe("APNs sender, Live Activities", () => {
  test("to the activity's token, in the environment it belongs to, with the shared provider token", async () => {
    const apns = fakeApns();
    const sender = createApnsPushSender({ key: await testKey(), appIds: [APP], http2: apns.http2, now: () => NOW });
    const results = await sender.sendLiveActivity([update(1), start(2)]);
    expect(results).toEqual([
      { token: token(1), ok: true, unregistered: false },
      { token: token(2), ok: true, unregistered: false },
    ]);
    expect(apns.calls.map((c) => [c.origin, c.path, c.headers["apns-topic"], c.headers["apns-push-type"]])).toEqual([
      [APNS_ORIGIN, `/3/device/${token(1)}`, `${APP}.push-type.liveactivity`, "liveactivity"],
      [APNS_SANDBOX_ORIGIN, `/3/device/${token(2)}`, `${APP}.push-type.liveactivity`, "liveactivity"],
    ]);
    expect(apns.calls[0]?.headers.authorization).toStartWith("bearer ");
    expect(apns.calls[1]?.headers.authorization).toBe(apns.calls[0]?.headers.authorization);
  });

  test("an ended activity's token is gone; an app outside APNS_APP_IDS and a token that isn't hex never leave", async () => {
    const apns = fakeApns(() => ({ status: 410, body: { reason: "Unregistered" } }));
    const sender = createApnsPushSender({ key: await testKey(), appIds: [APP], http2: apns.http2 });
    const results = await sender.sendLiveActivity([
      update(1),
      update(2, { apns: { topic: "com.example.other" } }),
      update(3, { to: "not-a-token" }),
    ]);
    expect(results[0]).toMatchObject({ token: token(1), ok: false, unregistered: true });
    expect(results[1]).toMatchObject({ ok: false, unregistered: false, retryable: false });
    expect(results[1]?.error).toContain("APNS_APP_IDS");
    expect(results[2]).toEqual({
      token: "not-a-token",
      ok: false,
      unregistered: true,
      error: "not an APNs activity token",
    });
    expect(apns.calls.map((c) => c.path)).toEqual([`/3/device/${token(1)}`]);
  });
});

describe("phones' sender, Live Activities", () => {
  test("the iPhones' sender sends them; with none, they come back skipped; the fake records them", async () => {
    const ios = createFakePushSender({ unregistered: [token(2)] });
    const phones = createPhonePushSender({ android: createFakePushSender(), ios });
    expect(await phones.sendLiveActivity?.([update(1), update(2)])).toEqual([
      { token: token(1), ok: true, unregistered: false },
      { token: token(2), ok: false, unregistered: true, error: "DeviceNotRegistered" },
    ]);
    expect(ios.liveActivities.map((m) => m.to)).toEqual([token(1)]);
    expect(ios.sent).toEqual([]);

    const none = createPhonePushSender({ android: createFakePushSender(), ios: null });
    expect(await none.sendLiveActivity?.([update(1)])).toEqual([
      {
        token: token(1),
        ok: false,
        unregistered: false,
        skipped: true,
        error: "this server sends no Live Activity push",
      },
    ]);
  });
});

function memoryCredentials(): RelayCredentials {
  let saved: { instanceId: string; secret: string } | null = null;
  return {
    get: async () => saved,
    save: async (c) => {
      saved = c;
    },
    clear: async () => {
      saved = null;
    },
  };
}

/** A relay in memory that knows Live Activities (`known`), or one from before them. */
function fakeRelay(options: { known?: boolean; gone?: string[] } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const handler = (async (url: string, init: RequestInit) => {
    const path = url.slice(RELAY_URL.length);
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    if (path === "/instances") return Response.json({ instanceId: "i", secret: "s" }, { status: 201 });
    if (path === "/live-activities" && options.known !== false) {
      const list = body.activities as LiveActivityMessage[];
      return Response.json({
        results: list.map((m) =>
          options.gone?.includes(m.to)
            ? { token: m.to, ok: false, unregistered: true, error: "Unregistered" }
            : { token: m.to, ok: true, unregistered: false },
        ),
      });
    }
    if (path === "/send") {
      const list = body.messages as PushMessage[];
      return Response.json({ results: list.map((m) => ({ token: m.to, ok: true, unregistered: false })) });
    }
    return Response.json({ error: { code: "not_found", message: "Route not found" } }, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: handler, calls };
}

describe("push relay client, Live Activities", () => {
  test("every field Apple gets goes to the relay's own path; its answers come back in order", async () => {
    const relay = fakeRelay({ gone: [token(2)] });
    const sender = createRelayPushSender({ url: RELAY_URL, credentials: memoryCredentials(), fetch: relay.fetch });
    const results = await sender.sendLiveActivity?.([start(1), update(2), update(3, { to: "not-hex" })]);
    expect(results).toEqual([
      { token: token(1), ok: true, unregistered: false },
      { token: token(2), ok: false, unregistered: true, error: "Unregistered" },
      { token: "not-hex", ok: false, unregistered: true, error: "not an APNs activity token" },
    ]);
    const sent = relay.calls.find((c) => c.path === "/live-activities")?.body.activities;
    expect(sent).toEqual([start(1), update(2)]);
  });

  test("a relay from before Live Activities sends none: skipped, nothing retried", async () => {
    const relay = fakeRelay({ known: false });
    const sender = createRelayPushSender({ url: RELAY_URL, credentials: memoryCredentials(), fetch: relay.fetch });
    expect(await sender.sendLiveActivity?.([update(1)])).toEqual([
      { token: token(1), ok: false, unregistered: false, skipped: true, error: "the push relay sends none" },
    ]);
  });

  test("a relay failing is the outbox's to retry", async () => {
    const failing = (async (url: string) =>
      url.endsWith("/instances")
        ? Response.json({ instanceId: "i", secret: "s" }, { status: 201 })
        : Response.json(
            { error: { code: "upstream_failed", message: "APNs down" } },
            { status: 502 },
          )) as unknown as typeof fetch;
    const sender = createRelayPushSender({ url: RELAY_URL, credentials: memoryCredentials(), fetch: failing });
    const error = await sender.sendLiveActivity?.([update(1)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushError);
    expect((error as PushError).retryable).toBe(true);
  });
});
