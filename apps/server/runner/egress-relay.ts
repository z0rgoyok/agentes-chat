import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { EventEmitter } from "node:events";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, isIP, isIPv6, type Server, type Socket, connect as tcpConnect } from "node:net";
import path from "node:path";
import {
  EGRESS_DIRECT_HOSTS,
  EGRESS_SHARE,
  isEgressHost,
  isEgressTarget,
  STREAM_CLOSE,
} from "@agenteschat/adapters/machine-protocol";
import { publicAddress } from "./egress";
import { pipeSocket } from "./egress-share";
import type { NetworkConfig } from "./network-state";
import type { DataSocket } from "./streams";

/**
 * ADR 0237, on the workspace's own computer: `<runner home>/egress-relay.sock`, a SOCKS5 socket (no authentication,
 * CONNECT only, mode 600: root's network guard alone opens it). Each connection asks the server for a computer a
 * person lent, and goes out through it.
 */
export const EGRESS_RELAY_SOCKET = "egress-relay.sock";
/**
 * Next to the socket, what the guard reads before it asks (ADR 0237, amendment 2026-11-27 c): `direct`, the names a
 * TLS connection keeps its usual way (`EGRESS_DIRECT_HOSTS`), and `only`: the workspace uses only the lending
 * computer's internet, so nothing is kept direct and a lent connection that fails is never sent the usual way.
 */
export const EGRESS_RELAY_POLICY = "egress-relay.json";

