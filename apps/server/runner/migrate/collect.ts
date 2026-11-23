import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { isSecretFile } from "@agenteschat/tokens/names";
import type { ZipSource } from "./zip";

/**
 * What `agentes-runner migrate` reads from one app on this computer and writes to the export file (ADR 0055,
 * addendum 2026-11-16): the files as the import page already reads them, never keys or sign-ins.
 */

export const SOURCES = ["openbot", "openmausbot", "hermes", "openclaw", "paperclip"] as const;
export type SourceId = (typeof SOURCES)[number];

export const SOURCE_NAMES: Record<SourceId, string> = {
  openbot: "OpenBot",
  openmausbot: "OpenMausBot",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  paperclip: "Paperclip",
};

export interface Counts {
  agents: number;
  routines: number;
  memories: number;
  skills: number;
  channels: number;
  /** Workflows, which come as routines (or skills, when they start by hand). */
  workflows: number;
  /** The agents' own files (for their folders in the Drive), and their bytes. */
  files: number;
  bytes: number;
}

export const noCounts = (): Counts => ({
  agents: 0,
  routines: 0,
  memories: 0,
  skills: 0,
  channels: 0,
  workflows: 0,
  files: 0,
  bytes: 0,
});

/** What stayed on the computer, by why. */
export interface Left {
  /** Credential stores, by their name (`isSecretFile`). */
  secrets: number;
  /** Files over the Drive's limit for one file. */
  large: number;
  /** Symbolic links: never followed. */
  links: number;
  /** Files past what one export carries. */
  over: number;
}

export const noLeft = (): Left => ({ secrets: 0, large: 0, links: 0, over: 0 });

export interface Entry {
  /** The path in the archive, with `/`. */
  name: string;
  source: ZipSource;
}

export interface Collected {
  source: SourceId;
  /** Where it was read from, for the person. */
  where: string;
  entries: Entry[];
  counts: Counts;
  left: Left;
  /** One line each, in English: what the person should know (a version not read, a part left out). */
  notes: string[];
}

/** A source that isn't on this computer, or can't be read; `message` says what to do. */
export class MigrateError extends Error {
  constructor(
    readonly code: "not_found" | "unreadable" | "unsupported" | "tool_missing" | "bad_args" | "nothing",
    message: string,
  ) {
    super(message);
  }
}

/** The Drive's limit for one file: a larger one could never be copied there. */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;
/** Under the import's own limits (2 GB unpacked, 50,000 files), with room for the manifest and the skills. */
export const EXPORT_MAX_BYTES = 1800 * 1024 * 1024;
export const EXPORT_MAX_FILES = 20_000;

/** System files and what tools make again: the import page's own list (`apps/web/src/lib/import/archive.ts`). */
const JUNK =
  /(^|\/)(__MACOSX\/|\.DS_Store$|\._[^/]*$|Thumbs\.db$|desktop\.ini$|\.git\/|node_modules\/|__pycache__\/|\.?venv\/|site-packages\/|\.cache\/|\.next\/|\.tox\/)/;

/** How much one export has taken so far, shared by every folder walked into it. */
export class Budget {
  files = 0;
  bytes = 0;
  take(size: number): boolean {
    if (this.files >= EXPORT_MAX_FILES || this.bytes + size > EXPORT_MAX_BYTES) return false;
    this.files++;
    this.bytes += size;
    return true;
  }
}

export interface Walked {
  /** Relative to the folder walked, with `/`. */
  rel: string;
  file: string;
  size: number;
}

/**
 * Every regular file under `root`, in name order. Links are never followed, system files and credential stores are
 * left (counted in `left`), a file over the Drive's limit too. `skip` leaves a folder or a file by its relative path.
 */
export function walk(
  root: string,
  left: Left,
  budget: Budget,
  skip: (rel: string, directory: boolean) => boolean = () => false,
): Walked[] {
  const found: Walked[] = [];
  const visit = (dir: string, prefix: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = path.join(dir, name);
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        left.links++;
        continue;
      }
      if (info.isDirectory()) {
        if (JUNK.test(`${rel}/`) || skip(rel, true)) continue;
        visit(full, rel);
        continue;
      }
      if (!info.isFile() || JUNK.test(rel) || skip(rel, false)) continue;
      if (isSecretFile(rel)) left.secrets++;
      else if (info.size > FILE_MAX_BYTES) left.large++;
      else if (!budget.take(info.size)) left.over++;
      else found.push({ rel, file: full, size: info.size });
    }
  };
  visit(root, "");
  return found;
}

/** `~` and `~/…` as the person's home. */
export function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  return value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : value;
}

/** A path with the person's home written `~`, for a line they read. */
export function tilde(value: string, home: string): string {
  return value === home ? "~" : value.startsWith(home + path.sep) ? `~${value.slice(home.length)}` : value;
}
