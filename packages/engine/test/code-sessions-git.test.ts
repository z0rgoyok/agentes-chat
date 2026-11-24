import { describe, expect, test } from "bun:test";
import { codeFilePathOk, parseLog, parseNumstatZ, parseStatus } from "../src/code-sessions";

// The Git and Files tabs of a code session (ADR 0215): git's own output read as the panel shows it.

describe("parseStatus", () => {
  test("each kind of change, a rename with where it came from (`-z` puts it after)", () => {
    const out = [
      " M src/a.ts",
      "A  src/new.ts",
      " D gone.md",
      "R  to.ts",
      "from.ts",
      "?? fresh dir/x.txt",
      "MM both.ts",
      "",
    ].join("\0");
    expect(parseStatus(out)).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/new.ts", status: "added" },
      { path: "gone.md", status: "deleted" },
      { path: "to.ts", from: "from.ts", status: "renamed" },
      { path: "fresh dir/x.txt", status: "untracked" },
      { path: "both.ts", status: "modified" },
    ]);
  });
  test("nothing changed", () => {
    expect(parseStatus("")).toEqual([]);
  });
});

describe("parseNumstatZ", () => {
  test("counts by path; a rename's under its new path; a binary file's null", () => {
    const out = ["3\t1\tsrc/a.ts", "-\t-\tlogo.png", "2\t0\t", "old.ts", "new.ts", ""].join("\0");
    const counts = parseNumstatZ(out);
    expect(counts.get("src/a.ts")).toEqual({ added: 3, removed: 1 });
    expect(counts.get("logo.png")).toEqual({ added: null, removed: null });
    expect(counts.get("new.ts")).toEqual({ added: 2, removed: 0 });
    expect(counts.has("old.ts")).toBe(false);
  });
});

describe("parseLog", () => {
  const sha = (c: string) => c.repeat(40);
  test("one commit per record, with its files and lines (binary files count as files, not lines)", () => {
    const out =
      `\x1e${sha("a")}\x1faaaaaaa\x1fAtlas\x1f2026-11-20T10:00:00-03:00\x1fFix the cart\n\n3\t1\tsrc/cart.ts\n-\t-\timg.png\n` +
      `\x1e${sha("b")}\x1fbbbbbbb\x1fAtlas\x1f2026-11-20T09:00:00-03:00\x1fStart\n\n10\t0\tREADME.md\n`;
    expect(parseLog(out)).toEqual([
      {
        sha: sha("a"),
        short: "aaaaaaa",
        subject: "Fix the cart",
        author: "Atlas",
        at: "2026-11-20T10:00:00-03:00",
        files: 2,
        added: 3,
        removed: 1,
      },
      {
        sha: sha("b"),
        short: "bbbbbbb",
        subject: "Start",
        author: "Atlas",
        at: "2026-11-20T09:00:00-03:00",
        files: 1,
        added: 10,
        removed: 0,
      },
    ]);
  });
  test("anything that isn't a commit's record is left out", () => {
    expect(parseLog("fatal: bad revision")).toEqual([]);
  });
});

describe("codeFilePathOk", () => {
  test("a path inside the worktree", () => {
    expect(codeFilePathOk("src/app/page.tsx")).toBe(true);
    expect(codeFilePathOk("README.md")).toBe(true);
    expect(codeFilePathOk("docs/a b.md")).toBe(true);
  });
  test("never out of it, into git's own folder, or odd", () => {
    for (const bad of [
      "",
      "/etc/passwd",
      "../x",
      "a/../../x",
      "a//b",
      "./a",
      ".git/config",
      "a/.git/HEAD",
      "a\\b",
      "a\0b",
    ])
      expect(codeFilePathOk(bad)).toBe(false);
  });
});
