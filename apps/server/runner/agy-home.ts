import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isObject } from "@agenteschat/adapters/machine-protocol";
import { readSmallJson } from "./json-file";
import { CODEX_MCP_SERVER } from "./mcp";

/**
 * An Antigravity CLI account's home (ADR 0143). `agy` documents no folder of its own to move, so the account's folder
 * is its whole `HOME`: settings in `.gemini/antigravity-cli/settings.json`, MCP servers, agents, rules, skills, hooks
 * and plugins under `.gemini/config/`, and, with no D-Bus session to reach a keyring, its sign-in in its private
 * secrets file there too (antigravity.google/docs: install, cli/reference, mcp, subagents, changelog 1.2.x–1.4.x, read
 * 2026-11-04).
 */

const settingsFile = (home: string) => path.join(home, ".gemini", "antigravity-cli", "settings.json");
const configDir = (home: string) => path.join(home, ".gemini", "config");

/** The agent Lodi's turns run as (`--agent`): no built-in tool, our server's alone. */
export const AGY_CHAT_AGENT = "agenteschat-chat";

/** How the account signs in (`auth.type`): a personal Google account, or Gemini Enterprise. */
export type AgyAuth = "oauth-personal" | "oauth-business";

const isAgyAuth = (v: unknown): v is AgyAuth => v === "oauth-business" || v === "oauth-personal";

