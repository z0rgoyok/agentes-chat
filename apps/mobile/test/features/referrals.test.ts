import { expect, test } from "bun:test";
import { offersReferrals } from "../../src/features/me/logic";

test("Refer and earn shows only where the server has a referral service", () => {
  const server = { socialProviders: { google: false, github: false }, signupOpen: false, firstRun: false };
  expect(offersReferrals(undefined)).toBe(false);
  expect(offersReferrals(server)).toBe(false);
  expect(offersReferrals({ ...server, referralsUrl: null })).toBe(false);
  expect(offersReferrals({ ...server, referralsUrl: "https://refer.example.com" })).toBe(true);
});
