import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type ServerFrame, TASK_ROOM_PROTOCOL } from "@agenteschat/adapters/machine-protocol";
import { eq, schema } from "@agenteschat/db";
import { syncMachinePhones } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t.close();
});

const RUNNER = { hostname: "build-box", os: "linux", arch: "x64", version: "1.0.0", protocol: 54, workspace: "/srv/a" };
const runnerPost = (path: string, body: unknown, ip = "203.0.113.30") =>
  t.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

async function start() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "sam@example.com");
  const seeded = await seedOrg(owner);
  const as = (b: ReturnType<typeof browser>) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const rui = await joinByInvitation(t, owner, seeded.orgId, "rui@example.com");
  return { owner: as(owner), rui: as(rui), ...seeded };
}

test("connect link over HTTP: the one-line install, the computer asking to join, the maker letting it in", async () => {
  const { owner, rui } = await start();
  const made = await owner("/devices/connect-links", { json: { kind: "server" } });
  expect(made.status).toBe(201);
  const link = (await made.json()) as { id: string; code: string; commands: { unix: string; windows: string } };
  expect(link.commands.unix).toBe(`curl -fsSL ${t.config.PUBLIC_URL}/i/${link.code} | sh`);

  const script = await t.app.request(`/i/${link.code}`);
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("text/x-shellscript");
  expect(script.headers.get("cache-control")).toBe("no-store");
  expect(await script.text()).toContain(link.code);

  const asked = await runnerPost("/api/machines/device", { name: "build-box", ...RUNNER, link: link.code });
  expect(asked.status).toBe(200);
  const started = (await asked.json()) as { deviceCode: string; maker: { name: string }; org: { name: string } };
  expect(started).toMatchObject({ maker: { name: "sam" }, org: { name: "Acme" } });
  const again = await runnerPost("/api/machines/device", { name: "other", ...RUNNER, link: link.code }, "203.0.113.31");
  expect(again.status).toBe(400);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("machine.link_invalid");

  // Used: the line now says so instead of installing.
  const used = await t.app.request(`/i/${link.code}`);
  expect(await used.text()).toContain("This link expired. Make a new one under Settings › Devices.");
  const ps = await t.app.request(`/i/${link.code.toLowerCase()}/ps`);
  expect(await ps.text()).toStartWith("Write-Host (");
  expect(await (await t.app.request("/i/NOPE-NOPE")).text()).toContain("exit 1");

  const state = (await (await owner(`/devices/connect-links/${link.id}`)).json()) as {
    status: string;
    request: { id: string; name: string };
  };
  expect(state).toMatchObject({ status: "asking", request: { name: "Computador Linux do sam" } });
  expect((await rui(`/devices/connect-links/${link.id}`)).status).toBe(404);
  const listed = (await (await owner("/devices")).json()) as { requests: { id: string }[] };
  expect(listed.requests.map((r) => r.id)).toEqual([state.request.id]);
  expect((await rui(`/devices/requests/${state.request.id}/approve`, { json: {} })).status).toBe(403);

  const approved = await owner(`/devices/requests/${state.request.id}/approve`, { json: { name: "Build server" } });
  expect(approved.status).toBe(200);
  const { machineId } = (await approved.json()) as { machineId: string };
  const token = await runnerPost("/api/machines/device/token", { deviceCode: started.deviceCode });
  expect(token.status).toBe(200);
  // The computer says who may use it and where that changes, as it connects.
  const granted = (await token.json()) as { org: { id: string }; audience: string; owner: string; url: string };
  expect(granted).toMatchObject({ machineId, audience: "everyone", owner: "sam" });
  expect(granted.url).toBe(`${t.config.PUBLIC_URL}/org/${granted.org.id}/settings/devices/${machineId}`);
  const devices = (await (await rui("/devices")).json()) as {
    devices: { id: string; name: string; audience: { mode: string }; mayUse: boolean; mayManage: boolean }[];
    requests: unknown[];
  };
  expect(devices.devices).toMatchObject([
    { id: machineId, name: "Build server", audience: { mode: "everyone" }, mayUse: true, mayManage: false },
  ]);
  expect(devices.requests).toEqual([]);
});

