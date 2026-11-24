/**
 * Code sessions (ADR 0215): a request worked on in its own git worktree on an agent's computer, with its own
 * conversation (a thread in a channel of kind `code`: `channelId` + `rootId`). The same shapes as the server's.
 */

export type CodeWorktreeState = "preparing" | "ready" | "failed" | "removed";

/** What a session is doing now, for the list: preparing, failed, a live run, waiting on me, or idle. */
export type CodeSessionWork = "preparing" | "failed" | "working" | "waiting" | "idle";

export interface CodeSession {
  id: string;
  /** Its conversation: post there with the chat's routes, with `rootId` as the thread. */
  channelId: string;
  rootId: string;
  title: string;
  /** `owner/name`. */
  repo: string;
  branch: string | null;
  baseBranch: string | null;
  agentId: string;
  machineId: string | null;
  worktree: { state: CodeWorktreeState; error: string | null; errorCode: "github_access" | null };
  /** A project only on the agent's computer (no remote): no push, no pull request. */
  local: boolean;
  pr: { number: number; url: string | null } | null;
  /** The last known size of the change against the base (`at` null: never read). */
  stat: { files: number; added: number; removed: number; at: string | null };
  work: CodeSessionWork;
  createdBy: string | null;
  createdAt: string;
  lastAt: string;
  /** The conversation it was opened from (a suggestion there, ADR 0215 §11), on the session's own read only. */
  from?: CodeSessionOrigin;
}

/** Where a session was opened from: a DM (`name` its agent's) or a channel (`name` the channel's). */
export interface CodeSessionOrigin {
  channelId: string;
  messageId: string;
  threadId: string | null;
  kind: "dm" | "channel";
  name: string;
}

/** Waiting for the person; being opened; opened as a session; kept in the chat. */
export type CodeSuggestionStatus = "pending" | "opening" | "opened" | "here";

/**
 * A code session an agent suggested in the chat (ADR 0215 §11), on its reply's `meta.codeSuggestion`: the person who
 * asked opens it (their words start it) or keeps the work in the conversation.
 */
export interface CodeSuggestion {
  id: string;
  agentId: string;
  /** `owner/name` on GitHub, or a project's name on the agent's computer. */
  repo: string;
  title: string;
  /** The person's words the session starts with ("Ver o pedido"). */
  request: string;
  requestMessageId: string;
  /** The person who asked: the one who decides. */
  askerId: string;
  status: CodeSuggestionStatus;
  sessionId?: string;
  /** Who decided, and when. */
  by?: string;
  at?: string;
}

/** Where a session can start: the agents that think on a computer, each with the repositories it may use. */
export interface CodeStartOptions {
  agents: { agentId: string; repos: string[]; any: boolean }[];
}

export interface CreateCodeSessionInput {
  agentId: string;
  repo: string;
  text: string;
}

/** Since the base (committed or not), only what isn't committed, or one commit (`sha`). */
export type CodeDiffScope = "base" | "uncommitted" | "commit";

export interface CodeDiffFile {
  path: string;
  /** Its unified patch; empty when the whole diff was too large to send. */
  patch: string;
  added: number;
  removed: number;
  untracked?: boolean;
}

export interface CodeDiff {
  scope: CodeDiffScope;
  base: { branch: string | null; sha: string | null };
  files: CodeDiffFile[];
  added: number;
  removed: number;
  truncated: boolean;
}

/** The step the header's git button offers next. */
export type CodeGitStep = "commit" | "push" | "pr" | "merge";

export interface CodeGit {
  uncommitted: number;
  ahead: number;
  upstream: boolean;
  /** A local project: Commit, then Merge into its base branch on the computer. */
  local: boolean;
  pr: { number: number; url: string | null } | null;
  next: CodeGitStep | null;
}

/** What `git status` says of a path not committed: changed, new (added, or not tracked yet), deleted or renamed. */
export type CodeChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface CodeChange {
  path: string;
  /** Where a renamed file was. */
  from?: string;
  status: CodeChangeStatus;
  /** Its lines against HEAD; null for a binary file (or a new one past those counted). */
  added: number | null;
  removed: number | null;
}

export interface CodeCommit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  /** When it was authored (ISO). */
  at: string;
  files: number;
  added: number;
  removed: number;
}

/** The Git tab: what isn't committed, and the branch's commits since its base (the newest first). */
export interface CodeGitLog {
  branch: string | null;
  base: { branch: string | null; sha: string | null };
  changes: CodeChange[];
  changesMore: boolean;
  commits: CodeCommit[];
  /** More commits than listed. */
  more: boolean;
}

/** The Files tab: the worktree's files git doesn't ignore, and which of them changed. */
export interface CodeFiles {
  paths: string[];
  truncated: boolean;
  changes: { path: string; status: CodeChangeStatus }[];
}

/**
 * A file read-only, or why not: `binary`, `missing` (gone, or a folder), `ignored` (git ignores it), `secret` (a
 * `.env` file), `outside` (a link out of the worktree).
 */
export type CodeFileState = "ok" | "binary" | "missing" | "ignored" | "secret" | "outside";

export interface CodeFile {
  path: string;
  state: CodeFileState;
  content: string;
  /** In bytes. */
  size: number;
  /** Only its start came. */
  truncated: boolean;
  /** What it holds, as git names it: a save sends the one it started from. Empty unless `ok`. */
  rev: string;
}
