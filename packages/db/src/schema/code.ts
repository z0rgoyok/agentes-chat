import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { channels } from "./chat";
import { machines } from "./machines";
import { organizations } from "./tenancy";

/**
 * A code session (ADR 0215): one request worked on in its own git worktree on the agent's computer, with its own
 * conversation. The conversation is a channel of kind `code` (private, never listed) with one root message
 * (`meta.codeSession`); the session is that thread's replies, as a task's conversation is (ADR 0145). Its agent
 * answers there like in a DM, and its computer brain (Claude Code, Codex) works with the worktree as its folder.
 * The worktree is made by the runner's `mission.worktree` op (ADR 0044), from the repository's checkout in
 * `repo_dir`, on a branch under `agentes/<handle>/` (the only new branches the git proxy lets the agent push).
 */
export const codeSessions = pgTable(
  "code_sessions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The session's conversation: a channel of kind `code`. */
    channelId: uuid().notNull(),
    /** The conversation's root message (`meta.codeSession`); the session is its replies. */
    rootMessageId: uuid().notNull(),
    /** Who works in it: its brain runs in the worktree. */
    agentId: uuid().notNull(),
    /** The computer the worktree is on (the agent's when the session started). */
    machineId: uuid().references(() => machines.id, { onDelete: "set null" }),
    /** `owner/name` on GitHub. */
    repo: text().notNull(),
    /** The repository's checkout on the computer, relative to the agent's folder (`repos/<owner>/<name>`). */
    repoDir: text().notNull(),
    /** Named from the request ("Linha do frete com cupom de frete"); people may rename it. */
    title: text().notNull(),
    /** `agentes/<handle>/<slug>`; null until the worktree is made. */
    branch: text(),
    /** The branch the worktree started from and its commit (the base of "everything since"). */
    baseBranch: text(),
    baseSha: text(),
    /** The worktree's folder, relative to the agent's folder (`.worktrees/c-<short id>`). */
    worktreePath: text(),
    /** `preparing | ready | failed | removed`; validated in code. Runs wait while `preparing`. */
    worktreeState: text().notNull().default("preparing"),
    /** Why it failed (the last lines), shown in the conversation. */
    worktreeError: text(),
    /** What the runner found to install the project (from its lockfile), told to the agent on its first turn. */
    setupCommand: text(),
    /** The pull request opened from the branch, when one is (GitHub only). */
    prNumber: integer(),
    prUrl: text(),
    /** The last known size of the change against the base (shown in the list): files, added and removed lines. */
    files: integer().notNull().default(0),
    added: integer().notNull().default(0),
    removed: integer().notNull().default(0),
    statAt: timestamp({ withTimezone: true }),
    createdBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Closed by a person: out of the list; the worktree is removed from the computer. */
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
    unique().on(t.orgId, t.channelId),
    index().on(t.orgId, t.createdBy),
    index().on(t.orgId, t.repo, t.branch),
    index().on(t.machineId),
  ],
);

/** A checkout as the last `git.sync` of it answered, with its tries since the last good one (`agentCheckouts`). */
export interface KnownCheckout {
  repo: string;
  dir: string;
  path?: string;
  status: "cloned" | "updated" | "missing" | "failed" | "cloning";
  head?: string;
  branch?: string;
  defaultBranch?: string;
  message?: string;
  /** Failed updates in a row. */
  failures?: number;
  /** Epoch ms before which it isn't synced again (the backoff after a failure). */
  retryAt?: number;
}

/**
 * An agent's checkouts on its computer as their last sync left them (`prepareAgentCode`): a chat turn starts from
 * these at once while the next sync runs beside it, and every process reads the same times, so a repository is
 * synced at most once every few minutes whichever one runs the turn.
 */
export const agentCheckouts = pgTable(
  "agent_checkouts",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    repos: jsonb().$type<KnownCheckout[]>().notNull().default([]),
    /** When the last sync of the checkouts started (claimed by one process); null before the first. */
    syncStartedAt: timestamp({ withTimezone: true }),
    /** When the last sync answered. */
    syncedAt: timestamp({ withTimezone: true }),
    /** When the computer last got a fresh proxy credential for the agent (every sync, a mission turn's too). */
    credentialAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.machineId] }),
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
  ],
);