test("a connect link's info, with no session: the workspace and its maker; one 404 for unknown and used; limited", async () => {
  const { owner } = await start();
  const link = (await (await owner("/devices/connect-links", { json: { kind: "computer" } })).json()) as {
    code: string;
    expiresAt: string;
  };
  const info = (code: string, ip = "203.0.113.40") =>
    t.app.request(`/api/machines/connect-links/${code}`, { headers: { "x-forwarded-for": ip } });

  const live = await info(link.code);
  expect(live.status).toBe(200);
  expect(await live.json()).toEqual({
    org: { name: "Acme" },
    by: { name: "sam" },
    kind: "computer",
    expiresAt: link.expiresAt,
  });
  expect((await info(link.code.replace("-", "").toLowerCase())).status).toBe(200);

  const unknown = await info("ABCD-EFGH");
  expect(unknown.status).toBe(404);
  const gone = await unknown.json();
  expect(gone).toEqual({ error: "link_expired" });
  await runnerPost("/api/machines/device", { name: "build-box", ...RUNNER, link: link.code });
  const used = await info(link.code);
  expect(used.status).toBe(404);
  expect(await used.json()).toEqual(gone);

  // 30 a minute from one address, like the install line; another address still gets its answer.
  for (let i = 0; i < 26; i++) await info("ABCD-EFGH");
  expect((await info("ABCD-EFGH")).status).toBe(429);
  expect((await info("ABCD-EFGH", "203.0.113.41")).status).toBe(404);
});

test("a computer and its phones over HTTP: rename, who can use it, stop, forget, remove", async () => {
  const { owner, rui } = await start();
  const paired = await pairComputer(t, owner, { ...RUNNER, exec: true }, { name: "MacBook" });
  const [machine] = await t.db.select().from(schema.machines).where(eq(schema.machines.id, paired.machineId));
  if (!machine) throw new Error("no machine");
  const [phone] = await syncMachinePhones(t.db, machine, [
    {
      platform: "android",
      serial: "33141FDH2000AB",
      kind: "device",
      model: "Pixel 8",
      osVersion: "16",
      state: "ready",
    },
  ]);

  expect((await rui(`/devices/computers/${machine.id}`, { method: "PATCH", json: { name: "Mine" } })).status).toBe(403);
  const renamed = await owner(`/devices/computers/${machine.id}`, {
    method: "PATCH",
    json: { name: "Sam's MacBook", audience: { mode: "everyone", userIds: [], roleIds: [] } },
  });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ name: "Sam's MacBook", audience: { mode: "everyone" } });

  const phonePatch = await owner(`/devices/phones/${phone?.id}`, { method: "PATCH", json: { name: "Test Pixel" } });
  expect(phonePatch.status).toBe(200);
  expect(await phonePatch.json()).toMatchObject({ name: "Test Pixel", hostMachineId: machine.id, mayManage: true });
  // Its computer is offline here: there is no lock left to let go, and Stop still answers.
  expect((await owner(`/devices/phones/${phone?.id}/stop`, { json: {} })).status).toBe(204);
  expect((await rui(`/devices/phones/${phone?.id}`, { method: "DELETE" })).status).toBe(403);
  expect((await owner(`/devices/phones/${phone?.id}`, { method: "DELETE" })).status).toBe(204);
  const listed = (await (await owner("/devices")).json()) as { devices: { phones: unknown[] }[] };
  expect(listed.devices[0]?.phones).toEqual([]);

  expect((await owner(`/devices/computers/${machine.id}`, { method: "DELETE" })).status).toBe(204);
  expect(((await (await owner("/devices")).json()) as { devices: unknown[] }).devices).toEqual([]);
});

