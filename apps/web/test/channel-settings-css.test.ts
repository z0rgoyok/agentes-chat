import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

// What applies at every width: on a phone the nav is a strip of links as wide as their words.
const css = topLevel(await builtCss());
const value = (selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];

test("a channel's settings nav: every row as wide as it with the links' own hover plate; leave, archive and delete in red", () => {
  expect(value(".channel-settings__nav .settings__link", "width")).toBe("100%");
  // Nothing here takes the links' hover plate or their current section's key away.
  expect(value(".channel-settings__nav .settings__link", "background")).toBeUndefined();
  expect(value(".settings__link:hover", "background")).toContain("color-mix");
  // Leave, archive and delete stretch across the nav as its sections do.
  expect(value(".channel-settings__danger", "align-items")).toBeUndefined();
  expect(value(".channel-settings__nav .channel-settings__act", "color")).toBe("var(--danger)");
  // While one runs, its row shows no plate under the pointer (the build writes `none` as `0 0`).
  expect(value(".channel-settings__act:disabled", "background")).toMatch(/^(none|0 0)$/);
});
