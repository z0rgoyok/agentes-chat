import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { type Collected, expandHome, MigrateError, SOURCE_NAMES, SOURCES, type SourceId, tilde } from "./collect";
import { collectHermes, collectOpenClaw } from "./folders";
import { collectOpenBot, openbotDataDir } from "./openbot";
import { collectOpenMausBot, collectPaperclip } from "./tools";
import { ZipWriter } from "./zip";

/**
 * `agentes-runner migrate` (ADR 0055, addendum 2026-11-16): reads the agents another app keeps on this computer and
 * writes one .zip the import page reads. It sends nothing and connects to nothing: the person drops the file on
 * agentes.chat, where they see what comes before anything is made. Built to be run by a coding assistant too: no
 * question without a terminal, `--json` for one document on stdout, and an exit code that says how it went.
 */

export const MIGRATE_HELP = `Usage: agentes-runner migrate [--from APP] [--out FOLDER] [--json] [--no-files]

Reads the agents another app keeps on this computer and writes one .zip to drop on agentes.chat.
It only reads, and it sends nothing.

  --from APP       ${SOURCES.join(", ")} (asked, or the only one found, when left out)
  --out FOLDER     where the file goes (asked on a terminal; the Downloads folder otherwise)
  --no-files       leave the agents' own files on this computer
  --data FOLDER    the app's data folder, when it isn't the usual one (openbot, hermes, openclaw)
  --company NAME   paperclip: which company, when there is more than one
  --json           one JSON document on stdout, also for a failure

Exit codes: 0 written, 1 it couldn't be read, 2 the command line is wrong, 3 nothing to bring.`;

export interface MigrateArgs {
  from?: string;
  out?: string;
  data?: string;
  company?: string;
  json: boolean;
  noFiles: boolean;
}

interface Io {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Whether a person can answer here. */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Shows the written file in the Finder or Explorer, where there is one. */
  reveal?: (file: string) => void;
}

const EXIT: Record<MigrateError["code"], number> = {
  not_found: 3,
  nothing: 3,
  bad_args: 2,
  unreadable: 1,
  unsupported: 1,
  tool_missing: 1,
};

/** Where each app that keeps its agents in a folder has it. */
function folderOf(source: "openbot" | "hermes" | "openclaw", io: Io, data?: string): string {
  if (data) return path.resolve(expandHome(data, io.home));
  if (source === "openbot") return openbotDataDir(io.home, io.env, io.platform);
  if (source === "hermes") return io.env.HERMES_HOME || path.join(io.home, ".hermes");
  return io.env.OPENCLAW_STATE_DIR || path.join(io.home, ".openclaw");
}

/** The apps whose folder is on this computer. The two read through their own command are never guessed. */
export function foundSources(io: Io): SourceId[] {
  const found: SourceId[] = [];
  if (existsSync(path.join(folderOf("openbot", io), "openbot.db"))) found.push("openbot");
  if (existsSync(folderOf("hermes", io))) found.push("hermes");
  if (existsSync(folderOf("openclaw", io))) found.push("openclaw");
  return found;
}

async function collect(source: SourceId, args: MigrateArgs, io: Io): Promise<Collected> {
  switch (source) {
    case "openbot":
      return collectOpenBot({ dataDir: folderOf("openbot", io, args.data), home: io.home, noFiles: args.noFiles });
    case "hermes":
      return collectHermes({ dir: folderOf("hermes", io, args.data), home: io.home });
    case "openclaw":
      return collectOpenClaw({ dir: folderOf("openclaw", io, args.data), home: io.home, noFiles: args.noFiles });
    case "openmausbot":
      return collectOpenMausBot();
    case "paperclip":
      return collectPaperclip({ company: args.company });
  }
}

const isSource = (value: string): value is SourceId => (SOURCES as readonly string[]).includes(value);

function downloads(io: Io): string {
  const dir = path.join(io.home, "Downloads");
  return existsSync(dir) ? dir : io.home;
}

