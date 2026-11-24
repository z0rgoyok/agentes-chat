import { describe, expect, test } from "bun:test";
import {
  agentFolderOf,
  codeBranchName,
  codeSessionOf,
  codeWorktreePath,
  isLocalSession,
  localProjectName,
  shellQuote,
  splitPatch,
  titleOfRequest,
} from "../src/code-sessions";
import { branchSlug } from "../src/mission-worktree";

// Code sessions (ADR 0215): the pure pieces (names, the branch, the diff's split).

describe("titleOfRequest", () => {
  test("the first sentence of the first line, capitalized, without its period", () => {
    expect(titleOfRequest("a linha do frete não some. arruma e cobre com teste")).toBe("A linha do frete não some");
  });
  test("skips blank lines and keeps a line with no period whole", () => {
    expect(titleOfRequest("\n\n  fix the flaky cart test  \nmore words")).toBe("Fix the flaky cart test");
  });
  test("cuts a long line at a word, with an ellipsis", () => {
    const title = titleOfRequest(`${"word ".repeat(30)}end`);
    expect(title.length).toBeLessThanOrEqual(73);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
  });
  test("nothing to name falls back", () => {
    expect(titleOfRequest("   ")).toBe("Code session");
  });
});

describe("codeBranchName and codeWorktreePath", () => {
  const id = "0193f1a2-7b3c-7d4e-8f90-1a2b3c4d5e6f";
  test("under the agent's own prefix, with the title's slug and a short tail", () => {
    expect(codeBranchName("atlas", "Linha do frete com cupom", id)).toBe("agentes/atlas/linha-do-frete-com-cupom-5e6f");
  });
  test("a title with nothing to slug still names a branch", () => {
    expect(codeBranchName("atlas", "!!!", id)).toBe("agentes/atlas/work-5e6f");
  });
  test("the worktree folder is per session", () => {
    expect(codeWorktreePath(id)).toBe(".worktrees/c-3c4d5e6f");
  });
});

describe("codeSessionOf", () => {
  test("reads the root's meta", () => {
    expect(codeSessionOf({ codeSession: { sessionId: "s", repo: "acme/web", title: "T" } })).toEqual({
      sessionId: "s",
      repo: "acme/web",
      title: "T",
    });
  });
  test("anything else is not a session's root", () => {
    expect(codeSessionOf({ taskConversation: { issueId: "i" } })).toBeNull();
    expect(codeSessionOf(null)).toBeNull();
  });
});

describe("splitPatch", () => {
  const diff = [
    "diff --git a/src/cart/free.ts b/src/cart/free.ts",
    "index 1111111..2222222 100644",
    "--- a/src/cart/free.ts",
    "+++ b/src/cart/free.ts",
    "@@ -1,3 +1,4 @@",
    " keep",
    "-old",
    "+new",
    "+added",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  test("one patch per file, with its counts (headers not counted)", () => {
    const files = splitPatch(diff);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["src/cart/free.ts", 2, 1],
      ["README.md", 1, 1],
    ]);
    expect(files[0]?.patch.startsWith("diff --git a/src/cart/free.ts")).toBe(true);
  });
  test("an empty diff has no files", () => {
    expect(splitPatch("")).toEqual([]);
  });
});

