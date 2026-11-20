import { expect, test } from "bun:test";
import path from "node:path";
import { declarations, rules, topLevel } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const KIT = "packages/ui/src/styles/components.css";
const read = (file: string) => Bun.file(path.join(ROOT, file)).text();
const sheets = async () => {
  const files = [KIT, ...new Bun.Glob("apps/web/src/**/*.css").scanSync({ cwd: ROOT })];
  return Promise.all(files.map(async (file) => ({ file, css: await read(file) })));
};
const last = (css: string, selector: string, property: string) =>
  declarations(topLevel(css), selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

/**
 * The roots of floating layers: the kit's, and the app's own popovers and menus built on them. Not here: the time list
 * and the emoji picker, catalogs no window holds whole, which keep one height so a person's place in them stays put.
 */
const LAYERS = [
  ".ac-popover",
  ".ac-menu--dropdown",
  ".ac-menu--select",
  ".ac-date",
  ".ac-suggest",
  ".ac-tz__menu",
  ".ac-filter__menu",
  ".wiki-folders-pop",
  ".wiki-suggest--float",
  ".agora",
  ".mp",
  ".agp-changes",
  ".mcard",
  ".mcard-audience",
  ".cal-more",
  ".profile-card",
  ".sidebar__more-menu",
  ".thread-pop",
];
/** The selector's own element (its last compound) is a layer's root. */
const isLayer = (selector: string) => {
  const own = selector.split(/[\s>+~]/).at(-1) ?? "";
  return LAYERS.some((c) => new RegExp(`${c.replace(".", "\\.")}(?![\\w-])`).test(own));
};

test("a kit layer is as tall as the window lets it on its side: Radix's room there, no fixed cap and no fallback", async () => {
  const css = await read(KIT);
  // No fallback: until Radix first places it the cap is none, so its flip measures the whole card, not a cut one.
  expect(last(css, ".ac-popover", "max-height")).toBe("var(--radix-popover-content-available-height)");
  expect(last(css, ".ac-date", "max-height")).toBe("var(--radix-popover-content-available-height)");
  expect(last(css, ".ac-menu--dropdown", "max-height")).toBe("var(--radix-dropdown-menu-content-available-height)");
  expect(last(css, ".ac-menu--select", "max-height")).toBe("var(--radix-select-content-available-height)");
  expect(last(css, ".ac-suggest", "max-height")).toBe("var(--radix-popover-content-available-height)");
  expect(last(css, ".ac-tz__menu.ac-menu", "max-height")).toBe("var(--radix-popover-content-available-height)");
  expect(last(css, ".ac-filter__menu.ac-menu", "max-height")).toBe("var(--radix-popover-content-available-height)");
});

test("no popover or menu caps its own height under the window's room, nor lifts the cap off it", async () => {
  const wrong: string[] = [];
  for (const { file, css } of await sheets())
    for (const r of rules(css))
      for (const [p, v] of r.declarations)
        if (p === "max-height" && r.selectors.some(isLayer) && !/^var\(--radix-[a-z-]+-available-height\)$/.test(v))
          wrong.push(`${file}: ${r.selectors.join(", ")} { max-height: ${v} }`);
  expect(wrong).toEqual([]);
});

test("a popover's list under a head gives way to the window's room and scrolls there, the head kept", async () => {
  const lists = [
    ["apps/web/src/components/threads/threads.css", ".thread-pop__list"],
    ["apps/web/src/pages/wiki.css", ".wiki-folders-pop__list"],
    [KIT, ".ac-tz__list"],
    [KIT, ".ac-filter__list"],
  ] as const;
  for (const [file, list] of lists) {
    const css = await read(file);
    expect([list, last(css, list, "max-height")]).toEqual([list, undefined]);
    expect([list, last(css, list, "min-height")]).toEqual([list, "0"]);
    expect([list, last(css, list, "overflow-y")]).toEqual([list, "auto"]);
  }
  const kit = await read(KIT);
  for (const r of rules(kit))
    if (r.selectors.some((s) => /\.ac-tz__list(?![\w-])/.test(s)))
      expect(r.declarations.filter(([p]) => p === "max-height")).toEqual([]);
});

test("a list in a dialog's body has no box of its own: the body scrolls it, only when the window can't hold it", async () => {
  const kit = await read(KIT);
  expect(last(kit, ".ac-dialog__body", "overflow-y")).toBe("auto");
  expect(last(kit, ".ac-dialog__body", "min-height")).toBe("0");
  const css = await read("apps/web/src/components/arrival/arrival.css");
  for (const list of [".arrival-have__scroll", ".arrival-picks"])
    for (const p of ["max-height", "height", "overflow", "overflow-y"])
      expect([list, p, last(css, list, p)]).toEqual([list, p, undefined]);
});
