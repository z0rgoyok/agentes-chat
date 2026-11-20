import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appLinkFromUrl, ownLinkHref } from "../src/features/links/app-links";
import { isStill, landsOnRoot, STILL_PARAM, stillHref } from "../src/features/links/landing";
import { MAIN, mainLayout, ownOptionsOf, pushedByDefault } from "./main-stack";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );

describe("the app's stack: every screen pushed with its bar and a way back, unless it is listed", () => {
  test("a screen nobody listed comes in with the bar, the back button and the push", () => {
    // It opened with no bar, no back and no slide while every screen had to be declared.
    expect(pushedByDefault("key-for-all/[id]")).toBe(true);
    expect(mainLayout()).toContain("const options = own[route.name] ?? page;");
  });

  test("what the layout lists is a screen that exists, with options of its own", () => {
    const layout = mainLayout();
    const own = layout.slice(layout.indexOf("const own:"), layout.indexOf("return ({ route }"));
    const names = [...own.matchAll(/^ {6}"?([^"\s:]+)"?: /gm)].map((m) => m[1] ?? "");
    expect(names).toContain("(tabs)");
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      const file = name === "(tabs)" ? join(MAIN, "(tabs)", "_layout.tsx") : join(MAIN, `${name}.tsx`);
      expect({ name, exists: existsSync(file) }).toEqual({ name, exists: true });
    }
    // A conversation keeps its opaque bar (its list lays out below it); the tabs keep none of their own.
    expect(ownOptionsOf("chat/[channelId]")).toBe("solid,");
    expect(ownOptionsOf("(tabs)")).toBe("base,");
  });
});

describe("leaving for a tab never stacks a second copy of the tabs", () => {
  test("a tab's root or the sign-in is gone back down to; any other screen takes this one's place", () => {
    for (const href of [
      "/",
      "/threads",
      "/agents",
      "/activity",
      "/search",
      "/sign-in",
      "/activity?x=1",
      { pathname: "/" },
    ])
      expect({ href, root: landsOnRoot(href) }).toEqual({ href, root: true });
    for (const href of ["/chat/c1", "/conversations/threads", "/link?org=o", "/agent/a1", { pathname: "/sign-up" }])
      expect({ href, root: landsOnRoot(href) }).toEqual({ href, root: false });
    const nav = read("src/ui/navigation.tsx");
    expect(nav).toContain("if (landsOnRoot(href)) router.dismissTo(href);");
    expect(nav).toContain("else landOn(fallback);");
  });

  test("the screens that leave for a tab go through it", () => {
    for (const file of [
      "app/(app)/(main)/link.tsx",
      "app/(app)/(main)/handoff/[id].tsx",
      "app/+not-found.tsx",
      "app/connect.tsx",
    ])
      expect({ file, lands: read(file).includes("landOn(") }).toEqual({ file, lands: true });
    for (const file of [
      "app/(app)/(main)/conversations/[kind].tsx",
      "app/(app)/(main)/channel-category.tsx",
      "app/signup.tsx",
    ])
      expect({ file, lands: read(file).includes("<LandOn href=") }).toEqual({ file, lands: true });
    const stacking = files(join(ROOT, "app")).filter((f) =>
      /router\.replace\("\/(threads|agents|activity|search|sign-in)?"\)|<Redirect href="\/(threads|agents|activity|search|sign-in)?"/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(stacking).toEqual([]);
  });
});

describe("the start screen at launch", () => {
  test("opens in place, without the push's slide, and slides back as any pushed screen once it is up", () => {
    expect(stillHref("/chat/c1")).toBe(`/chat/c1?${STILL_PARAM}=1`);
    expect(stillHref("/chat/c1?thread=t1")).toBe("/chat/c1?thread=t1&still=1");
    expect(isStill({ still: "1" })).toBe(true);
    expect(isStill({ still: undefined })).toBe(false);
    expect(isStill(undefined)).toBe(false);
    expect(mainLayout()).toContain('return isStill(route.params) ? { ...options, animation: "none" } : options;');
    expect(read("src/features/me/useStart.ts")).toContain("router.push(stillHref(href) as never)");
    expect(read("app/(app)/(main)/chat/[channelId].tsx")).toContain("useSettleStill(params);");
    expect(read("src/ui/navigation.tsx")).toContain("router.setParams({ [STILL_PARAM]: undefined })");
  });
});

describe("a web link", () => {
  const server = "https://app.agentes.chat";

  test("to the workspace on screen opens its screen straight away; another's, or one to look up, goes through /link", () => {
    const channel = `${server}/org/org-1/c/c-1`;
    expect(appLinkFromUrl(channel, "org-1")).toEqual({ href: "/chat/c-1" });
    expect(appLinkFromUrl(`${server}/org/org-1/agents/a-1`, "org-1")).toEqual({ href: "/agent/a-1" });
    for (const current of ["org-2", null]) {
      const link = appLinkFromUrl(channel, current);
      expect(link && "href" in link ? link.href : "").toStartWith("/link?org=org-1");
    }
    // A thread's conversation is asked of the server first, even in the workspace on screen.
    const thread = appLinkFromUrl(`${server}/org/org-1/threads/t-1`, "org-1");
    expect(thread && "href" in thread ? thread.href : "").toStartWith("/link?");
    expect(ownLinkHref(channel, server, "org-1")).toBe("/chat/c-1");
    expect(read("app/+native-intent.tsx")).toContain("appLinkFromUrl(path, workspaceOnScreen())");
    expect(read("app/(app)/_layout.tsx")).toContain("noteWorkspaceOnScreen(orgId);");
  });

  test("one that waits has the bar's back, and gives up after a while as one that failed", () => {
    const link = read("app/(app)/(main)/link.tsx");
    expect(link).toContain("const LINK_WAIT_MS = 10_000;");
    expect(link).toContain("failedRef.current(new NetworkError(");
    expect(ownOptionsOf("link")).toBe('{ ...solid, animation: "none" },');
  });
});