function readSettings(home: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(settingsFile(home), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The account's sign-in type as its settings say it; null when they say none. */
export function agyAuthOf(home: string): AgyAuth | null {
  const auth = readSettings(home).auth;
  const type = auth && typeof auth === "object" ? (auth as Record<string, unknown>).type : undefined;
  return isAgyAuth(type) ? type : null;
}

/** Written whole, then renamed, when it isn't that already (600). */
function writeIfChanged(file: string, text: string) {
  try {
    if (readFileSync(file, "utf8") === text) return;
  } catch {
    // not there yet
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * The account's `settings.json`, the same for every turn on it: its sign-in type (and the Google Cloud project the
 * CLI saved for an Enterprise seat) kept, everything else ours. Terminal commands in the sandbox, nothing outside the
 * turn's folder, our server's tools without asking, no AI credits spent past the plan's quota. Slash commands stay on
 * here: turns pass `--disable-slash-commands`, and `/usage` and `/logout` must reach the CLI, not the model.
 * `gcp`: the seat's project from the home whose sign-in this one copies.
 */
export function writeAgySettings(home: string, auth?: AgyAuth, gcp?: Record<string, unknown>) {
  const was = readSettings(home);
  const kept = auth ?? agyAuthOf(home) ?? "oauth-personal";
  const seat = gcp ?? (isObject(was.gcp) ? was.gcp : undefined);
  const settings = {
    auth: { type: kept },
    ...(kept === "oauth-business" && seat ? { gcp: seat } : {}),
    toolPermission: "proceed-in-sandbox",
    enableTerminalSandbox: true,
    allowNonWorkspaceAccess: false,
    useG1Credits: false,
    showTips: false,
    showFeedbackSurvey: false,
    notifications: false,
    artifactReviewPolicy: "always-proceed",
    permissions: { allow: [`mcp(${CODEX_MCP_SERVER}/*)`] },
  };
  writeIfChanged(settingsFile(home), `${JSON.stringify(settings, null, 2)}\n`);
  mkdirSync(agyRuntimeDir(home), { recursive: true, mode: 0o700 });
}

/**
 * Where the CLI keeps its Google sign-in when it reaches no keyring: plain JSON with the access and refresh tokens,
 * written whole (600) and refreshed in place, tied to neither the OS user nor the computer (Antigravity CLI 1.5.0,
 * read off its binary 2026-11-11). Google's refresh answers carry no new refresh token, so copies of it never sign
 * each other out.
 */
export const AGY_SIGN_IN_FILE = ".gemini/antigravity-cli/antigravity-oauth-token";
const MAX_SIGN_IN_CHARS = 64_000;

/** A Gemini sign-in as root hands it to a turn (`agy_auth`): the CLI's sign-in file, and its settings' part of it. */
export interface AgySignIn {
  auth: Record<string, unknown>;
  type: AgyAuth;
  /** An Enterprise seat's Google Cloud project, as the CLI saved it in its settings. */
  gcp?: Record<string, unknown>;
}

/** The sign-in `v` holds (a grant off root's frame); null when it holds none. */
export function agySignInFrom(v: unknown): AgySignIn | null {
  if (!isObject(v) || !isObject(v.auth) || !isAgyAuth(v.type) || (v.gcp !== undefined && !isObject(v.gcp))) return null;
  if (JSON.stringify(v.auth).length + JSON.stringify(v.gcp ?? {}).length > MAX_SIGN_IN_CHARS) return null;
  return { auth: v.auth, type: v.type, ...(v.type === "oauth-business" && v.gcp ? { gcp: v.gcp } : {}) };
}

/** The sign-in an account's home keeps; null when its CLI kept none in its file. Never through a link or a pipe. */
export function agySignInOf(home: string): AgySignIn | null {
  return agySignInFrom({
    auth: readSmallJson(path.join(home, AGY_SIGN_IN_FILE), MAX_SIGN_IN_CHARS),
    type: agyAuthOf(home) ?? "oauth-personal",
    gcp: readSettings(home).gcp,
  });
}

/** A copy of that sign-in in another home: its settings first, then its file. */
export function placeAgySignIn(home: string, signIn: AgySignIn) {
  writeAgySettings(home, signIn.type, signIn.gcp);
  writeIfChanged(path.join(home, AGY_SIGN_IN_FILE), JSON.stringify(signIn.auth));
}

/** Turns of this process on a copy, by home. */
const holding = new Map<string, number>();

/**
 * In an agent's worker: its copy of a sign-in root keeps, placed for a turn and gone once its last turn on it ends
 * (`release`), so the agent's user keeps no Google sign-in between turns. A worker killed mid-turn leaves its copy
 * until that agent's next worker starts (`dropAgySignIns`), even if the account is removed meanwhile.
 */
export function holdAgySignIn(home: string, signIn: AgySignIn): () => void {
  placeAgySignIn(home, signIn);
  holding.set(home, (holding.get(home) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holding.get(home) ?? 1) - 1;
    if (left > 0) return void holding.set(home, left);
    holding.delete(home);
    try {
      rmSync(path.join(home, AGY_SIGN_IN_FILE), { force: true });
    } catch {
      // the turn's own shell may have put anything there, and the turn it ends already ended
    }
  };
}

/**
 * A worker starting, before any turn of its own: the copies `holdAgySignIn` left in the agent's folders for Gemini
 * accounts (`dir`, one folder per account) when its last worker was killed mid-turn go. One worker per agent runs at a
 * time, so none of them is in use.
 */
export function dropAgySignIns(dir: string) {
  let ids: string[] = [];
  try {
    ids = readdirSync(dir);
  } catch {
    // no Gemini account here yet
  }
  for (const id of ids) {
    try {
      rmSync(path.join(dir, id, AGY_SIGN_IN_FILE), { force: true });
    } catch {
      // not an account's folder: its own shell may have put anything there
    }
  }
}

/**
 * macOS: the account's own keychain, `Library/Keychains/login.keychain-db` under its folder. The CLI keeps its sign-in
 * in the default keychain through `/usr/bin/security` (go-keyring), which looks for it under `$HOME`, so with the
 * folder as `HOME` every account signs in to a keychain of its own and never to the computer user's. It has no
 * password and never locks by itself; it is unlocked before every CLI run, since a restart locks it.
 */
export const AGY_KEYCHAIN = "Library/Keychains/login.keychain-db";

export function agyKeychain(
  home: string,
  run: (args: string[]) => void = (args) =>
    void execFileSync("/usr/bin/security", args, { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdio: "ignore" }),
) {
  const file = path.join(home, AGY_KEYCHAIN);
  try {
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      run(["create-keychain", "-p", "", file]);
      run(["set-keychain-settings", file]);
    } else run(["unlock-keychain", "-p", "", file]);
  } catch {
    // The CLI then falls back to its own secrets file in the folder, still the account's alone.
  }
}

/**
 * The account's own `XDG_RUNTIME_DIR`: with the computer user's, a D-Bus client finds its session bus at
 * `$XDG_RUNTIME_DIR/bus` even with no `DBUS_SESSION_BUS_ADDRESS`, and every account would share one keyring.
 */
export const agyRuntimeDir = (home: string) => path.join(home, ".run");

/**
 * What a turn could leave in the account's home that a later turn (another agent's, or Lodi's) would load as its
 * own, outside every tool and the chat guard: global rules, skills, agents, hooks, plugins and their lists, project
 * settings, the ADC switch, and the rules files `agy` reads beside `.gemini/config`. Removed before every turn; the
 * sandbox keeps a turn's commands out of the home anyway.
 */
export const AGY_PLANTED = [
  ".gemini/config/agents",
  ".gemini/config/skills",
  ".gemini/config/rules",
  ".gemini/config/plugins",
  ".gemini/config/projects",
  ".gemini/config/hooks.json",
  ".gemini/config/config.json",
  ".gemini/config/skills.json",
  ".gemini/config/rules.json",
  ".gemini/config/plugins.json",
  ".gemini/config/agents.json",
  ".gemini/config/GEMINI.md",
  ".gemini/config/AGENTS.md",
  ".gemini/GEMINI.md",
  ".gemini/AGENTS.md",
] as const;

/** `mcp_config.json` with our server alone: `agentes-runner mcp`, the run and its token from the env it inherits. */
export function agyMcpConfig(command: string[] | undefined): string {
  const [bin, ...args] = command ?? [];
  const server = { command: bin ?? "agentes-runner", args: [...args, "mcp"], timeoutSeconds: 360 };
  return `${JSON.stringify({ mcpServers: { [CODEX_MCP_SERVER]: server } }, null, 2)}\n`;
}

/** Lodi's agent: none of the CLI's tools, no commands, never a subagent; it answers through our server. */
export const agyChatAgent = (): string =>
  [
    "---",
    `name: ${AGY_CHAT_AGENT}`,
    "description: Answers the team in agentes.chat through the agentes tools only.",
    "tools: []",
    "mainAgent: true",
    "subagent: false",
    "commandExecutionPolicy: off",
    "---",
    "Use only the agentes tools. Never read or write files, run commands, browse or start other agents.",
    "",
  ].join("\n");

/**
 * Before a turn: what an earlier turn planted dropped, then our settings, our server alone and Lodi's agent written
 * (each only when it differs).
 */
export function prepareAgyHome(home: string, command: string[] | undefined) {
  for (const rel of AGY_PLANTED) rmSync(path.join(home, rel), { recursive: true, force: true });
  writeAgySettings(home);
  writeIfChanged(path.join(configDir(home), "mcp_config.json"), agyMcpConfig(command));
  writeIfChanged(path.join(configDir(home), "agents", AGY_CHAT_AGENT, "agent.md"), agyChatAgent());
}
