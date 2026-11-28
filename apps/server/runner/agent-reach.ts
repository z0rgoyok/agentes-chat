import { execFile } from "node:child_process";
import { CLI_HOME_ONLY, CLI_NAMES, type RunnerInfo } from "@agenteschat/adapters/machine-protocol";
import { AGENT_PATH, type AgentUser, PROBE_AGENT_UID, readAgentUsers, SETPRIV, systemLauncher } from "./agent-users";
import { CLI_COMMAND } from "./cli-copies";
import { execResult, pickedCommand, type RunResult, versionLine } from "./executors";

type Executors = NonNullable<RunnerInfo["executors"]>;

/**
 * System mode: root's look finds the CLIs on root's PATH and in root's own install folders, which no agent's user can
 * reach. Each CLI root found is run again (`<command> --version`) the way an agent starts it: first as a stand-in
 * agent (no groups, the PATH every agent shares), which every agent can do at least as well; only when that misses,
 * as each agent's own user through its launcher (its groups, its PATH with its own `~/.local/bin`). One that some agent
 * can't start isn't the computer's for its agents: `CLI_HOME_ONLY`, never ready.
 */

/** Runs `argv` with exactly `env`; the result as a look reads it. */
export type RunAs = (argv: string[], env: Record<string, string>) => Promise<RunResult>;

const STAND_IN = [SETPRIV, `--reuid=${PROBE_AGENT_UID}`, `--regid=${PROBE_AGENT_UID}`, "--clear-groups", "--"];
const STAND_IN_ENV = { PATH: AGENT_PATH, HOME: "/", LANG: "C.UTF-8" };

/**
 * `setpriv` found nothing this user may run by that name (127), or one it may not run (126). A launch that failed
 * itself (no `setpriv`) says nothing of the CLI: it never takes a CLI from the agents.
 */
const unreached = (r: RunResult) => r.status === 126 || r.status === 127;

const execAs: RunAs = ([file = "", ...args], env) =>
  new Promise((resolve) => {
    execFile(file, args, { env, cwd: "/", encoding: "utf8", timeout: 8000, maxBuffer: 1024 * 1024 }, (err, out, e) =>
      resolve(execResult(err, out, e)),
    );
  });

/** `command --version` as the agents run it: the first agent that can't start it, else the stand-in's answer. */
export async function agentsVersion(
  command: string,
  users: readonly AgentUser[],
  run: RunAs = execAs,
): Promise<RunResult> {
  const first = await run([...STAND_IN, command, "--version"], STAND_IN_ENV);
  if (!unreached(first) || users.length === 0) return first;
  let last = first;
  for (const u of users) {
    const l = systemLauncher(u, false);
    last = await run([...l.prefix, command, "--version"], l.env);
    if (unreached(last)) return last;
  }
  return last;
}

/** The version line every agent starts `command` at; null when one of them can't (or it said nothing for sure). */
export async function agentsCopy(command: string, home: string, run?: RunAs): Promise<string | null> {
  const r = await agentsVersion(command, readAgentUsers(home), run);
  return r.status === 0 && !r.error ? versionLine(r) : null;
}

/**
 * `found` as the agents reach it: a CLI some agent can't start leaves the list for `broken[cli] = CLI_HOME_ONLY`. One
 * whose check couldn't tell (a timeout, a crash) stays as root's look found it.
 */
export async function agentsReach(found: Executors, home: string, run?: RunAs): Promise<Executors> {
  const users = readAgentUsers(home);
  const out: Executors = { ...found };
  const broken = { ...found.broken };
  for (const cli of CLI_NAMES) {
    // What an agent's turn starts (`cliSpawn`): the file the runner picked, else the command on the agent's PATH.
    const command = pickedCommand(CLI_COMMAND[cli]) ?? CLI_COMMAND[cli];
    if (!found[cli] || !unreached(await agentsVersion(command, users, run))) continue;
    delete out[cli];
    broken[cli] = CLI_HOME_ONLY;
  }
  if (Object.keys(broken).length) out.broken = broken;
  return out;
}
