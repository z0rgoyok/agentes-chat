import { type CodeChangeStatus, type CodeSession, isLocalPlace } from "@agenteschat/client";
import { chatHref } from "../links/logic";

/*
 * Code sessions on the phone (ADR 0215): the web's Code page as pushed screens. The list, a new session, its
 * conversation (the chat's own thread screen, its root standing for the session), and the session's Git and Files.
 */

/** The phone's Code list, a new session, and where it works. */
export const CODING_HREF = "/coding";
export const CODING_NEW_HREF = "/coding/new";
export const CODING_WHERE_HREF = "/coding/where";

/** A session's conversation: its thread in its channel. */
export const sessionChatHref = (s: Pick<CodeSession, "channelId" | "rootId">) => chatHref(s.channelId, s.rootId);
/** A session's Git and Files. */
export const sessionCodeHref = (sessionId: string) => `/coding/${sessionId}`;
export const sessionPeopleHref = (sessionId: string) => `/coding/${sessionId}/people`;
/** A session's terminal: a shell in its worktree. */
export const sessionTerminalHref = (sessionId: string) => `/coding/${sessionId}/terminal`;
export const sessionFolderHref = (sessionId: string, dir: string) =>
  `/coding/${sessionId}/files?dir=${encodeURIComponent(dir)}`;
export const sessionFileHref = (sessionId: string, path: string) =>
  `/coding/${sessionId}/file?path=${encodeURIComponent(path)}`;
/** A diff: the whole branch since its base, one change not committed, or one commit. */
export type DiffOpen = { scope: "base" } | { scope: "uncommitted"; path: string } | { scope: "commit"; sha: string };
export const sessionDiffHref = (sessionId: string, d: DiffOpen) =>
  `/coding/${sessionId}/diff?scope=${d.scope}${"path" in d ? `&path=${encodeURIComponent(d.path)}` : ""}${"sha" in d ? `&sha=${d.sha}` : ""}`;

/**
 * A session's branch as the conversation's pill says it: without the `agentes/<handle>/` its agent's branches start
 * with (the pill already is that agent's session), so what is left is the change's own name.
 */
export const shortBranch = (branch: string) => branch.replace(/^agentes\/[^/]+\//, "");

/** A project only on the agent's computer: a name with no owner. */
export const isLocalRepo = (repo: string) => repo !== "" && isLocalPlace(repo);

/** The sessions by project, as the web's list groups them: the project of the newest first, each newest first. */
export function sessionsByRepo(
  list: readonly CodeSession[],
): { repo: string; local: boolean; sessions: CodeSession[] }[] {
  const groups = new Map<string, CodeSession[]>();
  const newest = [...list].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  for (const s of newest) groups.set(s.repo, [...(groups.get(s.repo) ?? []), s]);
  return [...groups.entries()].map(([repo, sessions]) => ({
    repo,
    local: sessions[0]?.local ?? isLocalRepo(repo),
    sessions,
  }));
}

/** A session's state in words (`codeSessions.state.*`), and its tone in a row: waiting on you reads amber. */
export function sessionStateKey(s: Pick<CodeSession, "work" | "pr">): {
  key: string;
  pr: number | null;
  waiting: boolean;
} {
  if (s.work === "idle" && s.pr) return { key: "codeSessions.state.pr", pr: s.pr.number, waiting: false };
  return { key: `codeSessions.state.${s.work}`, pr: null, waiting: s.work === "waiting" };
}

/** "+52 −10", nothing until the change was read once or when nothing changed. */
export function statWords(s: Pick<CodeSession, "stat">): string | null {
  if (!s.stat.at || s.stat.added + s.stat.removed === 0) return null;
  return `+${s.stat.added} −${s.stat.removed}`;
}

/** The letter `git status` gives each kind of change ("U": new, not tracked yet). */
export const CHANGE_LETTER: Record<CodeChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

/** A path as a row shows it: the file's name, then its folder. */
export function splitPath(path: string) {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

/**
 * One folder's entries from the worktree's paths: its folders (each once, with how many files they hold) then its
 * files, by name. `dir` "" is the worktree's top.
 */
export function folderEntries(
  paths: readonly string[],
  dir: string,
): { folders: { name: string; path: string; count: number }[]; files: string[] } {
  const prefix = dir ? `${dir}/` : "";
  const folders = new Map<string, number>();
  const here: string[] = [];
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const cut = rest.indexOf("/");
    if (cut < 0) here.push(p);
    else folders.set(rest.slice(0, cut), (folders.get(rest.slice(0, cut)) ?? 0) + 1);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  return {
    folders: [...folders.entries()]
      .sort(([a], [b]) => byName(a, b))
      .map(([name, count]) => ({ name, path: `${prefix}${name}`, count })),
    files: here.sort(byName),
  };
}
