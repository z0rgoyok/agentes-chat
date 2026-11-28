import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import {
  authServerMetadata,
  type CustomDeps,
  connectCustomServer,
  outboundFetch,
  ownOAuthClient,
  probeMcpServer,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const SERVER = "https://mcp.example.com/ads";
const ISSUER = "https://www.example.com/ads";
const resolveHost = async () => ["93.184.216.34"];

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * An MCP server shaped like Meta's Ads one: its 401 names a path-aware protected-resource document and the scopes
 * the request needs; the authorization server's metadata is only at the RFC 8414 path-inserted address, and its
 * host redirects a request that carries no User-Agent to an "unsupported browser" page.
 */
function adsLike(url: string, method: string, headers: Record<string, string>): Answer {
  if (url === SERVER && method === "POST") {
    return {
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/ads", scope="ads_read ads_management"',
      },
    };
  }
  if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/ads") {
    return {
      status: 200,
      body: JSON.stringify({
        resource: SERVER,
        authorization_servers: [ISSUER],
        scopes_supported: ["ads_read", "ads_management", "catalog_management", "pages_show_list"],
        bearer_methods_supported: ["header"],
      }),
    };
  }
  if (url.startsWith("https://www.example.com/") && !headers["user-agent"]) {
    return { status: 302, headers: { location: "https://www.example.com/unsupportedbrowser" } };
  }
  if (url === "https://www.example.com/.well-known/oauth-authorization-server/ads") {
    return {
      status: 200,
      body: JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: "https://www.example.com/v27.0/dialog/oauth",
        token_endpoint: "https://graph.example.com/v27.0/oauth/access_token",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        registration_endpoint: "https://mcp.example.com/.well-known/register/ads",
      }),
    };
  }
  return { status: 404 };
}

/** `node:https`'s `request` over `answer`, so discovery runs through the pinned fetch as it does in production. */
function fakeHttps(answer: (url: string, method: string, headers: Record<string, string>) => Answer) {
  return ((
    options: { hostname: string; path: string; method: string; headers: Record<string, string> },
    onResponse: (res: unknown) => void,
  ) =>
    Object.assign(new EventEmitter(), {
      destroy() {},
      end() {
        const a = answer(`https://${options.hostname}${options.path}`, options.method, options.headers);
        const res = Object.assign(Readable.from(a.body ? [Buffer.from(a.body)] : []), {
          statusCode: a.status,
          headers: a.headers ?? {},
        });
        queueMicrotask(() => onResponse(res));
      },
    })) as unknown as typeof httpsRequest;
}

const pinnedDeps = () => ({ resolveHost, http: outboundFetch({ resolveHost, request: fakeHttps(adsLike) }) }) as never;

test("a server shaped like Meta's Ads: its path issuer's metadata is found through the pinned fetch", async () => {
  const deps = pinnedDeps();
  expect(await probeMcpServer(deps, SERVER)).toEqual({
    kind: "oauth",
    resource: SERVER,
    issuer: ISSUER,
    // The 401's `scope`, ahead of the longer `scopes_supported`.
    scopes: ["ads_read", "ads_management"],
  });
  expect(await authServerMetadata(deps, ISSUER)).toMatchObject({
    authorization_endpoint: "https://www.example.com/v27.0/dialog/oauth",
    token_endpoint: "https://graph.example.com/v27.0/oauth/access_token",
    registration_endpoint: "https://mcp.example.com/.well-known/register/ads",
  });
});

test("an issuer with a path: metadata looked for in the MCP spec's order, then at the origin's own", async () => {
  const tried: string[] = [];
  const http = (async (input: string | URL) => {
    tried.push(String(input));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  expect(await authServerMetadata({ resolveHost, http } as never, "https://login.example.com/tenant/")).toBeNull();
  expect(tried).toEqual([
    "https://login.example.com/.well-known/oauth-authorization-server/tenant",
    "https://login.example.com/.well-known/openid-configuration/tenant",
    "https://login.example.com/tenant/.well-known/openid-configuration",
    "https://login.example.com/.well-known/oauth-authorization-server",
    "https://login.example.com/.well-known/openid-configuration",
  ]);
  tried.length = 0;
  await authServerMetadata({ resolveHost, http } as never, "https://login.example.com");
  expect(tried).toEqual([
    "https://login.example.com/.well-known/oauth-authorization-server",
    "https://login.example.com/.well-known/openid-configuration",
  ]);
});

/** `adsLike`, with the authorization server's metadata unreadable (down, or answering something else). */
const unreadableIssuer = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("https://www.example.com/")) return new Response("unavailable", { status: 503 });
  const a = adsLike(url, init?.method ?? "GET", { "user-agent": "test" });
  return new Response(a.body ?? null, { status: a.status, headers: a.headers });
}) as unknown as typeof fetch;

const depsOf = (fx: Fixture, http: typeof fetch): CustomDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
  resolveHost,
  http,
});

test("connecting: OAuth details that can't be read say so, never that the server takes only a key", async () => {
  f = await setup();
  const deps = depsOf(f, unreadableIssuer);
  const refused = connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER });
  await expect(refused).rejects.toMatchObject({
    code: "connector.oauth_discovery",
    params: { host: "www.example.com" },
  });
});

test("an own OAuth app: unreadable OAuth details say so, not that the server doesn't sign in with OAuth", async () => {
  f = await setup();
  const deps = depsOf(f, unreadableIssuer);
  await expect(ownOAuthClient(deps, f.owner.id, f.org.id, SERVER)).rejects.toMatchObject({
    code: "connector.oauth_discovery",
  });
});

test("a 401 naming protected-resource metadata that can't be read: discovery failed, not a key-only server", async () => {
  const http = (async (input: string | URL, init?: RequestInit) => {
    const a = adsLike(String(input), init?.method ?? "GET", { "user-agent": "test" });
    return a.status === 401 ? new Response(null, a) : new Response("unavailable", { status: 503 });
  }) as unknown as typeof fetch;
  await expect(probeMcpServer({ resolveHost, http } as never, SERVER)).rejects.toMatchObject({
    code: "connector.oauth_discovery",
    params: { host: "mcp.example.com" },
  });
});

test("an anonymous 200 with protected-resource metadata: an optional sign-in; with typed headers it is open", async () => {
  const http = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === SERVER && init?.method === "POST") return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    const a = adsLike(url, init?.method ?? "GET", { "user-agent": "test" });
    return new Response(a.body ?? null, { status: a.status, headers: a.headers });
  }) as unknown as typeof fetch;
  const deps = { resolveHost, http } as never;
  expect(await probeMcpServer(deps, SERVER)).toEqual({
    kind: "oauth",
    resource: SERVER,
    issuer: ISSUER,
    scopes: ["ads_read", "ads_management", "catalog_management", "pages_show_list"],
    optional: true,
  });
  expect(await probeMcpServer(deps, SERVER, { "x-api-key": "fake-key-0000" })).toEqual({ kind: "open" });
});
