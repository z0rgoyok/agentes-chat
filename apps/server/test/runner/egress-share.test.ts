import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EGRESS_SHARE,
  isEgressTarget,
  parseStreamHello,
  STREAM_CLOSE,
  type StreamControl,
} from "@agenteschat/adapters/machine-protocol";
import { parseConnect, replyFor, SOCKS_REPLY, startEgressRelay } from "../../runner/egress-relay";
import { EgressShare, pipeSocket } from "../../runner/egress-share";
import type { DataListener, DataSocket } from "../../runner/streams";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A data socket in memory: what was sent on it, and a way to play the server's side. */
function fakeData() {
  const sent: Uint8Array[] = [];
  const texts: string[] = [];
  let listener: DataListener | null = null;
  let closed = false;
  const socket: DataSocket = {
    send: (data) => {
      if (typeof data !== "string") sent.push(data);
      else texts.push(data);
    },
    close: () => {
      if (closed) return;
      closed = true;
      listener?.closed();
    },
    bufferedAmount: 0,
    listen: (on) => {
      listener = on;
    },
  };
  return {
    socket,
    sent,
    texts,
    peer: (bytes: Uint8Array) => listener?.bytes(bytes),
    control: (frame: StreamControl) => listener?.control?.(frame),
    isClosed: () => closed,
  };
}

