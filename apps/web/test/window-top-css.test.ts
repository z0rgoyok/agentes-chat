import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");
const KIT = join(import.meta.dir, "../../../packages/ui/src/styles");
const text = (file: string) => Bun.file(file).text();
const web = async (file: string) => text(join(SRC, file));
const kit = async (file: string) => text(join(KIT, file));
const value = (css: string, selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .map(([, v]) => v);

test("one token for the room the Mac app's window buttons take: 0 in a browser, the title bar's under them", async () => {
  expect(value(topLevel(await kit("layers.css")), ":root", "--window-top")).toEqual(["0px"]);
  const desktop = topLevel(await web("desktop.css"));
  expect(value(desktop, 'html[data-desktop="mac"]:not([data-fullscreen], :fullscreen)', "--window-top")).toEqual([
    "var(--titlebar-h)",
  ]);
  // Full screen hides the buttons: the element the engine put there has the whole screen.
  expect(value(desktop, ":fullscreen", "--window-top")).toEqual(["0px"]);
});

test("a dialog and a details dialog centre in the room under the buttons and never reach behind them", async () => {
  const css = topLevel(await kit("components.css"));
  for (const selector of [".ac-dialog", ".ac-details"]) {
    expect(value(css, selector, "top")).toEqual(["calc(50% + var(--window-top) / 2)"]);
    expect(value(css, selector, "max-height")).toEqual([
      "calc(100vh - 48px - var(--window-top))",
      "calc(100dvh - 48px - var(--window-top))",
    ]);
  }
  expect(value(css, ".ac-details--fill", "height")).toEqual([
    "calc(100vh - 48px - var(--window-top))",
    "calc(100dvh - 48px - var(--window-top))",
  ]);
  // A window narrow enough for the phone's sheets (zoomed in with ⌘+): their heads start under the buttons too.
  const phone = atRule(await kit("components.css"), "@media (max-width: 640px)");
  expect(value(phone, ".ac-details", "padding-top")).toEqual([
    "calc(env(safe-area-inset-top, 0px) + var(--window-top))",
  ]);
  expect(value(phone, ".ac-dialog", "max-height").at(-1)).toBe(
    "calc(100dvh - 12px - env(safe-area-inset-top, 0px) - var(--window-top))",
  );
});

test("the file viewer near the window's edges starts under the buttons, not with its head behind them", async () => {
  const wide = atRule(await web("layout.css"), "@media (min-width: 641px)");
  expect(value(wide, ".ac-details.artifact-sheet--image", "height")).toEqual([
    "calc(100vh - 32px - var(--window-top))",
    "calc(100dvh - 32px - var(--window-top))",
  ]);
});

test("every overlay that reaches the window's top starts under the buttons", async () => {
  const at = async (file: string, selector: string, property: string, media?: string) => {
    const css = await web(file);
    return value(media ? atRule(css, media) : topLevel(css), selector, property);
  };
  expect(await at("components/browser/browser.css", ".brw-ac.is-full", "inset")).toEqual(["var(--window-top) 0 0"]);
  expect(await at("components/code/code.css", ".code-sstage.is-full", "inset")).toEqual(["var(--window-top) 0 0"]);
  expect(await at("components/live/slides/slides.css", ".sl-present", "inset")).toEqual(["var(--window-top) 0 0"]);
  expect(await at("components/members/members.css", ".members-sheet", "top")).toEqual(["var(--window-top)"]);
  expect(await at("components/threads/threads.css", ".thread-panel", "top")).toEqual([
    "calc(10px + var(--window-top))",
  ]);
  expect(await at("components/threads/threads.css", ".thread-panel", "inset", "@media (max-width: 860px)")).toEqual([
    "var(--window-top) 0 0",
  ]);
  expect(await at("pages/wiki.css", ".wiki-nav", "top", "@media (max-width: 900px)")).toEqual(["var(--window-top)"]);
  expect(await at("components/channel-header.css", ".search-sheet", "inset", "@media (max-width: 760px)")).toEqual([
    "var(--window-top) 0 0",
  ]);
});

test("in the app, the sidebar's workspace header and the work's sheet start on one line under the title bar", async () => {
  const wide = atRule(await web("desktop.css"), "@media (min-width: 761px)");
  const top = (selector: string) => value(wide, selector, "padding-top");
  expect(top("html[data-desktop] .shell__work")).toEqual(["0"]);
  // The same on every system: Windows and Linux draw the app's bar too, under their own.
  expect(top("html[data-desktop] .shell .sidebar")).toEqual(top("html[data-desktop] .shell__work"));
  expect(top("html[data-desktop] .shell .sidebar :is(.sidebar__col, .sidebar__main)")).toEqual(["0"]);
});
