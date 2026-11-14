import { createHmac, timingSafeEqual } from "node:crypto";
import type { HumanAction } from "@agenteschat/adapters";

/**
 * One bot check for one sign-in (ADR 0075's addendum on passes). The e-mail lookup that passed the check answers with
 * a pass; the step that follows it for that same address (the password, the new account, the reset link) sends the
 * pass where the widget's token goes, so the person meets Cloudflare once and not at every step.
 *
 * A pass is `pass.<expiry>.<signature>`: signed for one address and one network, good for ten minutes and a few
 * calls. It never stands for the lookup itself, so every sign-in starts with a real check.
 */

/** What a pass starts with, in the header the widget's token travels in. */
export const HUMAN_PASS_PREFIX = "pass.";
/** How long a pass counts: the time a person takes from their e-mail to their password. */
const PASS_MS = 10 * 60_000;
/** Calls one pass covers: the password and a few tries at it, or a reset after one. More need the check again. */
const PASS_USES = 5;
/** The steps a pass stands for the check at, the ones that come after the e-mail's lookup. */
const PASS_ACTIONS: ReadonlySet<HumanAction> = new Set(["sign-in", "sign-up", "password-reset"]);

export interface HumanPasses {
  /** A pass for whoever just passed the check looking this address up, from this network. */
  issue(email: string, network: string): string;
  /** Whether `pass` stands for the check here; a pass that does spends one of its calls. */
  accepts(pass: string, at: { action: HumanAction; email: string; network: string }): boolean;
}

/**
 * `secret`: a key of its own (`deriveSecret(AGENTES_SECRET, "human-pass")`). The calls a pass spent are counted in
 * memory, like the server's other counts per IP: a restart gives a pass its calls back, never more time.
 */
export function createHumanPasses(secret: string, now: () => number = Date.now): HumanPasses {
  const used = new Map<string, { count: number; until: number }>();
  const sign = (until: number, email: string, network: string) =>
    createHmac("sha256", secret).update(`${until}\n${email.trim().toLowerCase()}\n${network}`).digest("base64url");
  return {
    issue(email, network) {
      const until = now() + PASS_MS;
      return `${HUMAN_PASS_PREFIX}${until}.${sign(until, email, network)}`;
    },
    accepts(pass, { action, email, network }) {
      if (!PASS_ACTIONS.has(action) || !pass.startsWith(HUMAN_PASS_PREFIX)) return false;
      const [expiry, signature, ...rest] = pass.slice(HUMAN_PASS_PREFIX.length).split(".");
      const until = Number(expiry);
      if (!signature || rest.length > 0 || !Number.isSafeInteger(until) || until <= now()) return false;
      const given = Buffer.from(signature);
      const made = Buffer.from(sign(until, email, network));
      if (given.length !== made.length || !timingSafeEqual(given, made)) return false;
      for (const [key, entry] of used) if (entry.until <= now()) used.delete(key);
      const entry = used.get(signature) ?? { count: 0, until };
      if (entry.count >= PASS_USES) return false;
      used.set(signature, { count: entry.count + 1, until });
      return true;
    },
  };
}

const passesBySecret = new Map<string, HumanPasses>();

/** The server's passes: one set per secret, shared by the lookup's route and Better Auth's hook. */
export function humanPassesFor(secret: string): HumanPasses {
  let passes = passesBySecret.get(secret);
  if (!passes) {
    passes = createHumanPasses(secret);
    passesBySecret.set(secret, passes);
  }
  return passes;
}