test("Ligar a simulator over HTTP: a real phone refused, an old app said, an offline Mac said, the body checked", async () => {
  const { owner } = await start();
  const paired = await pairComputer(t, owner, { ...RUNNER, os: "darwin" }, { name: "MacBook" });
  const [machine] = await t.db.select().from(schema.machines).where(eq(schema.machines.id, paired.machineId));
  if (!machine) throw new Error("no machine");
  const [sim, pixel] = await syncMachinePhones(t.db, machine, [
    {
      platform: "ios",
      serial: "D54B1757",
      kind: "simulator",
      model: "iPhone 17 Pro",
      osVersion: "26.2",
      state: "ready",
    },
    {
      platform: "android",
      serial: "33141FDH2000AB",
      kind: "device",
      model: "Pixel 8",
      osVersion: "16",
      state: "ready",
    },
  ]);
  const power = (id: string | undefined, json: unknown) => owner(`/devices/phones/${id}/power`, { json });
  const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
  expect((await power(sim?.id, {})).status).toBe(400);
  const real = await power(pixel?.id, { on: true });
  expect([real.status, await code(real)]).toEqual([400, "device.not_simulator"]);
  const old = await power(sim?.id, { on: true });
  expect([old.status, await code(old)]).toEqual([409, "machine.outdated"]);
  await t.db
    .update(schema.machines)
    .set({ protocol: MACHINE_PROTOCOL_VERSION })
    .where(eq(schema.machines.id, machine.id));
  const away = await power(sim?.id, { on: true });
  expect([away.status, await code(away)]).toEqual([409, "machine.offline"]);
});

test("Wi-Fi pairing over HTTP: the computer's owner only, a checked address and code, its computer reached", async () => {
  const { owner, rui } = await start();
  const paired = await pairComputer(t, owner, { ...RUNNER, exec: true }, { name: "MacBook" });
  const path = `/devices/computers/${paired.machineId}/wifi-pairings`;
  expect((await rui(path, { json: {} })).status).toBe(403);
  for (const bad of [
    { address: "192.168.1.20:37099" },
    { address: "192.168.1.20:37099", code: "12345" },
    { address: "-s 1", code: "123456" },
    { address: "192.168.1.300:37099", code: "123456" },
  ])
    expect((await owner(path, { json: bad })).status).toBe(400);
  // Not connected now: the person is told it's offline (no runner here to pair with).
  const offline = await owner(path, { json: { address: "192.168.1.20:37099", code: "123456" } });
  expect(offline.status).toBe(409);
  expect(((await offline.json()) as { error: { code: string } }).error.code).toBe("machine.offline");
  expect((await owner(`${path}/${crypto.randomUUID()}`)).status).toBe(409);
  expect((await rui(`${path}/${crypto.randomUUID()}`, { method: "DELETE" })).status).toBe(403);
  // Cancel never fails on a computer that's gone.
  expect((await owner(`${path}/${crypto.randomUUID()}`, { method: "DELETE" })).status).toBe(204);
});

test("iPhones over Wi-Fi over HTTP: the Mac's owner only; an offline Mac offers none and can't pick one", async () => {
  const { owner, rui } = await start();
  const paired = await pairComputer(t, owner, { ...RUNNER, os: "darwin", exec: true }, { name: "MacBook" });
  const path = `/devices/computers/${paired.machineId}/wifi-iphones`;
  // A member who doesn't manage the Mac is never told which phones are near it.
  expect((await rui(path)).status).toBe(403);
  expect((await rui(`${path}/00008120-000A1B2C3D4E5F60`, { method: "PUT", json: {} })).status).toBe(403);
  const offer = await owner(path);
  expect(offer.status).toBe(200);
  expect(await offer.json()).toEqual({ available: [] });
  const picked = await owner(`${path}/00008120-000A1B2C3D4E5F60`, { method: "PUT", json: {} });
  expect(picked.status).toBe(409);
  expect(((await picked.json()) as { error: { code: string } }).error.code).toBe("machine.offline");
  expect((await owner(`${path}/${"x".repeat(201)}`, { method: "PUT", json: {} })).status).toBe(400);
});

test("fixing a Mac's Xcode over HTTP: its owner only, a kind it knows; an old app gets the Terminal way", async () => {
  const { owner, rui } = await start();
  const paired = await pairComputer(t, owner, { ...RUNNER, os: "darwin", exec: true }, { name: "MacBook" });
  const path = `/devices/computers/${paired.machineId}/xcode-fix`;
  expect((await rui(path, { json: { kind: "select" } })).status).toBe(403);
  expect((await rui(path)).status).toBe(403);
  expect((await owner(path, { json: { kind: "sudo rm" } })).status).toBe(400);
  expect((await owner(path, { json: { kind: "select", command: "x" } })).status).toBe(400);
  // This Mac's app (protocol 54) predates the fix.
  const old = await owner(path, { json: { kind: "select" } });
  expect(old.status).toBe(200);
  expect(await old.json()).toEqual({ fix: null, update: true });
  expect(await (await owner(path)).json()).toEqual({ fix: null, update: true });
  expect((await owner(path, { method: "DELETE" })).status).toBe(200);
});

