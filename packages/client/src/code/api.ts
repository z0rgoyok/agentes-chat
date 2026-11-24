import { enc, type Requester } from "../api/http";
import type {
  CodeDiff,
  CodeDiffScope,
  CodeFile,
  CodeFiles,
  CodeGit,
  CodeGitLog,
  CodeSession,
  CodeStartOptions,
  CodeSuggestion,
  CreateCodeSessionInput,
} from "./types";

const org = (orgId: string) => `/api/app/organizations/${enc(orgId)}`;

/** Code sessions' routes (ADR 0215), `/api/app/organizations/{orgId}/code-sessions…`. */
export interface CodeApi {
  /** The sessions I take part in, most recent activity first. */
  list(orgId: string): Promise<CodeSession[]>;
  /** Where a session can start: agents on a computer and their repositories. */
  start(orgId: string): Promise<CodeStartOptions>;
  /** Opens a session: its conversation now, its worktree right after. */
  create(orgId: string, input: CreateCodeSessionInput): Promise<CodeSession>;
  get(orgId: string, sessionId: string): Promise<CodeSession>;
  rename(orgId: string, sessionId: string, title: string): Promise<CodeSession>;
  /** "Tentar de novo" on a failed worktree. */
  retry(orgId: string, sessionId: string): Promise<CodeSession>;
  /** Closes it: out of the list, the worktree removed (the branch stays). */
  close(orgId: string, sessionId: string): Promise<void>;
  /** The change, read with git in the worktree (`sha`: the commit, with `scope` "commit"). */
  diff(orgId: string, sessionId: string, scope: CodeDiffScope, sha?: string): Promise<CodeDiff>;
  /** Where its git stands and the next step. */
  git(orgId: string, sessionId: string): Promise<CodeGit>;
  /** The Git tab: what isn't committed and the branch's commits. */
  gitLog(orgId: string, sessionId: string): Promise<CodeGitLog>;
  /** The Files tab's list. */
  files(orgId: string, sessionId: string): Promise<CodeFiles>;
  /** One file, read-only. */
  file(orgId: string, sessionId: string, path: string): Promise<CodeFile>;
  /** Saves a file over the one read with `rev`; a file that changed since then is refused unless `overwrite`. */
  saveFile(
    orgId: string,
    sessionId: string,
    input: { path: string; content: string; rev: string; overwrite?: boolean },
  ): Promise<CodeFile>;
  /** "Abrir sessão" on a suggestion in the chat (ADR 0215 §11): the session, started with the asker's words. */
  openSuggestion(orgId: string, messageId: string): Promise<CodeSession>;
  /** "Fazer aqui": the agent goes on in the conversation. */
  keepHere(orgId: string, messageId: string): Promise<{ suggestion: CodeSuggestion }>;
}

export function createCodeApi(request: Requester): CodeApi {
  const one = (orgId: string, sessionId: string) => `${org(orgId)}/code-sessions/${enc(sessionId)}`;
  return {
    list: async (orgId) => (await request<{ sessions: CodeSession[] }>(`${org(orgId)}/code-sessions`)).sessions,
    start: (orgId) => request<CodeStartOptions>(`${org(orgId)}/code-sessions/start`),
    create: (orgId, input) => request<CodeSession>(`${org(orgId)}/code-sessions`, { json: input }),
    get: (orgId, sessionId) => request<CodeSession>(one(orgId, sessionId)),
    rename: (orgId, sessionId, title) =>
      request<CodeSession>(one(orgId, sessionId), { method: "PATCH", json: { title } }),
    retry: (orgId, sessionId) => request<CodeSession>(`${one(orgId, sessionId)}/retry`, { json: {} }),
    close: (orgId, sessionId) => request<void>(one(orgId, sessionId), { method: "DELETE" }),
    diff: (orgId, sessionId, scope, sha) =>
      request<CodeDiff>(`${one(orgId, sessionId)}/diff`, { query: sha ? { scope, sha } : { scope } }),
    git: (orgId, sessionId) => request<CodeGit>(`${one(orgId, sessionId)}/git`),
    gitLog: (orgId, sessionId) => request<CodeGitLog>(`${one(orgId, sessionId)}/git/log`),
    files: (orgId, sessionId) => request<CodeFiles>(`${one(orgId, sessionId)}/files`),
    file: (orgId, sessionId, path) => request<CodeFile>(`${one(orgId, sessionId)}/file`, { query: { path } }),
    saveFile: (orgId, sessionId, input) =>
      request<CodeFile>(`${one(orgId, sessionId)}/file`, { method: "PUT", json: input }),
    openSuggestion: (orgId, messageId) =>
      request<CodeSession>(`${org(orgId)}/code-sessions/suggestions/${enc(messageId)}/open`, { json: {} }),
    keepHere: (orgId, messageId) =>
      request<{ suggestion: CodeSuggestion }>(`${org(orgId)}/code-sessions/suggestions/${enc(messageId)}/here`, {
        json: {},
      }),
  };
}
