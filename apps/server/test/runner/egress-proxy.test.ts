import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { EGRESS_DIRECT_HOSTS, STREAM_CLOSE } from "@agenteschat/adapters/machine-protocol";
import { accountSettingsEnv } from "../../runner/accounts";
import { chromeLaunchArgs } from "../../runner/browser";
import {
  EGRESS_PROXY_FILE,
  EGRESS_QUIET_MS,
  EGRESS_RELAY_POLICY,
  egressProxyChromeArgs,
  egressProxyEnv,
  hasOwnProxy,
  parseHttpConnect,
  setEgressProxy,
  startEgressProxy,
  writeEgressPolicy,
} from "../../runner/egress-relay";
import { type HandlerContext, handleRequest } from "../../runner/handlers";
import { renderRuleset } from "../../runner/loopback-guard";
import { agentSecrets } from "../../runner/secrets";
import type { DataListener, DataSocket } from "../../runner/streams";

// ADR 0237 on a self-hosted server: a computer that borrows a person's internet without the Cloud's guard.

const cleanup: (() => void)[] = [];
afterEach(() => {
  setEgressProxy(null);
  for (const fn of cleanup.splice(0)) fn();
});

async function until(done: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (done()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function fakeData() {
  const sent: Uint8Array[] = [];
  let listener: DataListener | null = null;
  const socket: DataSocket = {
    send: (data) => {
      if (typeof data !== "string") sent.push(data);
    },
    close: () => listener?.closed(),
    bufferedAmount: 0,
    listen: (on) => {
      listener = on;
    },
  };
  return { socket, sent, peer: (bytes: Uint8Array) => listener?.bytes(bytes) };
}

const home = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "egress-proxy-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A local server standing in for a public site reached the computer's own way. */
async function site(): Promise<{ port: number; heard: string[] }> {
  const heard: string[] = [];
  const server: Server = createServer((c) => c.on("data", (d) => heard.push(d.toString()) && c.write("direct!")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanup.push(() => server.close());
  return { port: (server.address() as { port: number }).port, heard };
}

async function ask(port: number, head: string, then?: string) {
  const client: Socket = connect(port, "127.0.0.1");
  cleanup.push(() => client.destroy());
  let got = "";
  client.on("data", (d: Buffer) => {
    got += d.toString("latin1");
  });
  client.write(head);
  await until(() => got.includes("\r\n\r\n") || got.length >= 10, "the proxy's answer");
  if (then) client.write(then);
  return { client, got: () => got };
}

const CONNECT = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

test("an HTTP CONNECT request: its target, more bytes needed, or not one", () => {
  expect(parseHttpConnect(Buffer.from(CONNECT("shop.example:443")))).toEqual({
    host: "shop.example",
    port: 443,
    length: CONNECT("shop.example:443").length,
  });
  expect(parseHttpConnect(Buffer.from(CONNECT("[2001:db8::1]:443")))).toMatchObject({ host: "2001:db8::1" });
  expect(parseHttpConnect(Buffer.from("CONNECT shop.example:443 HTTP/1.1\r\n"))).toBeNull();
  expect(parseHttpConnect(Buffer.from("GET http://shop.example/ HTTP/1.1\r\n\r\n"))).toBe(false);
  expect(parseHttpConnect(Buffer.from(CONNECT("shop.example:99999")))).toBe(false);
});

test("lent: any port but 25 through the lending computer; 25, nothing lent or a refusal go the computer's own way", async () => {
  const data = fakeData();
  const target = await site();
  const asked: { host: string; port: number }[] = [];
  let answer: number | null = null;
  let clock = 0;
  const proxy = await startEgressProxy({
    home: home(),
    lent: () => true,
    now: () => clock,
    resolve: async (host) => (host.endsWith(".lan.example") ? ["10.0.0.7"] : ["93.184.216.34"]),
    connect: (_host, _port) => connect(target.port, "127.0.0.1"),
    dial: async (_id, t) => {
      asked.push(t);
      if (answer !== null) throw Object.assign(new Error("no"), { closeCode: answer });
      return data.socket;
    },
  });
  cleanup.push(() => proxy.close());

  // HTTP CONNECT, carried by the lending computer, bytes both ways.
  const lent = await ask(proxy.port, CONNECT("shop.example:443"), "hello");
  expect(lent.got()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
  await until(() => data.sent.length > 0, "bytes to the lender");
  expect(new TextDecoder().decode(data.sent[0])).toBe("hello");
  data.peer(new TextEncoder().encode("lent!"));
  await until(() => lent.got().endsWith("lent!"), "bytes back");

  // SOCKS5 over the same port.
  const socks = connect(proxy.port, "127.0.0.1");
  cleanup.push(() => socks.destroy());
  const heard: Buffer[] = [];
  socks.on("data", (d: Buffer) => heard.push(d));
  socks.write(Buffer.from([5, 1, 0]));
  socks.write(Buffer.from([5, 1, 0, 3, 12, ...Buffer.from("shop.example"), 1, 187]));
  await until(() => Buffer.concat(heard).length >= 12, "the SOCKS replies");
  expect([...Buffer.concat(heard).subarray(0, 4)]).toEqual([5, 0, 5, 0]);

  // SSH goes through the lending computer too; mail's port 25 never asks the server.
  expect((await ask(proxy.port, CONNECT("git.example:22"), "ssh")).got()).toStartWith("HTTP/1.1 200");
  await until(() => data.sent.some((b) => new TextDecoder().decode(b) === "ssh"), "SSH bytes to the lender");
  const mail = await ask(proxy.port, CONNECT("mx.example:25"), "helo");
  expect(mail.got()).toStartWith("HTTP/1.1 200");
  await until(() => target.heard.includes("helo"), "the direct bytes");
  expect(asked.map((t) => t.port)).toEqual([443, 443, 22]);

  // The lending computer refused that destination, or a server older than this runner its port: the computer's own
  // way, and it asks again next time.
  answer = STREAM_CLOSE.refused;
  expect((await ask(proxy.port, CONNECT("shop.example:443"))).got()).toStartWith("HTTP/1.1 200");
  answer = STREAM_CLOSE.badRequest;
  expect((await ask(proxy.port, CONNECT("git.example:22"))).got()).toStartWith("HTTP/1.1 200");
  expect(asked.length).toBe(5);
  // No such site: no other way finds it either.
  answer = STREAM_CLOSE.notFound;
  expect((await ask(proxy.port, CONNECT("shop.example:443"))).got()).toStartWith("HTTP/1.1 504");
  // Another port the lending computer couldn't reach (its network blocks it): the computer's own way, as before.
  expect((await ask(proxy.port, CONNECT("db.example:5432"))).got()).toStartWith("HTTP/1.1 200");
  // Nothing lent now: direct, and the server isn't asked again for a minute.
  answer = STREAM_CLOSE.unreachable;
  expect((await ask(proxy.port, CONNECT("shop.example:443"))).got()).toStartWith("HTTP/1.1 200");
  const before = asked.length;
  answer = null;
  expect((await ask(proxy.port, CONNECT("shop.example:443"))).got()).toStartWith("HTTP/1.1 200");
  expect(asked.length).toBe(before);
  clock += EGRESS_QUIET_MS;
  await ask(proxy.port, CONNECT("shop.example:443"));
  expect(asked.length).toBe(before + 1);

  // The computer's own way reaches public addresses only: never its own network.
  answer = STREAM_CLOSE.refused;
  expect((await ask(proxy.port, CONNECT("nas.lan.example:22"))).got()).toStartWith("HTTP/1.1 403");
  expect((await ask(proxy.port, CONNECT("127.0.0.1:5432"))).got()).toStartWith("HTTP/1.1 403");
});

test("not lent: everything goes the computer's own way; the port is kept across restarts", async () => {
  const dir = home();
  const target = await site();
  let dials = 0;
  const start = () =>
    startEgressProxy({
      home: dir,
      lent: () => false,
      resolve: async () => ["93.184.216.34"],
      connect: () => connect(target.port, "127.0.0.1"),
      dial: async () => {
        dials++;
        throw new Error("never");
      },
    });
  const first = await start();
  expect((await ask(first.port, CONNECT("shop.example:443"))).got()).toStartWith("HTTP/1.1 200");
  expect(dials).toBe(0);
  expect(JSON.parse(readFileSync(path.join(dir, EGRESS_PROXY_FILE), "utf8"))).toEqual({ port: first.port });
  first.close();
  await Bun.sleep(20);
  const again = await start();
  cleanup.push(() => again.close());
  // Processes started before keep a working address.
  expect(again.port).toBe(first.port);
});

test("what agents get while the computer borrows: proxy settings, the model services and private ranges direct", async () => {
  expect(egressProxyEnv()).toEqual({});
  expect(egressProxyChromeArgs()).toEqual([]);
  setEgressProxy({ port: 41234, direct: ["agentes.example.com"] });
  const env = egressProxyEnv(["llm.plan.example"]);
  expect(env).toMatchObject({
    HTTPS_PROXY: "http://127.0.0.1:41234",
    ALL_PROXY: "socks5h://127.0.0.1:41234",
    NODE_USE_ENV_PROXY: "1",
  });
  expect(env.HTTP_PROXY).toBeUndefined();
  const none = (env.NO_PROXY ?? "").split(",");
  for (const h of ["localhost", "10.0.0.0/8", ".anthropic.com", "agentes.example.com", "llm.plan.example"])
    expect(none).toContain(h);
  for (const h of EGRESS_DIRECT_HOSTS) expect(none).toContain(h);

  // Every command an agent runs, its CLIs' included.
  expect((await agentSecrets(undefined, { id: "a1", handle: "ada" }))?.env).toMatchObject({
    HTTPS_PROXY: "http://127.0.0.1:41234",
  });
  // Claude Code's own settings: the proxy for its commands, its endpoint kept direct; the runner's own proxy wins.
  const claude = accountSettingsEnv(undefined, "opus", {});
  expect(claude.HTTPS_PROXY).toBe("http://127.0.0.1:41234");
  expect(claude.NO_PROXY?.split(",")).toContain("api.anthropic.com");
  expect(accountSettingsEnv(undefined, "opus", { HTTPS_PROXY: "http://corp:3128" }).HTTPS_PROXY).toBe(
    "http://corp:3128",
  );
  expect(hasOwnProxy({ https_proxy: "http://corp:3128" })).toBe(true);
  expect(hasOwnProxy({})).toBe(false);
  // Agents in a network of their own: a namespace's 127.0.0.1 never reaches the proxy, and a mark's route stays theirs.
  expect(hasOwnProxy({}, { networkLauncher: "/usr/local/libexec/agent-net" })).toBe(true);
  expect(hasOwnProxy({}, { networkMark: 0x100 })).toBe(true);
  expect(hasOwnProxy({}, {})).toBe(false);

  // Chrome: through the proxy, names resolved by the lending computer, WebRTC kept off UDP.
  const args = chromeLaunchArgs("130.0.0.0", "/p", "linux", null, false, "about:blank", 0, undefined, true, [
    ...egressProxyChromeArgs(),
  ]);
  expect(args).toContain("--proxy-server=socks5://127.0.0.1:41234");
  expect(args.find((a) => a.startsWith("--proxy-bypass-list="))).toContain("*.anthropic.com");
  expect(args.filter((a) => a === "--force-webrtc-ip-handling-policy=disable_non_proxied_udp")).toHaveLength(1);
});

test("lent only: nothing goes the computer's own way but after the server's \"nothing lent\"; AI hosts go through too", async () => {
  const data = fakeData();
  const target = await site();
  let answer: number | null = STREAM_CLOSE.notFound;
  const proxy = await startEgressProxy({
    home: home(),
    lent: () => true,
    only: () => true,
    resolve: async () => ["93.184.216.34"],
    connect: () => connect(target.port, "127.0.0.1"),
    dial: async () => {
      if (answer !== null) throw Object.assign(new Error("no"), { closeCode: answer });
      return data.socket;
    },
  });
  cleanup.push(() => proxy.close());
  // The computer lent only is offline, refused it, or the server is away: the connection fails, never direct.
  expect((await ask(proxy.port, CONNECT("shop.example:443"))).got()).toStartWith("HTTP/1.1 504");
  answer = STREAM_CLOSE.refused;
  expect((await ask(proxy.port, CONNECT("git.example:22"))).got()).toStartWith("HTTP/1.1 403");
  answer = STREAM_CLOSE.internal;
  expect((await ask(proxy.port, CONNECT("shop.example:443"))).got()).toStartWith("HTTP/1.1 502");
  // Mail's port is never lent, so it never goes out at all.
  expect((await ask(proxy.port, CONNECT("mx.example:25"))).got()).toStartWith("HTTP/1.1 403");
  // "Nothing lent" (no computer lent only any more): the usual way, and no minute of quiet.
  answer = STREAM_CLOSE.unreachable;
  expect((await ask(proxy.port, CONNECT("shop.example:443"))).got()).toStartWith("HTTP/1.1 200");
  answer = null;
  expect((await ask(proxy.port, CONNECT("shop.example:443"))).got()).toStartWith("HTTP/1.1 200");
  expect(target.heard).toEqual([]);

  // The AI CLIs' services and a Claude Code turn's endpoint go through the proxy too.
  setEgressProxy({ port: 41234, direct: ["agentes.example.com"], only: true });
  const none = (egressProxyEnv(["llm.plan.example"]).NO_PROXY ?? "").split(",");
  expect(none).toContain("agentes.example.com");
  expect(none).toContain("10.0.0.0/8");
  for (const h of [...EGRESS_DIRECT_HOSTS, "llm.plan.example"]) expect(none).not.toContain(h);
  expect(accountSettingsEnv(undefined, "opus", {}).NO_PROXY?.split(",")).not.toContain("api.anthropic.com");
  expect(egressProxyChromeArgs().find((a) => a.startsWith("--proxy-bypass-list="))).not.toContain("anthropic");
});

test("the Cloud's guard reads what keeps its usual way next to the socket: the AI hosts, none when lent only", async () => {
  const dir = home();
  const read = () => JSON.parse(readFileSync(path.join(dir, EGRESS_RELAY_POLICY), "utf8"));
  writeEgressPolicy(dir, false);
  expect(read()).toEqual({ only: false, direct: [...EGRESS_DIRECT_HOSTS] });
  writeEgressPolicy(dir, true);
  expect(read()).toEqual({ only: true, direct: [] });
});

test("the server says whether the workspace uses only lent internet: egress.only", async () => {
  const told: boolean[] = [];
  const ctx = { egressOnly: async (on: boolean) => told.push(on) > 0 && on } as unknown as HandlerContext;
  const scope = { signal: new AbortController().signal, output: () => {} };
  expect(await handleRequest(ctx, { op: "egress.only", on: true }, scope)).toEqual({ on: true });
  expect(await handleRequest(ctx, { op: "egress.only", on: false }, scope)).toEqual({ on: false });
  expect(told).toEqual([true, false]);
  await expect(handleRequest({} as HandlerContext, { op: "egress.only", on: true }, scope)).rejects.toMatchObject({
    code: "bad_request",
  });
});

test("the server turns the proxy on or off at once: egress.proxy", async () => {
  const told: boolean[] = [];
  const ctx = { egressProxy: async (on: boolean) => told.push(on) > 0 && on } as unknown as HandlerContext;
  const scope = { signal: new AbortController().signal, output: () => {} };
  expect(await handleRequest(ctx, { op: "egress.proxy", on: true }, scope)).toEqual({ on: true });
  expect(await handleRequest(ctx, { op: "egress.proxy", on: false }, scope)).toEqual({ on: false });
  expect(told).toEqual([true, false]);
  await expect(handleRequest({} as HandlerContext, { op: "egress.proxy", on: true }, scope)).rejects.toMatchObject({
    code: "bad_request",
  });
});

test("this server's own computer: each organization's agents reach only their own runner's proxy", () => {
  const rules = renderRuleset({
    agents: [20001],
    uidRange: [20000, 29999],
    services: [],
    ownServices: [{ uids: [20000, 20099], port: 41234 }],
    uplinks: [],
    loopbacks: ["lo"],
    reject: true,
  });
  const local = rules.slice(rules.indexOf("chain local"));
  const own = local.indexOf("ct mark 0x41004e20-0x41004e83 tcp dport 41234 accept");
  expect(own).toBeGreaterThan(0);
  expect(own).toBeLessThan(local.indexOf("@services accept"));
  expect(rules).not.toContain("tcp . 41234");
});
