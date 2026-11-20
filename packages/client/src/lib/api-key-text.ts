/**
 * Keys and tokens pasted into a message: everyone in the chat reads it, agents included, so the composer asks
 * before sending one. Shapes only, checked on this device: AI providers' keys (`sk-ant-…`, `sk-proj-…`, the other
 * `sk-…` keys with 20+ characters after `sk-`, Google's `AIza…`) and a few other services' secrets whose prefixes
 * ordinary words never have (GitHub, Slack, Stripe live keys, AWS access key ids).
 */
const KEY_SHAPES =
  /(^|[^\w-])(sk-[\w-]{20,}|AIza[\w-]{35}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{22,}|xox[baprs]-[\w-]{10,}|[rs]k_live_[A-Za-z0-9]{24,}|AKIA[0-9A-Z]{16})(?![\w-])/g;

/**
 * A key is random: for `sk-`, one run of 16+ characters with a digit in it, which a hyphenated word (`sk-learn-…`)
 * lacks; past the other prefixes, a digit anywhere.
 */
const random = (token: string) =>
  token.startsWith("AIza") ||
  (token.startsWith("sk-") ? token.split("-").some((part) => part.length >= 16 && /\d/.test(part)) : /\d/.test(token));

/**
 * The Vault name offered for each shape, and whether an AI provider takes it. The AI names stay off the prefixes the
 * Vault reserves (`isReservedKeyName`: `ANTHROPIC_…`, `OPENAI_…`, `GEMINI_…` steer where an AI tool's requests go).
 */
const KINDS: [RegExp, string, boolean][] = [
  [/^sk-ant-/, "MY_ANTHROPIC_API_KEY", true],
  [/^sk-or-/, "OPENROUTER_API_KEY", true],
  [/^sk-(?:proj|svcacct|admin)-|^sk-[A-Za-z0-9]{48}$/, "MY_OPENAI_API_KEY", true],
  [/^sk-/, "", true],
  [/^AIza/, "MY_GEMINI_API_KEY", true],
  [/^gh|^github_pat_/, "GITHUB_TOKEN", false],
  [/^xox/, "SLACK_TOKEN", false],
  [/^sk_live_/, "STRIPE_SECRET_KEY", false],
  [/^rk_live_/, "STRIPE_RESTRICTED_KEY", false],
  [/^AKIA/, "AWS_ACCESS_KEY_ID", false],
];

export interface FoundKey {
  key: string;
  /** An AI provider's key shape: it can also become the workspace's AI key. */
  ai: boolean;
  /** The Vault name to offer, or "" when the shape says nothing about whose it is. */
  name: string;
}

/** The first key-shaped token in `text`, or null. */
export function looksLikeApiKey(text: string): FoundKey | null {
  for (const m of text.matchAll(KEY_SHAPES)) {
    const key = m[2];
    if (!key || !random(key)) continue;
    const kind = KINDS.find(([shape]) => shape.test(key));
    return { key, ai: kind?.[2] ?? false, name: kind?.[1] ?? "" };
  }
  return null;
}

/** `text` with its key-shaped tokens taken out ("Tirar do texto"). */
export function withoutApiKeys(text: string): string {
  return text
    .replace(KEY_SHAPES, (all, before: string, token: string) => (random(token) ? before : all))
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
