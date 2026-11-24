import { describe, expect, test } from "bun:test";
import { CLI_OUTPUT_MAX, changedLines, cliToolShown, cliToolStep, cliToolSummary, workingPath } from "../src/cli-tools";

/**
 * A computer brain's own tool calls in a code session (ADR 0215), one line each as its terminal shows them: the verb,
 * what it worked on and what it came to, from the call as the runner forwards it.
 */

const WORKTREE = ".worktrees/c-1a2b3c4d";
const IN_WORKTREE = `/Users/w/agentes/dev/${WORKTREE}`;
const FILE = `${IN_WORKTREE}/src/app/router.ts`;

describe("Claude Code's own tools", () => {
  test("a read names its file as the worktree reads it", () => {
    const read = cliToolSummary("Read", { file_path: FILE }, { content: "1\tok" }, WORKTREE);
    expect(read).toEqual({ verb: "read", target: "src/app/router.ts" });
  });

  test("a search names its pattern and how many places it found", () => {
    const grep = cliToolSummary("Grep", { pattern: "parseRoute" }, { content: "Found 3 files\na.ts\nb.ts\nc.ts" });
    expect(grep).toEqual({ verb: "search", target: "parseRoute", meta: { found: 3 } });
    const none = cliToolSummary("Grep", { pattern: "nope" }, { content: "No files found" });
    expect(none.meta).toEqual({ found: 0 });
    const counted = "a.ts:2\n\nFound 2 total occurrences across 1 file.";
    const occurrences = cliToolSummary("Grep", { pattern: "x", output_mode: "count" }, { content: counted });
    expect(occurrences.meta).toEqual({ found: 2 });
    // Glob's answer is its files; a list it cut is never counted.
    expect(cliToolSummary("Glob", { pattern: "**/*.ts" }, { content: "a.ts\nb.ts" }).meta).toEqual({ found: 2 });
    const cut = "a.ts\n(Results are truncated. Consider using a more specific path or pattern.)";
    expect(cliToolSummary("Glob", { pattern: "**/*" }, { content: cut }).meta).toBeUndefined();
  });

  test("an edit counts the lines it added and removed, and opens on them", () => {
    const input = {
      file_path: FILE,
      old_string: "const min = 100;\nreturn total >= min;",
      new_string: "const min = 150;\nconst hint = min - total;\nreturn total >= min;",
    };
    const result = { content: "The file has been updated successfully." };
    expect(cliToolSummary("Edit", input, result, WORKTREE)).toEqual({
      verb: "edit",
      target: "src/app/router.ts",
      meta: { added: 2, removed: 1 },
    });
    // The line both sides share stays out of what it opens on.
    const step = cliToolStep({ id: "e1", name: "Edit", input, result }, { cwd: WORKTREE });
    expect(step.output).toBe("- const min = 100;\n+ const min = 150;\n+ const hint = min - total;");
  });

  test("several edits of one file add up; a failed one has no count", () => {
    const input = {
      file_path: "src/a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "c\nd" },
      ],
    };
    expect(cliToolSummary("MultiEdit", input, { content: "ok" }).meta).toEqual({ added: 2, removed: 1 });
    const failed = cliToolSummary("MultiEdit", input, { content: "String not found", isError: true });
    expect(failed.meta).toBeUndefined();
  });

  test("a write counts its file's lines", () => {
    const input = { file_path: "notes.md", content: "# Notes\n\nOne\nTwo\n" };
    expect(cliToolSummary("Write", input, { content: "ok" })).toEqual({
      verb: "write",
      target: "notes.md",
      meta: { added: 4 },
    });
  });

  test("a write the runner cut still names its file", () => {
    const cut = { truncated: '{"file_path":"/Users/w/agentes/dev/src/big.ts","content":"export const a = 1;\\nexport' };
    expect(cliToolSummary("Write", cut, { content: "ok" })).toEqual({ verb: "write", target: "…/dev/src/big.ts" });
  });

  test("a command is its first line; a test run says how many passed", () => {
    const tests = "bun test v1.3.0\n\n 15 pass\n 0 fail\n 30 expect() calls\nRan 15 tests across 1 file. [80.00ms]";
    const input = { command: "bun test router", description: "Run the router tests" };
    expect(cliToolSummary("Bash", input, { content: tests })).toEqual({
      verb: "run",
      target: "bun test router",
      meta: { passed: 15, failed: 0 },
    });
    const heredoc = cliToolSummary("Bash", { command: "cat <<'EOF' > a.txt\nhello\nEOF" }, { content: "" });
    expect(heredoc).toEqual({ verb: "run", target: "cat <<'EOF' > a.txt …" });
  });

  test("a failed command says its exit code", () => {
    const failed = { content: "Exit code 2\nerror TS2304", isError: true };
    expect(cliToolSummary("Bash", { command: "npm run build" }, failed)).toEqual({
      verb: "run",
      target: "npm run build",
      meta: { exit: 2 },
    });
    // A count in an ordinary command's output is no test run.
    expect(cliToolSummary("Bash", { command: "ls" }, { content: "3 passed.txt" }).meta).toBeUndefined();
  });

  test("a fetch names its address, a web search its words", () => {
    const fetch = cliToolSummary("WebFetch", { url: "https://docs.example.com/api", prompt: "x" });
    expect(fetch).toEqual({ verb: "fetch", target: "https://docs.example.com/api" });
    const search = cliToolSummary("WebSearch", { query: "route matching order" });
    expect(search).toEqual({ verb: "search", target: "route matching order" });
  });

  test("a tool with no verb of its own says its name and what for", () => {
    // A subagent, by either of its names, says what it was asked; a skill names itself (ADR 0215).
    const task = cliToolSummary("Task", { description: "Explore the router", prompt: "Look at…" });
    expect(task).toEqual({ verb: "delegate", about: "Explore the router" });
    expect(cliToolSummary("Agent", { prompt: "Review the HTML\nthen say" })).toEqual({
      verb: "delegate",
      about: "Review the HTML",
    });
    expect(cliToolSummary("Skill", { skill: "release" })).toEqual({ verb: "skill", target: "release" });
    // A workflow says what it does: its name, else its script's meta.
    expect(cliToolSummary("Workflow", { name: "review-changes" })).toEqual({
      verb: "workflow",
      about: "review-changes",
    });
    const script = "export const meta = {\n  name: 'review',\n  description: 'Review every page, then verify',\n}";
    expect(cliToolSummary("Workflow", { script })).toEqual({
      verb: "workflow",
      about: "Review every page, then verify",
    });
    expect(cliToolSummary("Workflow", { scriptPath: "flows/audit.js" })).toEqual({
      verb: "workflow",
      about: "flows/audit.js",
    });
    const todos = [
      { content: "Read the router", status: "completed", activeForm: "Reading the router" },
      { content: "Run the tests", status: "in_progress", activeForm: "Running the tests" },
    ];
    const plan = cliToolSummary("TodoWrite", { todos });
    expect(plan).toEqual({ verb: "other", target: "TodoWrite", about: "Running the tests" });
    const mcp = cliToolSummary("mcp__github__create_issue", { title: "x" });
    expect(mcp).toEqual({ verb: "other", target: "github.create_issue" });
  });

  test("looking our deferred tools up and the computer's permission check are no lines", () => {
    expect(cliToolShown("ToolSearch")).toBe(false);
    expect(cliToolShown("permission_prompt")).toBe(false);
    expect(cliToolShown("Read")).toBe(true);
  });
});

