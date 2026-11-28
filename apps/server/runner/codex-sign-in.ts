/**
 * How a Codex is signed in, read from what the CLI says: a leaf module (no runner imports), so both the executors' look
 * (`executors.ts`) and the account folders (`accounts.ts`) read it the same way.
 *
 * `chatgpt`: a ChatGPT sign-in; `api_key`: an OpenAI API key in its `auth.json`; `provider`: a model provider of its own
 * configuration (`config.toml`) that needs no OpenAI sign-in at all, which only the app-server's `account/read` tells.
 */
export type CodexAuthMethod = "chatgpt" | "api_key" | "provider";

export interface CodexSignIn {
  loggedIn: boolean;
  authMethod?: CodexAuthMethod;
  /** A ChatGPT sign-in's plan (`plus`, `pro`, `team`…), as one short word. */
  plan?: string;
}

const word = (v: unknown) => (typeof v === "string" && /^[\w.-]{1,40}$/.test(v) ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `codex login status`, on either stream: "Logged in using ChatGPT", an API key ("Logged in using an API key - sk-…",
 * or "API key configured - sk-…" where `auth.json` holds a key written by an older `codex login --api-key`), else
 * "Not logged in" (exit 1). Only the words, never the key's hint, are read.
 */
export function codexLoginStatusOf(status: number | null, output: string): CodexSignIn {
  if (status !== 0 || /not logged in/i.test(output)) return { loggedIn: false };
  if (/logged in using chatgpt/i.test(output)) return { loggedIn: true, authMethod: "chatgpt" };
  if (/api key configured|logged in using an api key/i.test(output)) return { loggedIn: true, authMethod: "api_key" };
  return { loggedIn: /logged in/i.test(output) };
}

/**
 * The app-server's `account/read` result (`{ account, requiresOpenaiAuth }`). `account` null with `requiresOpenaiAuth`
 * false: its configured model provider needs no OpenAI sign-in, so it thinks as it is (a key of the person's own
 * endpoint). Null: not a result this reads.
 */
export function codexAccountOf(result: unknown): CodexSignIn | null {
  if (!isObj(result)) return null;
  const account = result.account;
  if (account === null || account === undefined) {
    return result.requiresOpenaiAuth === false ? { loggedIn: true, authMethod: "provider" } : { loggedIn: false };
  }
  if (!isObj(account)) return null;
  if (account.type === "chatgpt") {
    const plan = word(account.planType);
    return { loggedIn: true, authMethod: "chatgpt", ...(plan ? { plan } : {}) };
  }
  if (account.type === "apiKey") return { loggedIn: true, authMethod: "api_key" };
  // A kind of account this runner doesn't know yet: still an account Codex thinks with.
  return { loggedIn: true };
}