/** Writes `EGRESS_RELAY_POLICY` in `home` whole (the guard may read it at any moment). */
export function writeEgressPolicy(home: string, only: boolean) {
  const file = path.join(home, EGRESS_RELAY_POLICY);
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ only, direct: only ? [] : EGRESS_DIRECT_HOSTS })}\n`, {
    mode: 0o644,
  });
  renameSync(`${file}.tmp`, file);
}

/** SOCKS5 replies (RFC 1928 §6) the guard tells apart: carried, nothing lent now, not carried here, destination failed. */
export const SOCKS_REPLY = {
  ok: 0,
  notAllowed: 2,
  networkUnreachable: 3,
  hostUnreachable: 4,
  notSupported: 7,
} as const;

/**
 * The SOCKS reply for a data socket the server closed before `stream.ready`. `badRequest`: a server older than this
 * runner refused the destination's port in the hello, which says nothing about whether a computer lends now.
 */
export function replyFor(closeCode: number | undefined): number {
  if (notCarried(closeCode) || closeCode === STREAM_CLOSE.forbidden) return SOCKS_REPLY.notAllowed;
  if (closeCode === STREAM_CLOSE.notFound) return SOCKS_REPLY.hostUnreachable;
  return SOCKS_REPLY.networkUnreachable;
}

const notCarried = (closeCode: number | undefined) =>
  closeCode === STREAM_CLOSE.refused || closeCode === STREAM_CLOSE.badRequest;

const socksReply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

/** A CONNECT request's target, its length in `buf`, or null while more bytes are needed; `false`: not one we take. */
export function parseConnect(buf: Buffer): { host: string; port: number; length: number } | null | false {
  if (buf.length < 4) return null;
  if (buf[0] !== 5 || buf[1] !== 1 || buf[2] !== 0) return false;
  const atyp = buf[3];
  let host: string;
  let at: number;
  if (atyp === 1) {
    if (buf.length < 10) return null;
    host = [...buf.subarray(4, 8)].join(".");
    at = 8;
  } else if (atyp === 3) {
    if (buf.length < 5) return null;
    const n = buf[4] as number;
    if (buf.length < 5 + n + 2) return null;
    host = buf.subarray(5, 5 + n).toString("latin1");
    at = 5 + n;
  } else if (atyp === 4) {
    if (buf.length < 22) return null;
    const words: string[] = [];
    for (let i = 4; i < 20; i += 2) words.push(buf.readUInt16BE(i).toString(16));
    host = words.join(":");
    if (!isIPv6(host)) return false;
    at = 20;
  } else return false;
  return { host, port: buf.readUInt16BE(at), length: at + 2 };
}

type Target = { host: string; port: number };
/** Where a connection went: a lent one's data socket, or this computer's own TCP connection. */
type Opened = { data: DataSocket } | { tcp: Socket };
/** Opens `target`, or rejects with the server's `closeCode` (none: it failed here). */
type Open = (target: Target) => Promise<Opened>;

/**
 * Serves the socket at `path` until `close`: the workspace's own computer's, for its network guard. `dial` opens the
 * data socket that asks for `target` (`stream.hello` with `egress`); a rejection carrying the server's `closeCode`
 * becomes its SOCKS reply.
 */
export function startEgressRelay(o: {
  path: string;
  dial: (streamId: string, target: Target) => Promise<DataSocket>;
}): {
  close(): void;
} {
  rmSync(o.path, { force: true });
  const open: Open = async (target) => {
    if (!isEgressTarget(target)) throw { closeCode: STREAM_CLOSE.refused };
    return { data: await o.dial(randomBytes(32).toString("base64url"), target) };
  };
  const server = createServer((client) => serve(client, open));
  server.listen(o.path, () => {
    try {
      chmodSync(o.path, 0o600);
    } catch {
      server.close();
    }
  });
  // Bun types `Server` without its EventEmitter side: a failed listen must not throw out of the runner.
  (server as unknown as EventEmitter).on("error", () => undefined);
  return {
    close() {
      server.close();
      rmSync(o.path, { force: true });
    },
  };
}

/** The borrowing computer's loopback proxy keeps its port here, so processes started earlier keep reaching it. */
export const EGRESS_PROXY_FILE = "egress-proxy.json";
/** After nothing lent, or the server saying this computer doesn't borrow, connections go direct this long unasked. */
export const EGRESS_QUIET_MS = 60_000;

/** The port a runner home's loopback proxy last listened on, or null. */
export function storedEgressPort(home: string): number | null {
  try {
    const port = (JSON.parse(readFileSync(path.join(home, EGRESS_PROXY_FILE), "utf8")) as { port?: unknown }).port;
    return Number.isSafeInteger(port) && (port as number) > 0 && (port as number) < 65536 ? (port as number) : null;
  } catch {
    return null;
  }
}

/** This computer's own way to `target`: every address it resolves to must be public, or nothing is dialed. */
async function directDial(
  target: Target,
  resolve: (host: string) => Promise<string[]>,
  connect: (host: string, port: number) => Socket,
): Promise<Opened> {
  let addresses: string[];
  try {
    addresses = isIP(target.host) ? [target.host] : await resolve(target.host);
  } catch {
    throw { closeCode: STREAM_CLOSE.notFound };
  }
  const address = addresses[0];
  if (!address) throw { closeCode: STREAM_CLOSE.notFound };
  // Root's dial skips the agents' guard: never this computer, its networks or its containers.
  if (!addresses.every(publicAddress)) throw { closeCode: STREAM_CLOSE.refused };
  return new Promise((resolve, reject) => {
    const tcp = connect(address, target.port);
    const timer = setTimeout(() => {
      tcp.destroy();
      reject({ closeCode: STREAM_CLOSE.notFound });
    }, 10_000);
    tcp.once("connect", () => {
      clearTimeout(timer);
      resolve({ tcp });
    });
    tcp.once("error", () => {
      clearTimeout(timer);
      reject({ closeCode: STREAM_CLOSE.notFound });
    });
  });
}

/**
 * ADR 0237 on a self-hosted server: a computer that borrows a person's internet without the Cloud's guard. Its agents'
 * programs and browsers are told to use `127.0.0.1:<port>` (HTTP CONNECT or SOCKS5, no authentication). While `lent()`,
 * a connection to any `isEgressTarget` asks the server for a lending computer (`dial`); port 25, nothing lent now, a
 * refusal or the server away, goes out this computer's own way, to public addresses only. After nothing lent or a
 * "doesn't borrow", it stays direct for `EGRESS_QUIET_MS` without asking. Only `notFound` on a web port (the lending
 * computer found no such site) fails the connection. While `only()` (amendment 2026-11-27 c), nothing goes direct but
 * after the server's "nothing lent" (it says that only once no computer is lent "only"): every other failure, and
 * `notFound` on any port (the one lent "only" is offline), fails the connection.
 *
 * ponytail: any local process may use the port (a single-user computer has no guard): it only reaches public
 * addresses, through this workspace's own lending computer. Per-process auth if that ever matters.
 */
export async function startEgressProxy(o: {
  home: string;
  dial: (streamId: string, target: Target) => Promise<DataSocket>;
  lent: () => boolean;
  only?: () => boolean;
  now?: () => number;
  resolve?: (host: string) => Promise<string[]>;
  /** Tests: where a direct connection goes. */
  connect?: (host: string, port: number) => Socket;
}): Promise<{ port: number; close(): void }> {
  const now = o.now ?? Date.now;
  const resolve = o.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  let quietUntil = 0;
  const open: Open = async (target) => {
    const lent = o.lent();
    const only = lent && (o.only?.() ?? false);
    if (only && !isEgressTarget(target)) throw { closeCode: STREAM_CLOSE.refused };
    if (lent && isEgressTarget(target) && (only || now() >= quietUntil)) {
      try {
        return { data: await o.dial(randomBytes(32).toString("base64url"), target) };
      } catch (error) {
        const code = (error as { closeCode?: number } | null)?.closeCode;
        if (code === STREAM_CLOSE.notFound) {
          // Another port the lending computer couldn't reach (its network may block SSH or a database's port) went
          // this computer's own way before every port was lent, and still does, but where it is lent "only".
          if (only || EGRESS_SHARE.webPorts.includes(target.port)) throw error;
        } else if (only && code !== STREAM_CLOSE.unreachable) throw error;
        else if (!only && !notCarried(code)) quietUntil = now() + EGRESS_QUIET_MS;
      }
    }
    return directDial(target, resolve, o.connect ?? ((host, port) => tcpConnect({ host, port })));
  };
  const listen = (port: number) =>
    new Promise<Server>((done, fail) => {
      const server = createServer((client) => serve(client, open));
      (server as unknown as EventEmitter).once("error", fail);
      server.listen(port, "127.0.0.1", () => {
        (server as unknown as EventEmitter).on("error", () => undefined);
        done(server);
      });
    });
  const stored = storedEgressPort(o.home);
  const server = await (stored ? listen(stored).catch(() => listen(0)) : listen(0));
  const port = (server.address() as { port: number }).port;
  if (port !== stored) writeFileSync(path.join(o.home, EGRESS_PROXY_FILE), `${JSON.stringify({ port })}\n`);
  return { port, close: () => server.close() };
}

/**
 * What a borrowing computer's agents are handed now (`setEgressProxy`); null: they go their usual way. `only`: the
 * AI CLIs' services go through the proxy too.
 */
type LentProxy = { port: number; direct: string[]; only?: boolean };
let lentProxy: LentProxy | null = null;

/** The daemon (or, in system mode, each agent's worker from `worker.state`) says whether agents use the proxy. */
export function setEgressProxy(next: LentProxy | null) {
  lentProxy = next;
}

/** What `setEgressProxy` holds: the workers' state carries it. */
export const egressProxyState = () => lentProxy;

/**
 * The runner itself goes out through a proxy its operator set, or its agents through a network of their own (a
 * `networkLauncher` namespace, whose 127.0.0.1 never reaches this proxy, or a `networkMark` route root's dial would
 * skip): theirs wins, and agents get nothing from us.
 */
export const hasOwnProxy = (env: NodeJS.ProcessEnv = process.env, network?: NetworkConfig | null) =>
  Boolean(network?.networkLauncher || network?.networkMark) ||
  ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((k) => env[k]);

/**
 * Never through the proxy: this computer, the private and local ranges, the AI CLIs' services (but where the
 * workspace uses only the lending computer's internet), and `direct`.
 */
const noProxyList = (direct: readonly string[], only = false) => [
  "localhost",
  "127.0.0.0/8",
  "::1",
  ".local",
  ".internal",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "fc00::/7",
  "fe80::/10",
  ...(only ? [] : EGRESS_DIRECT_HOSTS),
  ...direct,
];

/**
 * The proxy settings an agent's processes get while this computer borrows (`{}` otherwise): HTTPS and SOCKS (names
 * resolved by the lending computer), Node's own fetch included, and `NO_PROXY`. `extraDirect`: more hosts that keep
 * their own way (a Claude Code turn's endpoint), but where the workspace uses only the lending computer's internet.
 *
 * ponytail: no `HTTP_PROXY`, so plain http goes direct (curl still takes `ALL_PROXY`); the proxy forwards CONNECT
 * only. Add an absolute-URI forwarder if plain-http sites ever need the lender.
 */
export function egressProxyEnv(extraDirect: readonly string[] = []): Record<string, string> {
  if (!lentProxy) return {};
  const at = `127.0.0.1:${lentProxy.port}`;
  const { only = false } = lentProxy;
  const none = noProxyList([...lentProxy.direct, ...(only ? [] : extraDirect)], only).join(",");
  return {
    HTTPS_PROXY: `http://${at}`,
    https_proxy: `http://${at}`,
    ALL_PROXY: `socks5h://${at}`,
    all_proxy: `socks5h://${at}`,
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: none,
    no_proxy: none,
  };
}

