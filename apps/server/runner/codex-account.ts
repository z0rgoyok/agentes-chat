import { homedir } from "node:os";
import { CodexAppClient, codexAtLeast } from "./brain-codex-app";
import { type CodexSignIn, codexAccountOf } from "./codex-sign-in";
import { codexLaunch } from "./codex-windows";
import { envValue } from "./executors";
import type { Spawn } from "./scope-gate";

/** How long the app-server may take to start and answer `account/read`. */
export const CODEX_ACCOUNT_READ_MS = 15_000;

/**
 * How a Codex is signed in, asked of its own app-server (`initialize`, then `account/read` without refreshing its
 * token): a ChatGPT sign-in with its plan, an API key, or a model provider of its own configuration that needs no
 * OpenAI sign-in, which `codex login status` can't tell from being signed out. Null when it couldn't say (a Codex
 * older than `CODEX_APP_MIN_VERSION`, no app-server, a timeout): the caller reads `codex login status` instead.
 * `env`: whose Codex home (`CODEX_HOME`) it reads; the computer's own by default.
 */
export async function readCodexAccount(opts: {
  bin: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  spawn?: Spawn;
}): Promise<CodexSignIn | null> {
  if (!codexAtLeast(opts.version)) return null;
  const env = { ...process.env, ...opts.env };
  const platform = opts.platform ?? process.platform;
  const launch = codexLaunch(["app-server"], {
    bin: opts.bin,
    platform,
    pathList: envValue(env, "PATH", platform) ?? "",
  });
  if ("error" in launch) return null;
  let client: CodexAppClient;
  try {
    client = new CodexAppClient(launch.file, launch.args, {
      cwd: homedir(),
      env: launch.env ? { ...env, ...launch.env } : env,
      ...(opts.spawn ? { spawn: opts.spawn } : {}),
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    return null;
  }
  const ms = opts.timeoutMs ?? CODEX_ACCOUNT_READ_MS;
  try {
    await client.request(
      "initialize",
      {
        clientInfo: { name: "agentes_runner", title: "agentes.chat runner", version: "1" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
      ms,
    );
    client.notify("initialized");
    return codexAccountOf(await client.request("account/read", { refreshToken: false }, ms));
  } catch {
    return null;
  } finally {
    client.close();
  }
}
