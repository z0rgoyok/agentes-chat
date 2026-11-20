import { afterEach, describe, expect, test } from "bun:test";
import { APP_SCHEME } from "../src/auth";
import { allowedOrigins } from "../src/routes/app/context";
import { browser, createTestServer, ORIGIN, signUp, type TestServer } from "./harness";

/**
 * `EXTRA_TRUSTED_ORIGINS` (issue #417): an instance opened at more than one address — `PUBLIC_URL` plus a LAN IP or a
 * tunnel hostname — is trusted at all of them, for sign-in and for saving. Unset, nothing changes.
 *
 * Better Auth skips its own origin check under `NODE_ENV=test`, so the list it is given is read from its options; the
 * app's own CSRF check (the `Origin` of every write, unchanged by that) is exercised with real requests below.
 */

const LAN = "http://192.168.0.10:3000";
const TUNNEL = "https://agentes.tail1234.ts.net";

/** Everything the sign-in and app-write checks trust besides the extras, as a test server builds it. */
const WITHOUT_EXTRAS = [ORIGIN, APP_SCHEME, "exp://", "exp://**"];

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Better Auth's trusted origins with no request: the server's own list (a registered host adds its own, ADR 0194). */
const baseTrusted = (s: TestServer) => (s.auth.options.trustedOrigins as () => Promise<string[]>)();

async function server(env: Record<string, string> = {}) {
  t = await createTestServer({ env });
  return t;
}

describe("EXTRA_TRUSTED_ORIGINS", () => {
  test("unset: the trusted origins are exactly the ones there were before", async () => {
    const s = await server();
    expect(s.config.EXTRA_TRUSTED_ORIGINS).toBeUndefined();
    expect(await baseTrusted(s)).toEqual(WITHOUT_EXTRAS);
    expect([...allowedOrigins(s.config)]).toEqual([ORIGIN]);
  });

  test("a list: each origin trusted, trimmed, with the trailing slash dropped", async () => {
    const s = await server({ EXTRA_TRUSTED_ORIGINS: ` ${LAN} , ${TUNNEL}/ , ,` });
    expect(s.config.EXTRA_TRUSTED_ORIGINS).toEqual([LAN, TUNNEL]);
    expect(await baseTrusted(s)).toEqual([ORIGIN, LAN, TUNNEL, ...WITHOUT_EXTRAS.slice(1)]);
    expect([...allowedOrigins(s.config)]).toEqual([ORIGIN, LAN, TUNNEL]);
  });

  test("unset: an address besides PUBLIC_URL saves nowhere", async () => {
    const s = await server();
    const owner = browser(s);
    await signUp(owner, "owner@example.com");
    const save = await owner("/api/app/organizations", { origin: LAN, json: { name: "From the LAN" } });
    expect(save.status).toBe(403);
    expect(((await save.json()) as { error: { code: string } }).error.code).toBe("bad_origin");
  });

  test("set: that same address saves, and the ones nobody listed stay refused", async () => {
    const s = await server({ EXTRA_TRUSTED_ORIGINS: LAN });
    const owner = browser(s);
    await signUp(owner, "owner@example.com");
    expect((await owner("/api/app/organizations", { origin: LAN, json: { name: "From the LAN" } })).status).toBe(201);
    expect((await owner("/api/app/organizations", { origin: TUNNEL, json: { name: "X" } })).status).toBe(403);
  });
});
