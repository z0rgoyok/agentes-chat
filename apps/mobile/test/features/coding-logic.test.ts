import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeSession } from "@agenteschat/client";
import {
  folderEntries,
  isLocalRepo,
  sessionChatHref,
  sessionDiffHref,
  sessionFileHref,
  sessionFolderHref,
  sessionStateKey,
  sessionsByRepo,
  shortBranch,
  splitPath,
  statWords,
} from "../../src/features/coding/logic";
import { MAIN, mainLayout } from "../main-stack";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");
const route = (path: string) => readFileSync(join(MAIN, path), "utf8");

const session = (over: Partial<CodeSession> = {}): CodeSession => ({
  id: "s1",
  channelId: "c1",
  rootId: "r1",
  title: "Free shipping in the cart",
  repo: "acme/shop",
  branch: "agent/free-shipping",
  baseBranch: "main",
  agentId: "a1",
  machineId: "m1",
  worktree: { state: "ready", error: null, errorCode: null },
  local: false,
  pr: null,
  stat: { files: 3, added: 52, removed: 10, at: "2026-11-20T10:00:00Z" },
  work: "idle",
  createdBy: "u1",
  createdAt: "2026-11-20T09:00:00Z",
  lastAt: "2026-11-20T10:00:00Z",
  ...over,
});

describe("Code's list", () => {
  test("sessions group by project, the project of the newest first, each newest first", () => {
    const groups = sessionsByRepo([
      session({ id: "old", repo: "acme/shop", lastAt: "2026-11-18T10:00:00Z" }),
      session({ id: "api", repo: "acme/api", lastAt: "2026-11-20T11:00:00Z" }),
      session({ id: "new", repo: "acme/shop", lastAt: "2026-11-19T10:00:00Z" }),
      session({ id: "notes", repo: "notes", local: true, lastAt: "2026-11-17T10:00:00Z" }),
    ]);
    expect(groups.map((g) => [g.repo, g.local, g.sessions.map((s) => s.id)])).toEqual([
      ["acme/api", false, ["api"]],
      ["acme/shop", false, ["new", "old"]],
      ["notes", true, ["notes"]],
    ]);
  });

  test("a state in words: an open pull request when idle, waiting on you in the waiting color", () => {
    expect(sessionStateKey(session({ work: "idle", pr: { number: 12, url: null } }))).toEqual({
      key: "codeSessions.state.pr",
      pr: 12,
      waiting: false,
    });
    expect(sessionStateKey(session({ work: "working", pr: { number: 12, url: null } })).key).toBe(
      "codeSessions.state.working",
    );
    expect(sessionStateKey(session({ work: "waiting" }))).toEqual({
      key: "codeSessions.state.waiting",
      pr: null,
      waiting: true,
    });
  });

  test("the change's size only once read and when something changed", () => {
    expect(statWords(session())).toBe("+52 −10");
    expect(statWords(session({ stat: { files: 0, added: 0, removed: 0, at: "2026-11-20T10:00:00Z" } }))).toBeNull();
    expect(statWords(session({ stat: { files: 3, added: 52, removed: 10, at: null } }))).toBeNull();
  });

  test("a project only on the computer is a name with no owner", () => {
    expect(isLocalRepo("notes")).toBe(true);
    expect(isLocalRepo("acme/shop")).toBe(false);
    expect(isLocalRepo("")).toBe(false);
  });

  test("what waits on me leads the list, then the rest by project; working rows tell this session's work only", () => {
    const screen = src("features/coding/CodingScreen.tsx");
    expect(screen).toContain('.filter((s) => s.work === "waiting")');
    expect(screen).toContain('sessionsByRepo(list.filter((s) => s.work !== "waiting"))');
    expect(screen).toContain("shown?.work?.channelId === session.channelId");
    // Loading is the rows' shape, a list that failed says so, an empty one is the place's first use.
    expect(screen).toContain("<SkeletonList");
    expect(screen).toContain("<LoadFailed");
    expect(screen).toContain('<FirstUse place="coding"');
  });
});

