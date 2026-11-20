import type { ImportCard } from "./flow";

/**
 * Bringing agents from an app that keeps them on the person's computer (ADR 0055, addendum 2026-11-16): the
 * request to paste in a coding assistant, and the command it runs. `agentes-runner migrate`
 * (`apps/server/runner/migrate/`) reads the app there and writes one file; the person drops it on the import
 * screen. Nothing is sent by the command.
 */

/**
 * The apps `migrate` reads, by their card: what `--from` takes, the app's name in a sentence, and whether one of its
 * agents can be asked for the export in a chat (Paperclip runs a company's agents, with no chat to ask in).
 */
const SOURCES = {
  openbotrun: { from: "openbot", app: "OpenBot", chat: true },
  openmausbot: { from: "openmausbot", app: "OpenMausBot", chat: true },
  hermes: { from: "hermes", app: "Hermes", chat: true },
  openclaw: { from: "openclaw", app: "OpenClaw", chat: true },
  paperclip: { from: "paperclip", app: "Paperclip", chat: false },
} as const satisfies Partial<Record<ImportCard, { from: string; app: string; chat: boolean }>>;

export type ComputerCard = keyof typeof SOURCES;

/** A card whose app keeps its agents on the person's computer: picking it opens the request, not steps. */
export const isComputerCard = (card: ImportCard | null): card is ComputerCard => card !== null && card in SOURCES;

export const computerApp = (card: ComputerCard): string => SOURCES[card].app;

/** Whether the app's own agent can be asked, in a chat, to write the export. */
export const computerChat = (card: ComputerCard): boolean => SOURCES[card].chat;

/** The file `migrate` writes for a card's app. */
export const migrateFile = (card: ComputerCard): string => `agentes-chat-import-${SOURCES[card].from}.zip`;

/** Windows asks for PowerShell; everywhere else a POSIX shell. */
export type ComputerOs = "windows" | "unix";

/** From `navigator.platform` or a user agent: Windows, else a POSIX shell (macOS, Linux). */
export const computerOs = (platform: string): ComputerOs => (/win/i.test(platform) ? "windows" : "unix");

const origin = (server: string) => server.replace(/\/+$/, "");

/**
 * The one line to paste in a terminal. With no folder it asks where to save; `folder` is passed on as written
 * (the request below leaves a placeholder for the assistant to fill).
 */
export function migrateCommand(server: string, card: ComputerCard, os: ComputerOs, folder?: string): string {
  const { from } = SOURCES[card];
  const url = origin(server);
  if (os === "windows") {
    const out = folder === undefined ? "" : ` -Out "${folder}"`;
    return `& ([scriptblock]::Create((irm ${url}/migrate.ps1))) -From ${from}${out}`;
  }
  const out = folder === undefined ? "" : ` --out "${folder}"`;
  return `curl -fsSL ${url}/migrate.sh | sh -s -- --from ${from}${out}`;
}

/**
 * The request for a coding assistant (Claude Code, Codex and the like), in English as `EXPORT_PROMPT` is: ask where
 * to save, run the command with that folder, say what it found. The assistant never opens the file or reads keys.
 */
export function migratePrompt(server: string, card: ComputerCard, os: ComputerOs): string {
  const { app } = SOURCES[card];
  const command = migrateCommand(server, card, os, "<folder>");
  const shell = os === "windows" ? " in PowerShell" : "";
  return `Move my ${app} agents to agentes.chat.

1. Ask me where to save the export file. Suggest my Downloads folder.

2. Run this${shell}, with the folder I chose in place of <folder>:

   ${command} ${os === "windows" ? "-Json" : "--json"}

   It only reads ${app} on this computer and writes ${migrateFile(card)} in that folder. It sends nothing.

3. Tell me what it found (agents, routines, memories, files), what it left out, and the full path of the file. If it failed, tell me what it said.

Don't open or change the file, and don't read keys, tokens or passwords yourself. I will drop the file on agentes.chat.`;
}