describe("Codex's own tools", () => {
  test("a command it ran", () => {
    const ran = cliToolSummary("shell", { command: "go test ./..." }, { content: "ok  shop/router 0.2s" });
    expect(ran).toEqual({ verb: "run", target: "go test ./..." });
    const failed = cliToolSummary("shell", { command: "false" }, { content: "", isError: true });
    expect(failed).toEqual({ verb: "run", target: "false" });
  });

  test("files it changed: added ones are a write, more than one says how many", () => {
    const added = { changes: [{ path: "src/new.ts", kind: "add" }] };
    expect(cliToolSummary("file_change", added, { content: "ok" })).toEqual({ verb: "write", target: "src/new.ts" });
    const both = {
      changes: [
        { path: "src/a.ts", kind: "update" },
        { path: "src/b.ts", kind: "add" },
      ],
    };
    const changed = cliToolSummary("file_change", both, { content: "Changed src/a.ts (update), src/b.ts (add)" });
    expect(changed).toEqual({ verb: "edit", target: "src/a.ts", meta: { files: 2 } });
  });
});

describe("its step", () => {
  test("keeps how it went, how long and the start of what it gave back, masked and cut", () => {
    const command = "curl -H 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123' https://api.example.com";
    const result = { content: "x".repeat(CLI_OUTPUT_MAX * 2), isError: true };
    const step = cliToolStep({ id: "t1", name: "Bash", input: { command }, result }, { ms: 1234.4 });
    expect(step).toMatchObject({ id: "t1", name: "Bash", verb: "run", ok: false, ms: 1234 });
    expect(step.target).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    expect(step.output?.length).toBe(CLI_OUTPUT_MAX);
    expect(step.output?.endsWith("…")).toBe(true);
  });

  test("a call whose work went on in the background keeps its line and time, not its words for the model", () => {
    const result = { content: "Workflow launched in background. Run ID: wf_1. To resume after editing the script: …" };
    const step = cliToolStep(
      { id: "w1", name: "Workflow", input: { description: "Três agentes" }, result },
      { ms: 7800, background: true },
    );
    expect(step).toMatchObject({ id: "w1", verb: "workflow", ok: true, ms: 7800 });
    expect(step.output).toBeUndefined();
  });

  test("leaves out the notes Claude Code adds for the model", () => {
    const content = "     1\tconst a = 1;\n<system-reminder>Whenever you read a file…</system-reminder>";
    const step = cliToolStep({ id: "r1", name: "Read", input: { file_path: "a.ts" }, result: { content } });
    expect(step.output).toBe("     1\tconst a = 1;");
    expect(step.ms).toBeUndefined();
  });
});

describe("its paths", () => {
  test("relative to the folder it works in, else only their last parts", () => {
    expect(workingPath(`${IN_WORKTREE}/src/a.ts`, WORKTREE)).toBe("src/a.ts");
    expect(workingPath(IN_WORKTREE, WORKTREE)).toBe(".");
    expect(workingPath("./src/a.ts")).toBe("src/a.ts");
    expect(workingPath("src/a.ts", WORKTREE)).toBe("src/a.ts");
    expect(workingPath("/home/ada/projects/shop/src/a.ts")).toBe("…/shop/src/a.ts");
    expect(workingPath("/tmp/a.ts")).toBe("/tmp/a.ts");
  });

  test("lines an edit changed, by content", () => {
    expect(changedLines("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
    expect(changedLines("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
    expect(changedLines("a\nb", "a")).toEqual({ added: 0, removed: 1 });
  });
});
