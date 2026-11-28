import { randomBytes, timingSafeEqual } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { isEgressTarget, parseStreamControl, STREAM_CLOSE } from "@agenteschat/adapters";
import type { EgressRelay } from "./egress-share";
import { lentOfflineText, serverLending } from "./machines";

const READY = "HTTP/1.1 200 Connection Established\r\n\r\n";
const answer = (status: string) => `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
const failed = (code: number | undefined) =>
  answer(
    code === STREAM_CLOSE.notFound
      ? "504 Gateway Timeout"
      : code === STREAM_CLOSE.refused || code === STREAM_CLOSE.forbidden
        ? "403 Forbidden"
        : "502 Bad Gateway",
  );

/**
 * ADR 0237 on a self-hosted server: the server's own reads of web pages for an organization's agents (`web_fetch`,
 * the DuckDuckGo page) go out through a computer that lends that organization its internet. Bun's `fetch` reaches a
 * lent connection through a CONNECT proxy on 127.0.0.1, port chosen at start, that only this process holds the key to
 * (`Proxy-Authorization: Basic <orgId>:<token>`, a fresh token each start); each tunnel is a leg of the relay
 * (`EgressRelay.connect`).
 */
export function createEgressFetch(relay: Pick<EgressRelay, "connect" | "lending">) {
  const token = Buffer.from(randomBytes(24).toString("base64url"));
  let listening: Promise<number> | null = null;

  const orgOf = (head: string): string | null => {
    const basic = /\r\nproxy-authorization:[ \t]*basic[ \t]+(\S+)/i.exec(head)?.[1];
    if (!basic) return null;
    const [orgId = "", key = ""] = Buffer.from(basic, "base64").toString("utf8").split(":");
    const given = Buffer.from(key);
    return orgId && given.length === token.length && timingSafeEqual(given, token) ? orgId : null;
  };

  const serve = (client: Socket) => {
    let buf = Buffer.alloc(0);
    client.on("error", () => undefined);
    const timer = setTimeout(() => client.destroy(), 30_000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 8192) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const head = buf.toString("latin1", 0, end + 2);
      const m = /^CONNECT ([^\s:]+):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(head);
      const orgId = orgOf(head);
      if (!orgId) return void client.end(answer("407 Proxy Authentication Required"));
      const target = m ? { host: m[1] as string, port: Number(m[2]) } : null;
      if (!target || !isEgressTarget(target)) return void client.end(answer("403 Forbidden"));
      const early = buf.subarray(end + 4);
      let ready = false;
      const leg = relay.connect(orgId, target, {
        send(data) {
          if (typeof data !== "string") return void client.write(data);
          const control = ready ? parseStreamControl(data) : null;
          if (control?.type === "pause") return void client.pause();
          if (control?.type === "resume") return void client.resume();
          if (ready || !data.includes('"stream.ready"')) return;
          ready = true;
          clearTimeout(timer);
          client.write(READY);
          if (early.length > 0) leg.data(new Uint8Array(early));
          client.resume();
        },
        close(code) {
          clearTimeout(timer);
          if (ready) client.destroy();
          else client.end(failed(code));
        },
        buffered: () => client.writableLength,
      });
      client.on("data", (bytes: Buffer) => leg.data(new Uint8Array(bytes)));
      client.on("close", () => leg.closed());
    };
    client.on("data", onData);
  };

  const start = () => {
    listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer(serve);
      (server as unknown as EventEmitter).once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
      // The proxy never keeps a process up on its own.
      server.unref();
    }).catch((error: unknown) => {
      listening = null;
      throw error;
    });
    return listening;
  };

  return {
    /**
     * A `fetch` whose connections go out through the computer that lends `orgId` its internet, or null when none
     * does now (or this server lends none): the caller then goes its usual way. `only`: the workspace uses only that
     * computer's internet (amendment 2026-11-27 c), on the Cloud too, so the caller never goes its usual way; while
     * that computer is offline the `fetch` fails saying so.
     */
    async lentFetch(orgId: string): Promise<{ fetch: typeof fetch; only: boolean } | null> {
      const now = await relay.lending(orgId).catch(() => null);
      if (now?.only && !now.lent) {
        const name = now.only.name;
        return {
          fetch: (() => Promise.reject(new Error(lentOfflineText(name)))) as unknown as typeof fetch,
          only: true,
        };
      }
      if (!now?.lent || (!serverLending() && !now.only)) return null;
      const port = await start();
      const proxy = `http://${encodeURIComponent(orgId)}:${token.toString()}@127.0.0.1:${port}`;
      const lent = ((url: string | URL | Request, init?: RequestInit) =>
        fetch(url, { ...init, proxy })) as typeof fetch;
      return { fetch: lent, only: now.only !== null };
    },
  };
}

export type EgressFetch = ReturnType<typeof createEgressFetch>;