/**
 * Chrome's flags while this computer borrows: its proxy (names resolved by the lending computer), the same hosts kept
 * direct, and WebRTC kept off UDP outside the proxy so a page never learns this computer's own address.
 */
export function egressProxyChromeArgs(): string[] {
  if (!lentProxy) return [];
  const bypass = noProxyList(lentProxy.direct, lentProxy.only).map((h) =>
    h.startsWith(".") ? `*${h}` : h === "::1" ? "[::1]" : h,
  );
  return [
    `--proxy-server=socks5://127.0.0.1:${lentProxy.port}`,
    `--proxy-bypass-list=${["<local>", ...bypass].join(";")}`,
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

const HTTP_REPLY: Record<number, string> = {
  [SOCKS_REPLY.ok]: "200 Connection Established",
  [SOCKS_REPLY.notAllowed]: "403 Forbidden",
  [SOCKS_REPLY.networkUnreachable]: "502 Bad Gateway",
  [SOCKS_REPLY.hostUnreachable]: "504 Gateway Timeout",
  [SOCKS_REPLY.notSupported]: "405 Method Not Allowed",
};
const httpReply = (code: number) => Buffer.from(`HTTP/1.1 ${HTTP_REPLY[code] ?? "502 Bad Gateway"}\r\n\r\n`);

/** An HTTP `CONNECT host:port` request's target and its length, null while more is needed, `false`: not one. */
export function parseHttpConnect(buf: Buffer): { host: string; port: number; length: number } | null | false {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) return buf.length > 8192 ? false : null;
  const m = /^CONNECT (\[[0-9A-Fa-f:.]+\]|[^\s:]+):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(
    buf.toString("latin1", 0, end + 2),
  );
  if (!m) return false;
  const host = (m[1] as string).replace(/^\[|\]$/g, "");
  const port = Number(m[2]);
  if (!isEgressHost(host) || port < 1 || port > 65535) return false;
  return { host, port, length: end + 4 };
}

function serve(client: Socket, open: Open) {
  let buf = Buffer.alloc(0);
  let stage: "first" | "greeting" | "request" | "http" | "dialing" = "first";
  client.on("error", () => undefined);
  const timer = setTimeout(() => client.destroy(), 30_000);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === "first") stage = buf[0] === 5 ? "greeting" : "http";
    if (buf.length > (stage === "http" ? 8192 + 4 : 600)) return client.destroy();
    let target: { host: string; port: number; length: number } | null | false;
    let reply: (code: number) => Buffer;
    if (stage === "http") {
      target = parseHttpConnect(buf);
      reply = httpReply;
    } else {
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const n = buf[1] as number;
        if (buf.length < 2 + n) return;
        if (!buf.subarray(2, 2 + n).includes(0)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, 0]));
        buf = buf.subarray(2 + n);
        stage = "request";
      }
      target = parseConnect(buf);
      reply = socksReply;
    }
    if (target === null) return;
    if (target === false) {
      client.end(reply(SOCKS_REPLY.notSupported));
      return;
    }
    stage = "dialing";
    client.pause();
    client.off("data", onData);
    const early = buf.subarray(target.length);
    void open({ host: target.host, port: target.port }).then(
      (opened) => {
        clearTimeout(timer);
        if ("tcp" in opened) {
          if (client.destroyed) return opened.tcp.destroy();
          client.write(reply(SOCKS_REPLY.ok));
          if (early.length > 0) opened.tcp.write(early);
          opened.tcp.on("error", () => client.destroy());
          client.on("close", () => opened.tcp.destroy());
          opened.tcp.pipe(client);
          client.pipe(opened.tcp);
          client.resume();
          return;
        }
        const data = opened.data;
        if (client.destroyed) return data.close(STREAM_CLOSE.normal, "");
        client.write(reply(SOCKS_REPLY.ok));
        if (early.length > 0) data.send(new Uint8Array(early));
        pipeSocket(client, data);
      },
      (error: { closeCode?: number }) => {
        clearTimeout(timer);
        client.end(reply(replyFor(error?.closeCode)));
      },
    );
  };
  client.on("data", onData);
}
