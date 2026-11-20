import { afterEach, expect, setSystemTime, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

/** ADR 0075: wrong passwords per address, from one network and from all. */

let t: TestServer | undefined;
afterEach(async () => {
  setSystemTime();
  await t?.close();
  t = undefined;
});

const RIGHT = "correct horse battery";
const WRONG = "not the password";
const ANA = "ana@example.com";
const NOBODY = "nobody@example.com";

async function start() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  await signUp(browser(t), ANA);
  return t;
}

const signIn = (s: TestServer, email: string, password: string, network: string) =>
  browser(s)("/api/auth/sign-in/email", { json: { email, password }, headers: { "x-forwarded-for": network } });

const status = async (s: TestServer, email: string, password: string, network: string) =>
  (await signIn(s, email, password, network)).status;

async function wrong(s: TestServer, email: string, network: string, times: number) {
  for (let i = 0; i < times; i++) expect(await status(s, email, WRONG, network)).toBe(401);
}

async function expectRefused(res: Response) {
  expect(res.status).toBe(429);
  const wait = Number(res.headers.get("retry-after"));
  expect(wait).toBeGreaterThan(14 * 60);
  expect(wait).toBeLessThanOrEqual(15 * 60);
  expect(await res.json()).toMatchObject({ code: "TOO_MANY_PASSWORD_TRIES", retryIn: wait });
}

test("right passwords count nothing: ten in a row and the next still signs in", async () => {
  const s = await start();
  for (let i = 0; i < 11; i++) expect(await status(s, ANA, RIGHT, "203.0.113.1")).toBe(200);
}, 30_000);

test("ten wrong from one network refuse that network for that address, the right password too; another network still signs in", async () => {
  const s = await start();
  for (const email of [ANA, NOBODY]) {
    await wrong(s, email, "203.0.113.1", 10);
    await expectRefused(await signIn(s, email, email === ANA ? RIGHT : WRONG, "203.0.113.1"));
  }
  // The address in another case is the same address.
  await expectRefused(await signIn(s, "Ana@Example.com", RIGHT, "203.0.113.1"));
  expect(await status(s, ANA, RIGHT, "198.51.100.7")).toBe(200);
  expect(await status(s, NOBODY, WRONG, "198.51.100.7")).toBe(401);
  // Another address from the same network keeps its own tries.
  await signUp(browser(s), "bo@example.com");
  expect(await status(s, "bo@example.com", RIGHT, "203.0.113.1")).toBe(200);
}, 30_000);

test("fifty wrong over six networks refuse every network for that address until the window opens again", async () => {
  const s = await start();
  const begin = Date.now();
  setSystemTime(begin);
  for (const email of [ANA, NOBODY]) {
    for (let n = 1; n <= 5; n++) await wrong(s, email, `203.0.113.${n}`, 9);
    await wrong(s, email, "203.0.113.6", 5);
    await expectRefused(await signIn(s, email, email === ANA ? RIGHT : WRONG, "198.51.100.7"));
    // A network with tries of its own left is refused too.
    await expectRefused(await signIn(s, email, email === ANA ? RIGHT : WRONG, "203.0.113.6"));
  }
  setSystemTime(begin + 15 * 60_000);
  expect(await status(s, ANA, RIGHT, "198.51.100.7")).toBe(200);
  expect(await status(s, NOBODY, WRONG, "198.51.100.7")).toBe(401);
}, 60_000);

test("a sign-in that succeeds gives back its own try only: the failures stay counted", async () => {
  const s = await start();
  await wrong(s, ANA, "203.0.113.1", 5);
  expect(await status(s, ANA, RIGHT, "203.0.113.1")).toBe(200);
  await wrong(s, ANA, "203.0.113.1", 5);
  await expectRefused(await signIn(s, ANA, RIGHT, "203.0.113.1"));
}, 30_000);

test("refused by both counts, the wait is the later window's", async () => {
  const s = await start();
  const begin = Date.now();
  setSystemTime(begin);
  await wrong(s, ANA, "198.51.100.7", 1);
  setSystemTime(begin + 5 * 60_000);
  await wrong(s, ANA, "203.0.113.1", 10);
  // The count from all networks opens again before this network's does, and fills again from others.
  setSystemTime(begin + 15 * 60_000);
  for (let n = 2; n <= 7; n++) await wrong(s, ANA, `203.0.113.${n}`, n === 7 ? 5 : 9);
  await expectRefused(await signIn(s, ANA, RIGHT, "203.0.113.1"));
}, 60_000);

test("a sign-in that fails on the server gives its tries back", async () => {
  const s = await start();
  const [account] = await s.db.select({ password: schema.accounts.password }).from(schema.accounts);
  await s.db.update(schema.accounts).set({ password: "not-a-hash" });
  for (let i = 0; i < 10; i++) expect(await status(s, ANA, RIGHT, "203.0.113.1")).toBe(500);
  await s.db.update(schema.accounts).set({ password: account?.password ?? null });
  expect(await status(s, ANA, RIGHT, "203.0.113.1")).toBe(200);
}, 30_000);

test("twenty wrong tries at once from one network: ten reach the password check, the rest are refused before it", async () => {
  const s = await start();
  for (const email of [ANA, NOBODY]) {
    const statuses = await Promise.all(Array.from({ length: 20 }, () => status(s, email, WRONG, "203.0.113.1")));
    expect(statuses.filter((code) => code === 401)).toHaveLength(10);
    expect(statuses.filter((code) => code === 429)).toHaveLength(10);
  }
}, 60_000);
