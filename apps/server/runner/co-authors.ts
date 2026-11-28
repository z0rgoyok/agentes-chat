import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentScope } from "@agenteschat/adapters/machine-protocol";

/**
 * The `Co-Authored-By` lines on every commit the agent's own processes make with git (ADR 0156): the server sends
 * them with the work it starts (`AgentScope.coAuthors`), and the runner gives those processes, in their environment
 * only, a `core.hooksPath` to its own hooks folder (`GIT_CONFIG_PARAMETERS`, what `git -c` hands its children) and
 * the lines (`AGENTES_CO_AUTHORS`). Nothing changes in a repository or in anyone's git config: git run outside the
 * agent's processes (a person's own shell on that computer) never sees it.
 *
 * - Every hook name git knows is the same shim. It runs the repository's own hook of that name first, as git would
 *   without us, found by `git rev-parse --git-path hooks` with the env's config as it was before ours: a repository's
 *   own `core.hooksPath` (husky's `.husky/_`) keeps working, and the shim never finds itself.
 * - A repository on Git LFS (an `lfs` folder in its git dir) with none of its own gets LFS's four (`git lfs pre-push`
 *   and the others): LFS puts its hooks where `core.hooksPath` points, our folder, so in the agent's processes it
 *   never installs them, and without its `pre-push` a push leaves the files out of the remote, silently.
 * - `commit-msg` then adds each line the message lacks (`git interpret-trailers --if-exists addIfDifferent`, which
 *   compares case-insensitively): never twice, after Claude Code's own `Co-Authored-By`. Git runs no `commit-msg` for
 *   a rebase, a cherry-pick or a revert, so commits of others picked again credit nobody new; `--no-verify` skips it,
 *   as it skips every hook, and so does `git -c core.hooksPath=…`.
 * - One variable for the setting, never `GIT_CONFIG_COUNT`'s three: a CLI that drops variables named like a key
 *   (Codex leaves out `*KEY*` by default) would leave git a count without its key, and git refuses every command then.
 */

/** Every hook githooks(5) names: a repository's own one of any name still runs under the agent's processes. */
const GIT_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
];

/** The lines, one per line. */
export const CO_AUTHORS_ENV = "AGENTES_CO_AUTHORS";
/** The env's own `GIT_CONFIG_PARAMETERS` before ours was added, when it had one. */
const BEFORE_ENV = "AGENTES_GIT_CONFIG_PARAMETERS";

export const HOOK_SCRIPT = `#!/bin/sh
# agentes.chat (ADR 0156): the repository's own hook of this name (else Git LFS's where it uses LFS), then, in
# commit-msg, the agent's lines.
d=$(GIT_CONFIG_PARAMETERS=\${${BEFORE_ENV}-} git rev-parse --git-path hooks 2>/dev/null)
h=$d/\${0##*/}
if [ -n "$d" ] && [ -f "$h" ] && [ -x "$h" ] && [ "$(cd "$d" 2>/dev/null && pwd -P)" != "$(cd "\${0%/*}" && pwd -P)" ]; then
  [ "\${0##*/}" = commit-msg ] || exec "$h" "$@"
  "$h" "$@" || exit
fi
case \${0##*/} in pre-push|post-checkout|post-commit|post-merge)
  c=$(git rev-parse --git-common-dir 2>/dev/null) && [ -d "$c/lfs" ] && exec git lfs "\${0##*/}" "$@";;
esac
[ "\${0##*/}" = commit-msg ] || exit 0
msg=$1
set --
while IFS= read -r line; do
  [ -n "$line" ] && set -- "$@" --trailer "$line"
done <<LINES
$${CO_AUTHORS_ENV}
LINES
[ $# -eq 0 ] || git interpret-trailers --in-place --if-exists addIfDifferent "$@" "$msg" || true
exit 0
`;

/**
 * The hooks folder where this process's agents may read it, made again on each piece of work: a hook installer run
 * in an agent's process (lefthook, simple-git-hooks, `git lfs update --force`) takes `core.hooksPath` for where to
 * write, and what it left there would run for every other repository. The agents' computer instructions say to run
 * one without our setting.
 */
export function coAuthorHooks(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    for (const name of GIT_HOOKS) {
      const file = path.join(dir, name);
      let now = "";
      try {
        now = readFileSync(file, "utf8");
      } catch {}
      if (now !== HOOK_SCRIPT) {
        // A git running the old one never reads half of the new one.
        writeFileSync(`${file}.new`, HOOK_SCRIPT, { mode: 0o755 });
        renameSync(`${file}.new`, file);
      }
      chmodSync(file, 0o755);
    }
    return dir;
  } catch {
    // Not written: the agent's commits go without the lines rather than past hooks that aren't there.
    return null;
  }
}

// A server older than protocol 85 sends `Co-authored-by`.
// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character would break the trailer
const CO_AUTHOR = /^Co-Authored-By: [^\u0000-\u001f\u007f<>]{1,200} <[^\u0000- \u007f<>]{1,200}>$/i;

/** The lines a request carries for its agent's commits (`AgentScope.coAuthors`), each checked, at most four. */
export function coAuthorLines(agent: AgentScope | undefined): string[] {
  const given: unknown = agent?.coAuthors;
  if (!Array.isArray(given)) return [];
  return given.filter((l): l is string => typeof l === "string" && CO_AUTHOR.test(l)).slice(0, 4);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character would break the commit's header
const AUTHOR_NAME = /^[^\u0000-\u001f\u007f<>]{1,200}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character would break the commit's header
const AUTHOR_EMAIL = /^[^\u0000- \u007f<>@]{1,100}@[^\u0000- \u007f<>@]{1,100}$/;

/**
 * The person a request's commits are authored as (`AgentScope.author`, ADR 0215 §13), checked, as the env git reads
 * before any config: author and committer, in the agent's own processes alone. Nothing changes in a repository,
 * whose config other sessions share. Empty when the request names nobody: the checkout's author, the agent, stays.
 */
export function commitAuthorEnv(agent: AgentScope | undefined): Record<string, string> {
  const given: unknown = agent?.author;
  if (!given || typeof given !== "object") return {};
  const { name, email } = given as { name?: unknown; email?: unknown };
  if (typeof name !== "string" || typeof email !== "string") return {};
  if (!AUTHOR_NAME.test(name.trim()) || !AUTHOR_EMAIL.test(email)) return {};
  return {
    GIT_AUTHOR_NAME: name.trim(),
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name.trim(),
    GIT_COMMITTER_EMAIL: email,
  };
}

/** One `git -c` setting as `GIT_CONFIG_PARAMETERS` holds it (the form every git reads, before 2.31 too). */
const gitParameter = (setting: string) => `'${setting.replace(/'/g, "'\\''")}'`;

/** The env that makes git in a process end each commit with `lines`: `hooks` after the env's own `git -c` settings. */
export function coAuthorEnv(lines: readonly string[], hooks: string, base: NodeJS.ProcessEnv): Record<string, string> {
  if (lines.length === 0) return {};
  const before = base.GIT_CONFIG_PARAMETERS?.trim() ?? "";
  const ours = gitParameter(`core.hooksPath=${hooks}`);
  return {
    GIT_CONFIG_PARAMETERS: before ? `${before} ${ours}` : ours,
    ...(before ? { [BEFORE_ENV]: before } : {}),
    [CO_AUTHORS_ENV]: lines.join("\n"),
  };
}
