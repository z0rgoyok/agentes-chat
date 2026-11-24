import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { caches, enableCaches } from "@agenteschat/engine";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  enableCaches(false);
  await t?.close();
  t = undefined;
});

test("a session read a moment ago isn't read again; signing out ends it everywhere at once", async () => {
  const server = await createTestServer();
  t = server;
  enableCaches();
  const ana = browser(server);
  await signUp(ana, "ana@example.com");
  expect((await ana("/api/app/me")).status).toBe(200);

  // Kept: with its row gone behind the server's back (nothing in the server does that), it still answers a moment.
  await server.db.delete(schema.sessions);
  expect((await ana("/api/app/me")).status).toBe(200);
  caches.sessions.clear();
  expect((await ana("/api/app/me")).status).toBe(401);

  // Signing out goes through Better Auth's hooks: the copy kept a moment ago is forgotten with it.
  const again = browser(server);
  const signIn = await again("/api/auth/sign-in/email", {
    json: { email: "ana@example.com", password: "correct horse battery" },
  });
  expect(signIn.status).toBe(200);
  expect((await again("/api/app/me")).status).toBe(200);
  const cookie = again.cookie();
  expect((await again("/api/auth/sign-out", { json: {} })).status).toBe(200);
  const stale = await server.app.request("/api/app/me", { headers: { cookie, origin: "http://localhost:3000" } });
  expect(stale.status).toBe(401);
});
