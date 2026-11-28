import { FOLDER_PICK_PROTOCOL, MACHINE_PROTOCOL_VERSION, RUNNER_APP_PROTOCOL } from "@agenteschat/adapters";

/**
 * The newest desktop app's protocol when runners didn't yet say whether the app ran them (`RUNNER_APP_PROTOCOL`).
 * Below it an update exists however that runner was installed; at or above it, it may be the newest app there is.
 */
const UNSAID_APP_PROTOCOL = 77;

/**
 * Whether the agentes.chat app runs this computer's runner, rather than a Terminal install. A runner from before
 * `RUNNER_APP_PROTOCOL` doesn't say: off Linux, where the Terminal install is rare, or new enough to be the app of
 * that time, it counts as the app.
 */
export const runByApp = (m: { os: string; protocol: number; executors?: { app?: true } | null }) =>
  m.protocol >= RUNNER_APP_PROTOCOL ? m.executors?.app === true : m.os !== "linux" || m.protocol >= UNSAID_APP_PROTOCOL;

/**
 * How the person updates a computer whose runner is behind this server, which `agentes-runner update` and the
 * installer both catch up with: `command` (`agentes-runner update`), `installer` (system mode: the install command
 * again, as root). Null: nothing to update from here: current, the workspace's or this server's own computer (each
 * updated with its server), or run by the agentes.chat app, whose releases lag this server and which updates itself.
 * A runner from before `RUNNER_APP_PROTOCOL` counts only on Linux, where the app is rare, and only below the app of
 * that time.
 */
export function runnerUpdateOf(
  m: { kind: string; os: string; protocol: number; executors?: { mode?: string; app?: true } | null },
  server = MACHINE_PROTOCOL_VERSION,
): "command" | "installer" | null {
  if (m.kind !== "connected" || m.protocol >= server) return null;
  if (runByApp(m)) return null;
  return m.executors?.mode === "system" ? "installer" : "command";
}

/**
 * How a computer too old for something gets its update, said to the agent that tells the person. The workspace's own
 * computer (`managed`) updates by itself; this server's computer (`host`) and one that runs every agent as its own
 * user (system mode) take the install command again, as root. Their runners all refuse `agentes-runner update`.
 */
export const runnerUpdateWay = (
  computer: { kind?: string | null; executors?: { mode?: string } | null } | null | undefined,
) =>
  computer?.kind === "managed"
    ? "It updates by itself, so try again later."
    : computer?.kind === "host" || computer?.executors?.mode === "system"
      ? "Its owner updates it by running the install command again, as root."
      : "Its owner updates the agentes app there, or runs `agentes-runner update`.";

/**
 * Where the person at a computer changes what agents may use there, said to the agent that tells them: the
 * agentes.chat app's Preferences (`pane`) on a Mac or a PC, else the runner's `commands` (a server may have no app).
 */
export const personAtComputerWay = (
  computer: { os: string; executors?: { mode?: string } | null },
  pane: string,
  commands: string[],
) =>
  computer.os === "darwin" || computer.os === "windows"
    ? `in the agentes.chat app there (Preferences › ${pane})`
    : `with ${commands.map((c) => `\`${computer.executors?.mode === "system" ? "sudo " : ""}agentes-runner ${c}\``).join(" and ")} there`;

/** The agentes.chat app runs this computer's runner, new enough to show a folder asked for from the apps. */
export const folderPickable = (m: { kind: string; protocol: number; executors?: { app?: true } | null }) =>
  m.kind !== "managed" && m.protocol >= FOLDER_PICK_PROTOCOL && m.executors?.app === true;
