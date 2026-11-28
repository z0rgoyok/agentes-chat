import { cliVersionOf } from "./plans";

/**
 * Which versions of each coding CLI agentes.chat runs turns on: pure data, read by the server against the versions the
 * computers report (`hello.executors`), so changing it takes a server deploy and never a runner release. A CLI below
 * its `min`, or on a `blocked` version, can't be chosen and gets no turn: its agents wait for it to be updated, and the
 * apps say why and how (`cliVersionProblem`).
 *
 * Keys are the executors' (`claude` is Claude Code). Each `min` is the oldest version the code needs, with the reason
 * beside it; `blocked` lists versions with a known problem for agentes.chat, each with its reason. A CLI with neither
 * runs at any version its runner reports.
 */
export type FloorCli = "claude" | "codex" | "cursor" | "opencode" | "grok" | "antigravity" | "devin";

export interface CliFloor {
  /** The oldest version turns run on (`1.2.3`). */
  min?: string;
  /** Versions no turn runs on (`1.2.3` each). */
  blocked?: readonly string[];
}

export const CLI_FLOORS: Readonly<Record<FloorCli, CliFloor>> = {
  // Every command of a turn goes through our prompt tool (`--permission-prompt-tool`, an MCP tool of our bridge): before
  // 2.1.206 Claude Code crashed with "MCP tool not found" when the bridge hadn't connected yet at its start.
  claude: { min: "2.1.206" },
  // A `chat` turn turns off every Codex feature of 0.164.0 by name, and Codex fails the turn on a name it doesn't know
  // (`CODEX_CHAT_OFF` in the runner).
  codex: { min: "0.164.0" },
  cursor: {},
  opencode: {},
  grok: {},
  antigravity: {},
  devin: {},
};

/**
 * The command that updates a CLI where its own updater is the way (Claude Code's native install, OpenCode's), for the
 * server's words; the apps show the installer's line for the others (`cliInstallCommand`), which installs the newest.
 */
export const CLI_UPDATE_COMMAND: Readonly<Partial<Record<FloorCli, string>>> = {
  claude: "claude update",
  opencode: "opencode upgrade",
};

/** Why a reported version gets no turn: older than the floor, or a blocked one. */
export type CliVersionProblem =
  | { kind: "too_old"; version: string; min: string }
  | { kind: "blocked"; version: string };

const dotted = (v: readonly number[]) => v.join(".");

/**
 * What keeps `cli` at its reported `--version` line from running turns, or null. A line with no version in it is never
 * held back on a guess.
 */
export function cliVersionProblem(
  cli: FloorCli,
  line: string | null | undefined,
  floors: Readonly<Record<FloorCli, CliFloor>> = CLI_FLOORS,
): CliVersionProblem | null {
  const have = cliVersionOf(line);
  if (!have) return null;
  const floor = floors[cli];
  const version = dotted(have);
  if (floor.blocked?.some((b) => dotted(cliVersionOf(b) ?? []) === version)) return { kind: "blocked", version };
  const min = floor.min ? cliVersionOf(floor.min) : null;
  if (min) {
    for (let i = 0; i < 3; i++) {
      if (have[i] === min[i]) continue;
      return (have[i] ?? 0) < (min[i] ?? 0) ? { kind: "too_old", version, min: dotted(min) } : null;
    }
  }
  return null;
}
