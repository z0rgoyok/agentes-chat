import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { accountEnv, signInFileOnWindows } from "../../runner/accounts";
import { CURSOR_PROMPT_MAX, cursorPrompt, promptMaxOn, WINDOWS_PROMPT_MAX } from "../../runner/brain-cursor";
import { GIT_BASH_PICK, gitBashPath, withGitBash } from "../../runner/cli-install";
import { setCliPick } from "../../runner/executors";
import { removeDirs, tempDir } from "./helpers";

/*
 * The coding CLIs on Windows (ADR 0228 §6): each Cursor and Grok Build account's sign-in in its own folder, Claude
 * Code's Git Bash the person's or the runner's own, and a prompt that fits Windows' command line.
 */

const dirs: string[] = [];
afterEach(() => {
  setCliPick(GIT_BASH_PICK, undefined);
  removeDirs(dirs.splice(0));
});

test("Cursor on Windows keeps its sign-in in a file in the account's folder, never the Credential Manager", () => {
  const env = accountEnv("cursor", "C:\\acc\\c1", { APPDATA: "C:\\Users\\ana\\AppData\\Roaming" }, "win32");
  expect(env).toMatchObject({
    CURSOR_CONFIG_DIR: "C:\\acc\\c1",
    AGENT_CLI_CREDENTIAL_STORE: "file",
    APPDATA: "C:\\acc\\c1",
  });
  // Elsewhere the person's own folders stay as they are.
  expect(accountEnv("cursor", "/acc/c1", { APPDATA: "x" }, "linux").APPDATA).toBe("x");
});

test("the Antigravity CLI on Windows: the account's folder is its home (its sign-in is the computer user's, ADR 0143)", () => {
  const dir = tempDir("agy-win-");
  dirs.push(dir);
  const env = accountEnv("antigravity", dir, { USERPROFILE: "C:\\Users\\ana" }, "win32");
  expect(env).toMatchObject({ HOME: dir, USERPROFILE: dir });
  expect(accountEnv("antigravity", dir, { USERPROFILE: "x" }, "linux").USERPROFILE).toBe("x");
});

test("a Windows sign-in counts only once its file is in the account's folder; elsewhere nothing is checked", () => {
  expect(signInFileOnWindows("cursor", "C:\\acc\\c1", "win32")).toBe(path.join("C:\\acc\\c1", "Cursor", "auth.json"));
  // Grok Build keeps its `auth.json` in `GROK_HOME` everywhere; Claude Code and Codex their own config folders; the
  // Antigravity CLI the computer user's Credential Manager, one Gemini account a Windows computer (ADR 0143).
  for (const kind of ["grok", "claude_code", "codex", "opencode", "antigravity"] as const) {
    expect(signInFileOnWindows(kind, "C:\\acc\\x", "win32")).toBeNull();
  }
  expect(signInFileOnWindows("cursor", "/acc/c1", "darwin")).toBeNull();
});

test("Claude Code's Git Bash: the person's first, else the runner's own MinGit, set for its turns on Windows only", () => {
  const none = () => false;
  expect(gitBashPath({ PATH: "" }, none)).toBeNull();
  const dir = tempDir("mingit-");
  dirs.push(dir);
  const bash = path.join(dir, "bash.exe");
  writeFileSync(bash, "", { mode: 0o755 });
  setCliPick(GIT_BASH_PICK, bash);
  expect(gitBashPath({ PATH: "" }, none)).toBe(bash);
  // Whether the person has one: the runner's own doesn't count.
  expect(gitBashPath({ PATH: "" }, none, false)).toBeNull();
  // The person's pinned bash wins over the runner's.
  expect(
    gitBashPath({ CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe" }, (f) => f === "C:\\Git\\bin\\bash.exe"),
  ).toBe("C:\\Git\\bin\\bash.exe");
  expect(withGitBash({ PATH: "" }, "win32").CLAUDE_CODE_GIT_BASH_PATH).toBe(bash);
  expect(withGitBash({ PATH: "" }, "linux").CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
  expect(withGitBash({ CLAUDE_CODE_GIT_BASH_PATH: "mine" }, "win32").CLAUDE_CODE_GIT_BASH_PATH).toBe("mine");
});

test("a prompt fits Windows' command line: the context loses its middle, the prompt stays whole", () => {
  expect(promptMaxOn("win32")).toBe(WINDOWS_PROMPT_MAX);
  expect(promptMaxOn("linux")).toBe(CURSOR_PROMPT_MAX);
  const context = `${"a".repeat(20_000)}${"b".repeat(20_000)}`;
  const out = cursorPrompt(context, "the question", true, WINDOWS_PROMPT_MAX);
  expect(out.length).toBeLessThanOrEqual(WINDOWS_PROMPT_MAX);
  expect(out.endsWith("the question")).toBe(true);
  expect(out.startsWith("a")).toBe(true);
  expect(out).toContain("\n…\n");
});