describe("shellQuote", () => {
  test("single quotes, a quote inside escaped", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("agentFolderOf", () => {
  test("the agent's folder as the runner names it: its handle, then the first 8 of its id", () => {
    expect(agentFolderOf({ id: "9A9BD9B2-7b3c-7d4e-8f90-1a2b3c4d5e6f", handle: "Leo.Dev" })).toBe("leo-dev-9a9bd9b2");
    expect(agentFolderOf({ id: "0193f1a2-7b3c-7d4e-8f90-1a2b3c4d5e6f", handle: "--" })).toBe("agent-0193f1a2");
  });
});

describe("local projects", () => {
  test("a folder-like name is a local project's, anything else isn't", () => {
    expect(localProjectName("hello-world")).toBe("hello-world");
    expect(localProjectName(" site_v2.1/ ")).toBe("site_v2.1");
    expect(localProjectName(".hidden")).toBeNull();
    expect(localProjectName("a b")).toBeNull();
    expect(localProjectName("acme/web")).toBeNull();
  });
  test("a session on a local project has no owner in its repo", () => {
    expect(isLocalSession({ repo: "hello-world" })).toBe(true);
    expect(isLocalSession({ repo: "acme/web" })).toBe(false);
  });
});

// Names and paths are read by index, not by patterns that read a long run again from each of its characters: the same
// answers as those patterns (kept here, run only on short inputs), and long runs read at once.
describe("read by index, as the patterns they replace", () => {
  const byPattern = {
    path: (chunk: string) => {
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
      return header?.[2] ?? header?.[1] ?? "?";
    },
    title: (line: string) => (/^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line).replace(/[.!?]+$/, "").trim(),
    folder: (handle: string) =>
      handle
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[-_.]+|[-_.]+$/g, "")
        .slice(0, 40),
    project: (input: string) => input.trim().replace(/\/+$/, ""),
    slug: (title: string) =>
      title
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, ""),
  };
  const ID = "0193f1a2-7b3c-7d4e-8f90-1a2b3c4d5e6f";

  test("a patch's path, from its first line", () => {
    for (const first of [
      "diff --git a/src/a.ts b/src/a.ts",
      "diff --git a/old name b/x.ts b/new name b/x.ts",
      "diff --git a/a b/a b/a b/a",
      "diff --git a/x  b/y",
      "diff --git a/a b/",
      "diff --git a/ b/x",
      "diff --git a/x b/y\r",
      "diff --git a/x\rb/y b/z",
      'diff --git "a/q x" "b/q x"',
    ]) {
      const chunk = `${first}\n--- a/x\n+++ b/y\n+line`;
      expect(splitPatch(chunk)[0]?.path).toBe(byPattern.path(chunk));
    }
  });

  test("a title without its trailing stops", () => {
    for (const line of ["Fix it.", "Fix it!!", "Why?!", "...", "a. b", "Ship v1.2", "Done…", "Wait!? Now", "!"]) {
      const title = titleOfRequest(line);
      const expected = byPattern.title(line);
      expect(title).toBe(expected ? expected.charAt(0).toLocaleUpperCase() + expected.slice(1) : "Code session");
    }
  });

  test("a folder, a project and a branch from people's words", () => {
    for (const handle of ["Leo.Dev", "--", "_a_", ".x.", "-a-b-", "a", "...", "x__", "Ünï-cödé"])
      expect(agentFolderOf({ id: ID, handle })).toBe(`${byPattern.folder(handle) || "agent"}-0193f1a2`);
    for (const input of ["site/", "site///", "/", " a/b/ ", "a//b", ""])
      expect(localProjectName(input)).toBe(
        /^(?!\.)[A-Za-z0-9._-]{1,64}$/.test(byPattern.project(input)) ? byPattern.project(input) : null,
      );
    for (const title of ["Fix the cart", "--fix--", "Ação rápida!", `${"a".repeat(39)}-b`, "x".repeat(60), "?!"])
      expect(branchSlug(title)).toBe(byPattern.slug(title));
  });

  test("long runs are read at once", () => {
    const run = (c: string) => c.repeat(200_000);
    expect(splitPatch(`diff --git a/${"a b/".repeat(50_000)}\n`)[0]?.path).toBe("a b/".repeat(49_999));
    expect(titleOfRequest(`${run("!")}x`)).toBe(`${"!".repeat(72)}…`);
    expect(agentFolderOf({ id: ID, handle: `${run("-")}x` })).toBe("x-0193f1a2");
    expect(localProjectName(`${run("/")}x`)).toBeNull();
    expect(branchSlug(`${run("-")}x`)).toBe("x");
  });
});
