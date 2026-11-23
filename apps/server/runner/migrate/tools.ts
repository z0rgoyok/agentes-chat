import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Budget, type Collected, type Entry, MigrateError, noCounts, noLeft, walk } from "./collect";

/**
 * OpenMausBot and Paperclip keep their teams behind a server of their own, so they are read with the export their
 * own command line documents, run here against the app on this computer:
 * - `openmausbot team export --out FILE` (`docs/headless-cli.md`): the headless team file with its skills beside
 *   it, keys already replaced by placeholders;
 * - `paperclipai company export <id> --out DIR` (`docs/guides/board-operator/importing-and-exporting.md`): an
 *   Agent Companies package, which carries environment declarations only.
 * Both are formats the import page reads (`openmausbot.ts`, `paperclip.ts`). The command must already be installed:
 * nothing is fetched to run it.
 */

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

function run(command: string, args: string[]): Ran {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    // A .cmd shim on Windows only starts through the shell; the arguments here are ours or checked ids.
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing };
}

/** The last line a command said, for the person: its own words on why it stopped. */
const lastLine = (r: Ran) =>
  (r.stderr.trim() || r.stdout.trim())
    .split("\n")
    .filter((l) => l.trim())
    .pop()
    ?.slice(0, 300) ?? "";

/** A temporary folder for the app's export, removed once its files are in the archive (`done`). */
function staging(): string {
  return mkdtempSync(path.join(os.tmpdir(), "agentes-migrate-"));
}

function packed(source: Collected["source"], where: string, dir: string, top: string): Collected {
  const left = noLeft();
  const counts = noCounts();
  const entries: Entry[] = [];
  for (const f of walk(dir, left, new Budget())) {
    // Read now: the staging folder is removed before the archive is written.
    entries.push({ name: `${top}/${f.rel}`, source: { bytes: new Uint8Array(readFileSync(f.file)) } });
    if (/(^|\/)SKILL\.md$/.test(f.rel)) counts.skills++;
    if (/^agents\/[^/]+\/AGENTS?\.md$/.test(f.rel)) counts.agents++;
    if (/^tasks\/[^/]+\/TASK\.md$/.test(f.rel)) counts.routines++;
  }
  return { source, where, entries, counts, left, notes: [] };
}

export function collectOpenMausBot(): Collected {
  const dir = staging();
  try {
    const out = path.join(dir, "team.json");
    const r = run("openmausbot", ["team", "export", "--out", out]);
    if (r.missing) {
      throw new MigrateError(
        "tool_missing",
        "OpenMausBot's command isn't installed. Run `npm install -g openmausbot`, then this again. Or in the app: right-click the team › Share team… › Save file, and drop that file on agentes.chat.",
      );
    }
    if (r.status === 5) {
      throw new MigrateError("not_found", "OpenMausBot isn't running on this computer. Open it, then run this again.");
    }
    if (r.status !== 0) {
      throw new MigrateError("unreadable", `OpenMausBot's export stopped: ${lastLine(r) || `exit ${r.status}`}`);
    }
    const found = packed("openmausbot", "the OpenMausBot running on this computer", dir, "openmausbot");
    try {
      const team = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
      const lists = (key: string) => (Array.isArray(team[key]) ? (team[key] as unknown[]) : []);
      found.counts.agents = lists("bots").length;
      found.counts.channels = lists("rooms").length;
    } catch {}
    if (found.entries.length === 0) throw new MigrateError("nothing", "OpenMausBot exported nothing.");
    return found;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function collectPaperclip(options: { company?: string }): Collected {
  const listed = run("paperclipai", ["company", "list", "--json"]);
  if (listed.missing) {
    throw new MigrateError(
      "tool_missing",
      "Paperclip's command isn't installed. Run `npm install -g paperclipai`, then this again. Or drop the company's folder (the one with COMPANY.md) on agentes.chat.",
    );
  }
  if (listed.status !== 0) {
    throw new MigrateError(
      "not_found",
      `Paperclip didn't answer on this computer. Start it, then run this again. (${lastLine(listed) || `exit ${listed.status}`})`,
    );
  }
  let companies: { id: string; name: string }[] = [];
  try {
    const parsed = JSON.parse(listed.stdout) as unknown;
    const rows = Array.isArray(parsed) ? parsed : ((parsed as { companies?: unknown[] }).companies ?? []);
    companies = rows.flatMap((c) => {
      const row = c as { id?: unknown; name?: unknown };
      return typeof row.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(row.id)
        ? [{ id: row.id, name: typeof row.name === "string" ? row.name : row.id }]
        : [];
    });
  } catch {}
  if (companies.length === 0) throw new MigrateError("nothing", "Paperclip has no company on this computer.");
  const wanted = options.company?.toLowerCase();
  const company = wanted
    ? companies.find((c) => c.id.toLowerCase() === wanted || c.name.toLowerCase() === wanted)
    : companies.length === 1
      ? companies[0]
      : undefined;
  if (!company) {
    const names = companies.map((c) => `"${c.name}"`).join(", ");
    throw new MigrateError(
      "bad_args",
      wanted
        ? `Paperclip has no company "${options.company}". It has: ${names}.`
        : `Paperclip has more than one company (${names}). Run this once for each, with --company "<name>".`,
    );
  }
  const dir = staging();
  try {
    const r = run("paperclipai", [
      "company",
      "export",
      company.id,
      "--out",
      dir,
      "--include",
      "company,agents,projects,tasks,skills",
    ]);
    if (r.status !== 0) {
      throw new MigrateError("unreadable", `Paperclip's export stopped: ${lastLine(r) || `exit ${r.status}`}`);
    }
    const found = packed("paperclip", `the Paperclip company "${company.name}"`, dir, "paperclip");
    if (found.entries.length === 0) throw new MigrateError("nothing", "Paperclip exported nothing.");
    return found;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
