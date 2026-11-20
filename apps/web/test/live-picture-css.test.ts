import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

const css = topLevel(
  await builtCss(
    "src/components/browser/browser.css",
    "src/components/desktop/desktop.css",
    "src/components/computer/computer.css",
  ),
);
const value = (selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];
const px = (v: string | undefined) => Number.parseFloat(v ?? "NaN");

test("the live picture in the card is concentric with it: the card's radius less the stage's padding", () => {
  const inner = px(value(".brw-ac", "border-radius")) - px(value(".brw-ac__stage", "padding"));
  expect(px(value(".brw-ac__page", "border-radius"))).toBe(inner);
  expect(px(value(".dsk-screen", "border-radius"))).toBe(inner);
  // The computer window's page and screen stand on its stage with no card round them: their own radius stays.
  expect(px(value(".cmp-body .brw-ac__page", "border-radius"))).toBe(10);
  expect(px(value(".cmp-body .dsk-screen", "border-radius"))).toBe(10);
});

test("in the conversation's frame, a hairline over the picture's edge follows its rounded corners", () => {
  // The picture runs to the frame's inner corners there: the stage carries them, and the line.
  const selector = ".brw-mf > .brw-mf__top + .brw-ac__body > .brw-ac__stage::after";
  expect(value(selector, "content")).toBe('""');
  expect(value(selector, "border-radius")).toBe("inherit");
  expect(value(selector, "box-shadow")).toBe("inset 0 0 0 1px var(--line)");
  expect(value(selector, "pointer-events")).toBe("none");
  // Over a held still (z-index 1), under the agent's pointer (2).
  expect(value(selector, "z-index")).toBe("1");
  expect(value(".brw-mf > .brw-mf__top + .brw-ac__body > .brw-ac__stage", "border-radius")).toBe("inherit");
});

test("the card's page and the screen keep one line: the elevation's ring, with none drawn inside it", () => {
  expect(value(".brw-ac__page", "box-shadow")).toBe("var(--e2)");
  expect(value(".dsk-screen", "box-shadow")).toBe("var(--e2)");
  for (const selector of [".brw-ac__page::after", ".dsk-screen::after"]) {
    expect({ selector, content: value(selector, "content") }).toEqual({ selector, content: undefined });
  }
});
