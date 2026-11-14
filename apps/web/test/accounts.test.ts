import { expect, test } from "bun:test";
import { accountInLink, leaveFor, withoutAccount } from "@/lib/accounts";

// Several accounts signed in on one browser (ADR 0183).

test("an address may name the account it is for, and the name leaves the address", () => {
  expect(accountInLink("?open=n1&as=u_1-a")).toBe("u_1-a");
  expect(accountInLink("?open=n1")).toBeNull();
  expect(accountInLink("?as=")).toBeNull();
  expect(accountInLink(`?as=${"x".repeat(201)}`)).toBeNull();
  expect(withoutAccount("/org/o1/notifications", "?open=n1&as=u1", "#top")).toBe("/org/o1/notifications?open=n1#top");
  expect(withoutAccount("/", "?as=u1", "")).toBe("/");
});

test("after signing out with another account still in: the app's first page, or the sign-in a page was waiting for", () => {
  expect(leaveFor("/org/o1/c/c1", "")).toBe("/");
  expect(leaveFor("/", "")).toBe("/");
  expect(leaveFor("/login", "?redirect=%2Fx")).toBe("/");
  // An invitation, a consent, the first run: the person picks who goes on, and comes back to it.
  expect(leaveFor("/invite/tok", "?join=1")).toBe("/login?redirect=%2Finvite%2Ftok%3Fjoin%3D1&add=1");
});
