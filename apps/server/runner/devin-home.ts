import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isObject } from "@agenteschat/adapters/machine-protocol";

/**
 * A Devin CLI account's home (ADR 0253). The account's folder is the CLI's whole `HOME`, with every XDG folder under
 * it (`accountEnv`): its sign-in in `.local/share/devin/credentials.toml`, its sessions beside it, its settings in
 * `.config/devin/config.json` (CLI 3000.14.30821, read off its own warnings and `devin doctor`, 2026-11-22).
 *
 * Before every turn, sign-in and look the runner writes the settings and removes what a turn could plant for a later
 * one: the CLI reads its own MCP servers, rules, skills, hooks and plugins from its config folder, and imports other
 * tools' (Claude Code's, Cursor's, Codex's, Windsurf's) from the home, which the agent's commands can write.
 */

/** The CLI's settings file. */
export const devinConfigFile = (home: string) => path.join(home, ".config", "devin", "config.json");

/** Where the CLI keeps the account's sign-in (a long-lived token, which it writes 644). */
export const devinCredentialsFile = (home: string) => path.join(home, ".local", "share", "devin", "credentials.toml");

/**
 * What the CLI imports from other tools, and from the account's Devin Cloud (its personal plugins and MCP servers, which
 * bring hooks): all off (`read_config_from`, keys from the CLI 3000.15.14 docs' `config-file.mdx`). Hooks and MCP servers
 * from a `.claude/` folder, `.mcp.json` or `.cursor/mcp.json` in the turn's folder would otherwise run outside the
 * runner's permission answers, in a `plan` turn too.
 */
export const DEVIN_NO_IMPORTS = {
  agents_standard: false,
  cursor: false,
  windsurf: false,
  claude: false,
  copilot: false,
  codex: false,
  kiro: false,
  opencode: false,
  zed: false,
  cloud: false,
} as const;

/**
 * The project files in the agent's own folder that would run or allow commands in a later turn (hooks, MCP servers, a
 * `read_config_from` turning the imports back on): removed before each turn, as Cursor's `hooks.json` is. A repository's
 * own `.devin/` elsewhere is the person's and stays.
 */
export const DEVIN_PROJECT_PLANTED = [
  "hooks.v1.json",
  "config.json",
  "config.local.json",
  "mcp_config.json",
  "mcp_config.local.json",
] as const;

/** `DEVIN_PROJECT_PLANTED` removed from `<folder>/.devin`. */
export function clearDevinProject(folder: string) {
  for (const name of DEVIN_PROJECT_PLANTED) rmSync(path.join(folder, ".devin", name), { force: true });
}

/** What the home may hold that a later turn would read: removed before each one. */
export const DEVIN_PLANTED = [
  ".claude",
  ".claude.json",
  ".cursor",
  ".codex",
  ".codeium",
  ".windsurf",
  ".devin",
  ".agents",
  ".copilot",
  ".gemini",
  "AGENTS.md",
  "CLAUDE.md",
  ".config/github-copilot",
  ".config/zed",
] as const;

function readConfig(home: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(devinConfigFile(home), "utf8"));
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
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
 * The account's settings, the same for every turn on it: the Devin organization the CLI saved at its sign-in kept
 * (`devin.org_id`), everything else ours. No shell setup (it would write the home's `.bashrc`), no updates of its own
 * (the computer's setup pins it), the agent in this process alone (`in-process`: never a daemon shared by turns),
 * folders trusted (the turn's folder is the runner's choice), nothing imported (`DEVIN_NO_IMPORTS`), and Code mode,
 * whose edits in the folder ask nothing.
 * Every other request for permission comes to the runner, which answers it (`devinPermission`).
 */
export function writeDevinConfig(home: string) {
  writeIfChanged(devinConfigFile(home), `${JSON.stringify(devinConfig(home), null, 2)}\n`);
}

/** The account's settings (`writeDevinConfig`), with a turn's own permission rules when it has them. */
export function devinConfig(
  home: string,
  turn?: { permissions: { allow: string[]; deny: string[]; ask: string[] }; subagents?: false },
): Record<string, unknown> {
  const was = readConfig(home);
  const org = isObject(was.devin) && typeof was.devin.org_id === "string" ? was.devin.org_id : undefined;
  return {
    version: 1,
    ...(org ? { devin: { org_id: org } } : {}),
    shell: { setup_complete: true },
    auto_update: false,
    process_model: "in-process",
    skip_workspace_trust: true,
    permission_mode: "accept-edits",
    read_config_from: DEVIN_NO_IMPORTS,
    permissions: turn?.permissions ?? { allow: [], deny: [], ask: [] },
    ...(turn?.subagents === false ? { subagents_enabled: false } : {}),
  };
}

/**
 * A turn's settings file (`devin --config <file> acp`), beside the account's: the account's settings with the rules of
 * the turn's profile (`devinTurnRules`), so turns of several profiles on one account never share them. Removed when
 * the turn ends.
 */
export function writeDevinTurnConfig(
  file: string,
  home: string,
  turn: { permissions: { allow: string[]; deny: string[]; ask: string[] }; subagents?: false },
) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(devinConfig(home, turn), null, 2)}\n`, { mode: 0o600 });
}

/**
 * The home made ready for the CLI: what a turn could plant removed, the CLI's config folder holding its settings alone
 * (no MCP servers, rules, skills, hooks or plugins of its own: our server comes with each session), the settings
 * written, and the sign-in kept to the account's user (600).
 */
export function prepareDevinHome(home: string) {
  for (const name of DEVIN_PLANTED) rmSync(path.join(home, name), { recursive: true, force: true });
  const configDir = path.dirname(devinConfigFile(home));
  if (existsSync(configDir)) {
    for (const name of readdirSync(configDir)) {
      if (name !== "config.json") rmSync(path.join(configDir, name), { recursive: true, force: true });
    }
  }
  writeDevinConfig(home);
  const creds = devinCredentialsFile(home);
  if (existsSync(creds)) chmodSync(creds, 0o600);
}
