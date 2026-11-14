import { createTurnstileCheck, type HumanAction, type HumanCheck, type HumanCheckRefusal } from "@agenteschat/adapters";
import { type Config, ConfigError } from "@agenteschat/config";
import type { Logger } from "../logger";
import { requestIp, requestLimitIp } from "./client-ip";
import { HUMAN_PASS_PREFIX, type HumanPasses } from "./human-pass";

/** Where pages send the bot check's token: Better Auth's captcha plugin reads the same header. */
export const HUMAN_CHECK_HEADER = "x-captcha-response";

/**
 * agentes.chat Cloud's bot check (ADR 0075), only with both keys: without them nothing reaches Cloudflare. Tokens
 * count when made on `PUBLIC_URL`'s host, and for the waiting lists also on `LANDING_URL`'s.
 */
export function createHumanCheck(
  config: Pick<Config, "PUBLIC_URL" | "LANDING_URL" | "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY">,
  options: { log?: Logger; fetch?: typeof fetch } = {},
): HumanCheck | null {
  if (!config.TURNSTILE_SITE_KEY || !config.TURNSTILE_SECRET_KEY) return null;
  return createTurnstileCheck({
    siteKey: config.TURNSTILE_SITE_KEY,
    secretKey: config.TURNSTILE_SECRET_KEY,
    hostnames: [new URL(config.PUBLIC_URL).hostname],
    landingHostnames: config.LANDING_URL ? [new URL(config.LANDING_URL).hostname] : [],
    ...options,
  });
}

const REFUSALS: Record<HumanCheckRefusal, string> = {
  human_check: "Couldn't confirm a person is asking. Try again.",
  human_check_blocked: "The bot check didn't load. Try another browser or network.",
};

/**
 * A public form's bot check (ADR 0075): the refusal to answer with a 403, or null when it passes or there is none.
 * `pass`: where the form follows the e-mail's lookup, the address it is for; a pass that lookup gave stands for the
 * check then (`human-pass.ts`), and one that doesn't count is refused like a refused token, so the page sends its own.
 */
export async function humanCheckRefusal(
  check: HumanCheck | null | undefined,
  headers: { get(name: string): string | null | undefined },
  action: HumanAction,
  trustedProxies: readonly string[] | undefined,
  pass?: { passes: HumanPasses; email: string },
): Promise<{ code: HumanCheckRefusal; message: string } | null> {
  if (!check) return null;
  const sent = headers.get(HUMAN_CHECK_HEADER);
  if (sent?.startsWith(HUMAN_PASS_PREFIX)) {
    const network = requestLimitIp(headers, trustedProxies);
    if (pass?.passes.accepts(sent, { action, email: pass.email, network })) return null;
    return { code: "human_check", message: REFUSALS.human_check };
  }
  const code = await check.verify(sent, action, requestIp(headers, trustedProxies));
  return code ? { code, message: REFUSALS[code] } : null;
}

/**
 * At boot, like a half pair of keys, a secret Cloudflare refuses stops the server (a `ConfigError`): the check
 * would otherwise let everything through unseen. Unreachable, the server starts and lets requests through. One of
 * Cloudflare's test secrets starts it with a warning, since a test server runs one on purpose.
 */
export async function checkHumanCheckAtBoot(check: HumanCheck | null | undefined, log: Logger) {
  if (!check) return;
  const state = await check.probe();
  if (state === "secret_refused") {
    throw new ConfigError([
      "TURNSTILE_SECRET_KEY: Cloudflare refuses this secret key. Copy the widget's secret key from Cloudflare's dashboard, or unset both Turnstile keys.",
    ]);
  }
  if (state === "unreachable")
    log.error("bot check: Cloudflare can't be reached, requests go through until it answers");
  else if (check.status().testing)
    log.warn(
      "bot check: TURNSTILE_SECRET_KEY is one of Cloudflare's test secrets. They refuse real tokens, so people can't pass, and the one that passes takes a public dummy token from anyone. Anywhere but a test server, copy the widget's secret key from Cloudflare's dashboard.",
    );
  else log.info("bot check on (Cloudflare Turnstile)");
}