/** A TCP server on this computer that echoes what it hears, uppercased. */
async function echo(): Promise<{ port: number; server: Server }> {
  const server = createServer((s) => s.on("data", (d: Buffer) => s.write(d.toString().toUpperCase())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  return { port: (server.address() as { port: number }).port, server };
}

const until = async (done: () => boolean, what = "condition") => {
  for (let i = 0; i < 400; i++) {
    if (done()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const STREAM = "s".repeat(43);

test("what a lent connection carries: any TCP port but mail's 25, a plain host; a hello may ask for one", () => {
  for (const port of [443, 80, 22, 5432, 587, 465, 65535])
    expect(isEgressTarget({ host: "gov.example", port })).toBe(true);
  expect(isEgressTarget({ host: "203.0.113.4", port: 80 })).toBe(true);
  for (const bad of [
    { host: "gov.example", port: 25 },
    { host: "gov.example", port: 0 },
    { host: "gov.example", port: 65536 },
    { host: "gov.example", port: 22.5 },
    { host: "a b", port: 443 },
    { host: "", port: 443 },
    { host: "x".repeat(254), port: 443 },
  ])
    expect(isEgressTarget(bad)).toBe(false);
  const hello = { type: "stream.hello", token: "agm_x", streamId: STREAM };
  expect(parseStreamHello(JSON.stringify({ ...hello, egress: { host: "gov.example", port: 443 } }))).toEqual({
    ...hello,
    type: "stream.hello",
    egress: { host: "gov.example", port: 443 },
  });
  expect(parseStreamHello(JSON.stringify({ ...hello, egress: { host: "gov.example", port: 25 } }))).toBeNull();
});

test("a lent connection reaches only public addresses, never port 25, and carries the bytes both ways", async () => {
  const { port } = await echo();
  const share = new EgressShare({
    resolve: async (host) => (host === "lan.example" ? ["192.168.1.1"] : ["203.0.113.7"]),
    // The site is this test's server: the address it was resolved to is the one checked.
    connect: (address) => {
      expect(address).toBe("203.0.113.7");
      return connect({ host: "127.0.0.1", port });
    },
  });
  const dial = (host: string, p = 443) =>
    share.dial({ op: "egress.dial", streamId: STREAM, host, port: p }, async () => data.socket);
  const data = fakeData();

  await expect(dial("lan.example")).rejects.toMatchObject({ code: "not_allowed" });
  await expect(dial("127.0.0.1")).rejects.toMatchObject({ code: "not_allowed" });
  await expect(dial("gov.example", 25)).rejects.toMatchObject({ code: "bad_request" });

  for (const p of [443, 22]) {
    const sent = data.sent.length;
    expect(await dial("gov.example", p)).toEqual({ connected: true });
    data.peer(new TextEncoder().encode("hello"));
    await until(() => data.sent.length > sent, "the echo");
    expect(new TextDecoder().decode(data.sent[sent])).toBe("HELLO");
  }
  data.socket.close();
});

test("a lent connection's flow: the server's pause stops reading the site; a site slow to read makes it say pause", async () => {
  // A site that sends as fast as it is read, and reads nothing until resumed.
  let site: Socket | null = null;
  const server = createServer((s) => {
    site = s;
    s.on("error", () => undefined);
    s.pause();
    const chunk = Buffer.alloc(64 * 1024);
    const fill = () => {
      while (s.writable && s.write(chunk));
    };
    s.on("drain", fill);
    fill();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  const data = fakeData();
  const tcp = connect({ host: "127.0.0.1", port: (server.address() as { port: number }).port });
  const end = pipeSocket(tcp, data.socket);
  cleanup.push(end);
  // Counted and let go: loopback carries gigabytes a second.
  let total = 0;
  const heard = () => {
    for (const b of data.sent.splice(0)) total += b.byteLength;
    return total;
  };
  await until(() => heard() > 1024 * 1024, "the site's bytes");

  data.control({ type: "pause" });
  await Bun.sleep(50);
  const before = heard();
  await Bun.sleep(200);
  expect(heard()).toBe(before);
  data.control({ type: "resume" });
  await until(() => heard() > before + 1024 * 1024, "more of the site's bytes");

  // What goes to the site waits on this computer while the site doesn't read: past 1 MiB it says so, once.
  for (let i = 0; i < 512 && !data.texts.length; i++) data.peer(new Uint8Array(64 * 1024));
  expect(data.texts).toEqual([JSON.stringify({ type: "pause" })]);
  (site as Socket | null)?.resume();
  await until(() => data.texts.length === 2, "resume");
  expect(data.texts[1]).toBe(JSON.stringify({ type: "resume" }));
});

test("a lent connection never reaches this computer's own networks, though their addresses are global", async () => {
  const { port } = await echo();
  const share = new EgressShare({
    resolve: async (host) => ({ "router.example": ["2001:db8:1::1"], "office.example": ["198.51.100.1"] })[host] ?? [],
    connect: () => connect({ host: "127.0.0.1", port }),
    interfaces: () => ({
      en0: [
        {
          address: "2001:db8:1::5",
          cidr: "2001:db8:1::5/64",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "",
          internal: false,
          scopeid: 0,
        },
        {
          address: "198.51.100.20",
          cidr: "198.51.100.20/24",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "",
          internal: false,
        },
      ],
    }),
  });
  const data = fakeData();
  const dial = (host: string) =>
    share.dial({ op: "egress.dial", streamId: STREAM, host, port: 443 }, async () => data.socket);
  await expect(dial("router.example")).rejects.toMatchObject({ code: "not_allowed" });
  await expect(dial("office.example")).rejects.toMatchObject({ code: "not_allowed" });
  await expect(dial("2001:db8:1::5")).rejects.toMatchObject({ code: "not_allowed" });
  await expect(dial("::ffff:198.51.100.1")).rejects.toMatchObject({ code: "not_allowed" });
  expect(await dial("2001:db8:2::1")).toEqual({ connected: true });
  data.socket.close();
});

test("a lending computer has no daily cap: what bounds it is port 25 and connections open at once", async () => {
  expect(Object.keys(EGRESS_SHARE).sort()).toEqual(["connectMs", "open", "refusedPorts", "webPorts"]);
  const { port } = await echo();
  const share = new EgressShare({
    resolve: async () => ["203.0.113.7"],
    connect: () => connect({ host: "127.0.0.1", port }),
    limits: { open: 1 },
  });
  const first = fakeData();
  await share.dial({ op: "egress.dial", streamId: STREAM, host: "gov.example", port: 443 }, async () => first.socket);
  first.peer(new Uint8Array(256 * 1024).fill(97));
  await until(() => first.sent.reduce((n, b) => n + b.byteLength, 0) >= 256 * 1024, "the echo");
  expect(first.isClosed()).toBe(false);
  await expect(
    share.dial({ op: "egress.dial", streamId: STREAM, host: "gov.example", port: 443 }, async () => fakeData().socket),
  ).rejects.toMatchObject({ code: "no_slot" });
  first.socket.close();
  const second = fakeData();
  expect(
    await share.dial(
      { op: "egress.dial", streamId: STREAM, host: "gov.example", port: 443 },
      async () => second.socket,
    ),
  ).toEqual({ connected: true });
  second.socket.close();
});

test("the workspace's computer's socket: SOCKS5 CONNECT, mode 600, the server's refusal as its reply", async () => {
  expect(parseConnect(Buffer.from([5, 1, 0, 3, 11, ...Buffer.from("gov.example"), 1, 187]))).toEqual({
    host: "gov.example",
    port: 443,
    length: 18,
  });
  expect(parseConnect(Buffer.from([5, 1, 0, 1, 203, 0, 113, 9, 0, 80]))).toEqual({
    host: "203.0.113.9",
    port: 80,
    length: 10,
  });
  expect(parseConnect(Buffer.from([5, 2, 0, 1]))).toBe(false);
  expect(replyFor(STREAM_CLOSE.unreachable)).toBe(SOCKS_REPLY.networkUnreachable);
  expect(replyFor(STREAM_CLOSE.refused)).toBe(SOCKS_REPLY.notAllowed);
  // A server older than this runner refusing SSH's port in the hello is "not carried", never "none lends now".
  expect(replyFor(STREAM_CLOSE.badRequest)).toBe(SOCKS_REPLY.notAllowed);
  expect(replyFor(STREAM_CLOSE.notFound)).toBe(SOCKS_REPLY.hostUnreachable);

  const dir = mkdtempSync(path.join(tmpdir(), "egress-relay-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const sock = path.join(dir, "egress-relay.sock");
  const data = fakeData();
  const asked: { host: string; port: number }[] = [];
  const relay = startEgressRelay({
    path: sock,
    dial: async (_id, target) => {
      asked.push(target);
      if (target.host === "nobody.example")
        throw Object.assign(new Error("none"), { closeCode: STREAM_CLOSE.unreachable });
      return data.socket;
    },
  });
  cleanup.push(() => relay.close());
  await until(() => {
    try {
      return (statSync(sock).mode & 0o777) === 0o600;
    } catch {
      return false;
    }
  }, "the socket");

  const ask = async (host: string, payload?: string) => {
    const client: Socket = connect(sock);
    const heard: Buffer[] = [];
    client.on("data", (d: Buffer) => heard.push(d));
    client.write(Buffer.from([5, 1, 0]));
    client.write(Buffer.from([5, 1, 0, 3, host.length, ...Buffer.from(host), 1, 187]));
    await until(() => Buffer.concat(heard).length >= 12, "the replies");
    if (payload) client.write(payload);
    return { client, heard };
  };
  const ok = await ask("gov.example", "GET /");
  expect([...Buffer.concat(ok.heard).subarray(0, 4)]).toEqual([5, 0, 5, SOCKS_REPLY.ok]);
  await until(() => data.sent.length > 0, "the request bytes");
  expect(new TextDecoder().decode(data.sent[0])).toBe("GET /");
  data.peer(new TextEncoder().encode("200 OK"));
  await until(() => Buffer.concat(ok.heard).toString().endsWith("200 OK"), "the answer");
  ok.client.destroy();

  const none = await ask("nobody.example");
  expect(Buffer.concat(none.heard)[3]).toBe(SOCKS_REPLY.networkUnreachable);
  none.client.destroy();
  expect(asked).toEqual([
    { host: "gov.example", port: 443 },
    { host: "nobody.example", port: 443 },
  ]);
});
