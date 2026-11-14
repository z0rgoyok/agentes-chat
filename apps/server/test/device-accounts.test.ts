import { afterEach, describe, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

/**
 * Several accounts signed in on one browser (ADR 0183): a second sign-in keeps the first, the browser lists them by
 * person, moves between them and signs one out without the others.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const PASSWORD = "correct horse battery";

interface Listed {
  accounts: {
    current: boolean;
    user: { id: string; email: string };
    organizations: { id: string }[];
    unread: { orgId: string }[];
  }[];
}

const list = async (b: ReturnType<typeof browser>) => {
  const res = await b("/api/app/device-accounts");
  expect(res.status).toBe(200);
  return (await res.json()) as Listed;
};

const emailOf = async (b: ReturnType<typeof browser>) => {
  const res = await b("/api/app/me");
  return res.status === 200 ? ((await res.json()) as { user: { email: string } }).user.email : null;
};

/** One browser signed in as the owner and then as someone invited: two accounts, the second its own. */
async function twoAccounts() {
  t = await createTestServer();
  const b = browser(t);
  await signUp(b, "ana@example.com");
  const created = await b("/api/app/organizations", { json: { name: "Padaria" } });
  const orgId = ((await created.json()) as { organization: { id: string } }).organization.id;
  await joinByInvitation(t, b, orgId, "bia@example.com");
  const signedIn = await b("/api/auth/sign-in/email", { json: { email: "bia@example.com", password: PASSWORD } });
  expect(signedIn.status).toBe(200);
  return { b, orgId };
}

describe("accounts signed in on one browser", () => {
  test("a second sign-in keeps the first; the list names both, its own first", async () => {
    const { b, orgId } = await twoAccounts();
    expect(await emailOf(b)).toBe("bia@example.com");
    const { accounts } = await list(b);
    expect(accounts.map((a) => [a.user.email, a.current])).toEqual([
      ["bia@example.com", true],
      ["ana@example.com", false],
    ]);
    expect(accounts.every((a) => a.organizations.some((o) => o.id === orgId))).toBe(true);
    expect(accounts.map((a) => Object.keys(a).sort())).toEqual([
      ["current", "organizations", "unread", "user"],
      ["current", "organizations", "unread", "user"],
    ]);
  });

  test("moving to another account and back; nobody signs out", async () => {
    const { b } = await twoAccounts();
    const ana = (await list(b)).accounts.find((a) => a.user.email === "ana@example.com");
    const moved = await b("/api/app/device-accounts/switch", { json: { userId: ana?.user.id } });
    expect(moved.status).toBe(204);
    expect(await emailOf(b)).toBe("ana@example.com");
    expect((await list(b)).accounts.map((a) => a.user.email)).toEqual(["ana@example.com", "bia@example.com"]);
    const stranger = await b("/api/app/device-accounts/switch", { json: { userId: "nobody" } });
    expect(stranger.status).toBe(404);
    expect(await emailOf(b)).toBe("ana@example.com");
  });

  test("signing out leaves the other account in, and the browser on it", async () => {
    const { b } = await twoAccounts();
    const out = await b("/api/app/device-accounts/sign-out", { json: {} });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ signedIn: true });
    expect(await emailOf(b)).toBe("ana@example.com");
    expect((await list(b)).accounts.map((a) => a.user.email)).toEqual(["ana@example.com"]);

    const last = await b("/api/app/device-accounts/sign-out", { json: {} });
    expect(await last.json()).toEqual({ signedIn: false });
    expect(await emailOf(b)).toBeNull();
    expect((await list(b)).accounts).toEqual([]);
  });

  test("signing another account out from the list keeps the browser where it is", async () => {
    const { b } = await twoAccounts();
    const ana = (await list(b)).accounts.find((a) => a.user.email === "ana@example.com");
    const out = await b("/api/app/device-accounts/sign-out", { json: { userId: ana?.user.id } });
    expect(await out.json()).toEqual({ signedIn: true });
    expect(await emailOf(b)).toBe("bia@example.com");
    expect((await list(b)).accounts.map((a) => a.user.email)).toEqual(["bia@example.com"]);
  });

  test("the session tokens never leave the server", async () => {
    const { b } = await twoAccounts();
    for (const path of ["/api/auth/multi-session/list-device-sessions"]) {
      expect((await b(path)).status).toBe(404);
    }
    const active = await b("/api/auth/multi-session/set-active", { json: { sessionToken: "x" } });
    expect(active.status).toBe(404);
  });
});