test("opening Xcode on a Mac over HTTP: its owner only; an app too old opens nothing", async () => {
  const { owner, rui } = await start();
  const paired = await pairComputer(t, owner, { ...RUNNER, os: "darwin", exec: true }, { name: "MacBook" });
  const path = `/devices/computers/${paired.machineId}/xcode-open`;
  expect((await rui(path, { json: {} })).status).toBe(403);
  // This Mac's app (protocol 54) predates it, and the list says so.
  const old = await owner(path, { json: {} });
  expect(old.status).toBe(200);
  expect(await old.json()).toEqual({ opened: false });
  const list = (await (await owner("/devices")).json()) as { devices: { id: string; opensXcode: boolean }[] };
  expect(list.devices.find((d) => d.id === paired.machineId)?.opensXcode).toBe(false);
});

test("tasks at once over HTTP: the computer says its limit, its owner changes it there, an old or offline one can't", async () => {
  const { owner, rui } = await start();
  const runner = { ...RUNNER, protocol: MACHINE_PROTOCOL_VERSION, exec: true };
  const paired = await pairComputer(t, owner, runner, { name: "MacBook" });
  const hub = t.engine.machineHub;
  const sent: number[] = [];
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "limits.set") return;
      sent.push(frame.maxTasks ?? 0);
      const result = JSON.stringify({ type: "result", id: frame.id, ok: true, data: { maxTasks: frame.maxTasks } });
      setTimeout(() => void hub.message(conn, result), 1);
    },
    close() {},
  });
  const size = { cpus: 10, memoryGb: 16, diskGb: 500, maxTasks: 5 };
  await hub.message(conn, JSON.stringify({ type: "hello", token: paired.token, ...runner, size }));
  const maxTasks = async () =>
    ((await (await owner("/devices")).json()) as { devices: { id: string; maxTasks: number | null }[] }).devices.find(
      (d) => d.id === paired.machineId,
    )?.maxTasks;
  expect(await maxTasks()).toBe(5);

  const path = `/devices/computers/${paired.machineId}`;
  expect((await rui(path, { method: "PATCH", json: { maxTasks: 8 } })).status).toBe(403);
  expect((await owner(path, { method: "PATCH", json: { maxTasks: 21 } })).status).toBe(400);
  expect((await owner(path, { method: "PATCH", json: { maxTasks: 0 } })).status).toBe(400);
  const changed = await owner(path, { method: "PATCH", json: { maxTasks: 8 } });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({ maxTasks: 8 });
  expect(sent).toEqual([8]);

  // Changed on the computer itself (its app, its config file): the list follows it.
  await hub.message(conn, JSON.stringify({ type: "runner.state", paused: { paused: false }, maxTasks: 2 }));
  expect(await maxTasks()).toBe(2);

  // Not connected: nothing would apply it.
  const away = await pairComputer(t, owner, runner, { name: "Away box" });
  const offline = await owner(`/devices/computers/${away.machineId}`, { method: "PATCH", json: { maxTasks: 4 } });
  expect(offline.status).toBe(409);
  expect(((await offline.json()) as { error: { code: string } }).error.code).toBe("machine.offline");

  // An app before the limit came from the apps: no limit shown, and asking says to update it.
  const old = await pairComputer(t, owner, { ...RUNNER, exec: true }, { name: "Old box" });
  const outdated = await owner(`/devices/computers/${old.machineId}`, { method: "PATCH", json: { maxTasks: 4 } });
  expect(outdated.status).toBe(400);
  expect(((await outdated.json()) as { error: { code: string } }).error.code).toBe("machine.outdated");
  expect(sent).toEqual([8]);
});