/** `1.5 MB`, for a line a person reads. */
function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What was found, as one line: only the kinds there are. */
export function summary(c: Collected["counts"]): string {
  return [
    plural(c.agents, "agent"),
    c.routines ? plural(c.routines, "routine") : "",
    c.memories ? plural(c.memories, "memory", "memories") : "",
    c.skills ? plural(c.skills, "skill") : "",
    c.channels ? plural(c.channels, "channel") : "",
    c.workflows ? plural(c.workflows, "workflow") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What stayed on the computer, as one line; "" when nothing did. */
export function leftLine(left: Collected["left"]): string {
  const parts = [
    left.secrets
      ? `${plural(left.secrets, "file")} that ${left.secrets === 1 ? "holds" : "hold"} keys or sign-ins`
      : "",
    left.large ? `${plural(left.large, "file")} over 50 MB` : "",
    left.links ? plural(left.links, "link") : "",
    left.over ? `${plural(left.over, "file")} past what one export carries` : "",
  ].filter(Boolean);
  return parts.length ? `Left on this computer: ${parts.join(", ")}.` : "";
}

export async function migrate(args: MigrateArgs, io: Io): Promise<number> {
  const say = (line: string) => {
    if (!args.json) io.out(line);
  };
  const fail = (error: unknown): number => {
    const known = error instanceof MigrateError;
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = known ? EXIT[error.code] : 1;
    if (args.json) io.out(JSON.stringify({ ok: false, code: known ? error.code : "failed", error: message, exitCode }));
    else io.err(message);
    return exitCode;
  };
  try {
    let source: SourceId;
    if (args.from !== undefined) {
      const from = args.from.toLowerCase();
      if (!isSource(from)) {
        throw new MigrateError("bad_args", `--from takes one of: ${SOURCES.join(", ")}.`);
      }
      source = from;
    } else {
      const found = foundSources(io);
      const [only] = found;
      if (found.length === 1 && only) source = only;
      else if (found.length === 0) {
        throw new MigrateError(
          "not_found",
          "No OpenBot, Hermes or OpenClaw on this computer. For OpenMausBot or Paperclip, add --from openmausbot or --from paperclip.",
        );
      } else if (!io.interactive) {
        throw new MigrateError("bad_args", `Found ${found.join(", ")}. Say which with --from.`);
      } else {
        say("Found on this computer:");
        found.forEach((s, i) => {
          say(`  ${i + 1}. ${SOURCE_NAMES[s]}`);
        });
        const answer = (await io.ask(`Which one? (1-${found.length}) `)).trim();
        const picked = found[Number(answer) - 1] ?? (isSource(answer.toLowerCase()) ? answer.toLowerCase() : null);
        if (!picked || !isSource(picked)) throw new MigrateError("bad_args", "That isn't one of them.");
        source = picked;
      }
    }

    say(`Reading ${SOURCE_NAMES[source]} (read only)`);
    const found = await collect(source, args, io);
    say(`  ${summary(found.counts)}`);
    if (found.counts.files) say(`  ${plural(found.counts.files, "file")} of the agents (${size(found.counts.bytes)})`);
    const stayed = leftLine(found.left);
    if (stayed) say(`  ${stayed}`);
    for (const note of found.notes) say(`  ${note}`);

    let folder = args.out ? path.resolve(expandHome(args.out, io.home)) : "";
    if (!folder) {
      const suggested = downloads(io);
      const answer = io.interactive ? (await io.ask(`Where to save? (${tilde(suggested, io.home)}) `)).trim() : "";
      folder = answer ? path.resolve(expandHome(answer, io.home)) : suggested;
    }
    // A name ending in .zip is the file itself; anything else is the folder it goes in.
    const file = /\.zip$/i.test(folder) ? folder : path.join(folder, `agentes-chat-import-${source}.zip`);
    const dir = path.dirname(file);
    try {
      mkdirSync(dir, { recursive: true });
      if (!statSync(dir).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new MigrateError("bad_args", `Can't write in ${tilde(dir, io.home)}.`);
    }
    const zip = new ZipWriter(file);
    let skipped = 0;
    try {
      for (const entry of found.entries) if (!zip.add(entry.name, entry.source)) skipped++;
      zip.close();
    } catch (error) {
      zip.abort();
      throw new MigrateError(
        "unreadable",
        `Writing ${tilde(file, io.home)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (skipped > 0) found.notes.push(`${plural(skipped, "file")} couldn't be read and stayed out.`);

    if (args.json) {
      io.out(
        JSON.stringify({
          ok: true,
          source,
          app: SOURCE_NAMES[source],
          where: found.where,
          file,
          counts: found.counts,
          left: found.left,
          notes: found.notes,
        }),
      );
    } else {
      say("");
      say(`Written to ${tilde(file, io.home)}`);
      say("Drop that file on agentes.chat, on the import screen. Nothing was sent.");
      if (io.interactive) io.reveal?.(file);
    }
    return 0;
  } catch (error) {
    return fail(error);
  }
}

/** Shows the file in the Finder or Explorer, so it can be dragged; nothing where neither is there. */
function reveal(file: string, platform: NodeJS.Platform) {
  const command =
    platform === "darwin"
      ? { bin: "open", args: ["-R", file] }
      : platform === "win32"
        ? { bin: "explorer.exe", args: [`/select,${file}`] }
        : { bin: "xdg-open", args: [path.dirname(file)] };
  try {
    const child = spawn(command.bin, command.args, { stdio: "ignore", detached: true });
    // No file manager here: nothing to show.
    (child as unknown as { on: (event: "error", listener: () => void) => void }).on("error", () => {});
    child.unref();
  } catch {}
}

/** The command as the runner's `main` calls it. */
export async function runMigrate(args: MigrateArgs): Promise<number> {
  const interactive = !args.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    return await migrate(args, {
      home: os.homedir(),
      env: process.env,
      platform: process.platform,
      interactive,
      ask: async (question) => (rl ? rl.question(question) : ""),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      reveal: (file) => reveal(file, process.platform),
    });
  } finally {
    rl?.close();
  }
}