describe("a session's screens", () => {
  test("its conversation is its thread; its folders, files and diffs carry their paths encoded", () => {
    expect(sessionChatHref(session())).toBe("/chat/c1?thread=r1");
    expect(sessionFolderHref("s1", "src/app")).toBe("/coding/s1/files?dir=src%2Fapp");
    expect(sessionFileHref("s1", "src/a b.ts")).toBe("/coding/s1/file?path=src%2Fa%20b.ts");
    expect(sessionDiffHref("s1", { scope: "base" })).toBe("/coding/s1/diff?scope=base");
    expect(sessionDiffHref("s1", { scope: "uncommitted", path: "src/cart.ts" })).toBe(
      "/coding/s1/diff?scope=uncommitted&path=src%2Fcart.ts",
    );
    expect(sessionDiffHref("s1", { scope: "commit", sha: "a1b2c3d" })).toBe("/coding/s1/diff?scope=commit&sha=a1b2c3d");
  });

  test("the pill says the branch without its agent's prefix, which the session already names", () => {
    expect(shortBranch("agentes/atlas/free-shipping-3f9a")).toBe("free-shipping-3f9a");
    expect(shortBranch("feature/cart")).toBe("feature/cart");
    expect(shortBranch("main")).toBe("main");
  });

  test("a path reads as its name, then its folder", () => {
    expect(splitPath("src/cart/total.ts")).toEqual({ name: "total.ts", dir: "src/cart" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });

  test("a folder lists its folders once, with how many files they hold, then its files, by name", () => {
    const paths = ["src/b.ts", "src/A.ts", "src/lib/x.ts", "src/lib/y/z.ts", "README.md", "docs/a.md"];
    expect(folderEntries(paths, "")).toEqual({
      folders: [
        { name: "docs", path: "docs", count: 1 },
        { name: "src", path: "src", count: 4 },
      ],
      files: ["README.md"],
    });
    expect(folderEntries(paths, "src")).toEqual({
      folders: [{ name: "lib", path: "src/lib", count: 2 }],
      files: ["src/A.ts", "src/b.ts"],
    });
  });

  test("every screen of a session lands back on Code when its address is wrong, never on a blank screen", () => {
    for (const file of ["index.tsx", "files.tsx", "file.tsx", "diff.tsx", "people.tsx", "terminal.tsx"])
      expect(route(`coding/[sessionId]/${file}`)).toContain('<LandOn href="/coding" />');
    // A commit's diff needs a commit's hash.
    expect(route("coding/[sessionId]/diff.tsx")).toContain("/^[0-9a-f]{7,40}$/i");
  });

  test("Code's grouped screens are pushed on the grouped gray, as the steps of creating an agent", () => {
    const layout = mainLayout();
    for (const name of ["coding/index", "coding/new", "coding/where", "coding/[sessionId]/index"])
      expect(layout).toContain(`"${name}"`);
    expect(layout).toContain("...Object.fromEntries(CODING_GROUPED_ROUTES.map((name) => [name, connectAi]))");
  });

  test("Eu offers Code only where it has anything for me, as the web's sidebar (ADR 0215 §12)", () => {
    expect(src("features/me/MeScreen.tsx")).toContain("code: overview?.code ? (");
  });
});

describe("a session suggested in the chat (ADR 0215 §11)", () => {
  test("the agent's reply carries the card; a session opened from it leads back to where it came from", () => {
    expect(src("features/chat/MessageRow.tsx")).toContain(
      "{suggestion ? <CodeSuggestionCard message={m} suggestion={suggestion} /> : null}",
    );
    expect(src("features/chat/screen/useChatRows.ts")).toContain(
      '? [{ kind: "codeOrigin", key: "code-origin", sessionId: code.sessionId }]',
    );
    expect(src("features/chat/screen/ChatList.tsx")).toContain("return <CodeOrigin sessionId={item.sessionId} />;");
    // Only the person who asked decides: anyone else reads who it waits for.
    const card = src("features/coding/SuggestionCard.tsx");
    expect(card).toContain("suggestion.askerId === meId");
    expect(card).toContain('waitsFor={t("ask.waitingFor", { name: asker })}');
  });
});

describe("the session's conversation", () => {
  test("its root is never shown; its pill opens its code, its bar holds its agent's computer and its menu", () => {
    expect(src("features/chat/screen/useChatRows.ts")).toContain(
      "root && !taskConversationOf(root.meta) && !codeSessionOf(root.meta)",
    );
    const header = src("features/chat/screen/ChatHeader.tsx");
    expect(header).toContain("onPress={codeId ? pressCode : pressOptions}");
    expect(header).toContain('icon={codeId ? "code" : "reply"}');
    // One button besides "…" at most (its agent's computer): with two, a 393-point phone left the pill a few letters.
    expect(header).toContain("const threadExtra = channelExtra + (codeComputer ? 1 : 0);");
    expect(header).toContain("codeMore ?? {");
    // Its agent's live run says "working" at once (the session is read every 15 s).
    expect(header).toContain('codeBusy ? { ...codeSession, work: "working" } : codeSession');
  });

  test("the phone hears a session's changes (its worktree, name, pull request), as the web does", () => {
    expect(src("features/shared/userEvents.ts")).toContain("applyCodeSessionEvent(qc, orgId, event);");
  });
});