test("tasks on room over HTTP: the computer says what fits, its owner turns Push harder on there, an older app can't", async () => {
  const { owner, rui } = await start();
  const runner = { ...RUNNER, protocol: MACHINE_PROTOCOL_VERSION, exec: true };
  const paired = await pairComputer(t, owner, runner, { name: "MacBook" });
  const hub = t.engine.machineHub;
  const asked: unknown[] = [];
  let room = { more: 6, freeGb: 5.2, cpuBusy: false, pushHarder: false };
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "limits.set") return;
      asked.push({ maxTasks: frame.maxTasks, pushHarder: frame.pushHarder });
      room = { ...room, pushHarder: frame.pushHarder === true };
      const result = JSON.stringify({ type: "result", id: frame.id, ok: true, data: { maxTasks: 5, room } });
      setTimeout(() => void hub.message(conn, result), 1);
    },
    close() {},
  });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token: paired.token,
      ...runner,
      size: { cpus: 10, memoryGb: 16, diskGb: 500, maxTasks: 5, room },
    }),
  );
  const device = async () =>
    ((await (await owner("/devices")).json()) as { devices: { id: string; taskRoom: unknown }[] }).devices.find(
      (d) => d.id === paired.machineId,
    );
  expect((await device())?.taskRoom).toEqual({ more: 6, freeGb: 5.2, cpuBusy: false, pushHarder: false });

  const path = `/devices/computers/${paired.machineId}`;
  expect((await rui(path, { method: "PATCH", json: { pushHarder: true } })).status).toBe(403);
  const on = await owner(path, { method: "PATCH", json: { pushHarder: true } });
  expect(on.status).toBe(200);
  expect(await on.json()).toMatchObject({ taskRoom: { pushHarder: true } });
  expect(asked).toEqual([{ maxTasks: undefined, pushHarder: true }]);

  // Filled up on the computer: the list follows its next reading.
  await hub.message(
    conn,
    JSON.stringify({
      type: "runner.state",
      paused: { paused: false },
      maxTasks: 5,
      room: { more: 0, freeGb: 0.6, cpuBusy: false, pushHarder: true },
    }),
  );
  expect((await device())?.taskRoom).toEqual({ more: 0, freeGb: 0.6, cpuBusy: false, pushHarder: true });

  // An app before tasks on room keeps its count, and can't take Push harder.
  const old = await pairComputer(t, owner, { ...runner, protocol: TASK_ROOM_PROTOCOL - 1 }, { name: "Old box" });
  const outdated = await owner(`/devices/computers/${old.machineId}`, { method: "PATCH", json: { pushHarder: true } });
  expect(outdated.status).toBe(400);
  expect(((await outdated.json()) as { error: { code: string } }).error.code).toBe("machine.outdated");
  expect(asked).toHaveLength(1);
});

test("help when the team's computer is full or away over HTTP: its owner turns it on and its CLIs start installing; an admin's workspace switch", async () => {
  const { owner, rui, agentId } = await start();
  await t.db.update(schema.agents).set({ brain: "claude_code" }).where(eq(schema.agents.id, agentId));
  const runner = { ...RUNNER, protocol: MACHINE_PROTOCOL_VERSION, exec: true };
  const paired = await pairComputer(t, owner, runner, { name: "MacBook" });
  const hub = t.engine.machineHub;
  const asked: unknown[] = [];
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "cli.install") return;
      asked.push({ action: frame.action, tool: frame.tool });
      const data = { install: { tool: frame.tool, state: "running" } };
      setTimeout(() => void hub.message(conn, JSON.stringify({ type: "result", id: frame.id, ok: true, data })), 1);
    },
    close() {},
  });
  await hub.message(conn, JSON.stringify({ type: "hello", token: paired.token, ...runner }));

  const path = `/devices/computers/${paired.machineId}`;
  expect((await owner(path, { method: "PATCH", json: { spill: { own: false } } })).status).toBe(200);
  expect((await rui(path, { method: "PATCH", json: { spill: { own: true } } })).status).toBe(403);
  const on = await owner(path, { method: "PATCH", json: { spill: { own: true } } });
  expect(on.status).toBe(200);
  expect(await on.json()).toMatchObject({ spill: { own: true } });
  expect(asked).toEqual([{ action: "start", tool: "claude" }]);

  const list = async () => ((await (await owner("/devices")).json()) as { devicesHelp: boolean }).devicesHelp;
  expect(await list()).toBe(true);
  expect((await rui("/devices/help", { method: "PUT", json: { on: false } })).status).toBe(403);
  expect(await (await owner("/devices/help", { method: "PUT", json: { on: false } })).json()).toEqual({ on: false });
  expect(await list()).toBe(false);
});
