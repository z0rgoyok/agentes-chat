import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

const built = await builtCss(
  "src/styles.css",
  "src/components/notice-island.css",
  "src/components/no-ai.css",
  "src/components/computer/computer.css",
);
const css = topLevel(built);
const last = (selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("in the closed island's pill, the face and Ver are round, and the small island's Ver is as far from its end as from its top", () => {
  expect(last(".ni .ni__pill>.ni__face", "border-radius")).toBe("50%");
  expect(last(".ni__see.ac-btn", "border-radius")).toBe("var(--radius-full)");
  expect(last(".ni--small .ni__see.ac-btn", "margin-right")).toBe("var(--space-1)");
  // People only were round: an agent kept its square tile against the pill's curve.
  expect(css).not.toContain(":not(.ac-avatar--agent)");
});

test("the island's corner and the clip it grows and folds with are one value, per shape", () => {
  expect(last(".ni", "border-radius")).toBe("var(--ni-r)");
  expect(last(".ni", "--ni-r")).toBe("24px");
  expect(last(".ni--small", "--ni-r")).toBe("20px");
  expect(last(".ni--open", "--ni-r")).toMatch(/^calc\(32px \* \.3 \+ 20px\)|^29\.6px$/);
  // A fixed `round 24px` ends the small and the open shapes on a corner that is not theirs.
  const keyframes = built.match(/@keyframes ni-(in|out)\{[^@]*/g)?.join("") ?? "";
  expect(keyframes).not.toContain("round 24px");
  expect(keyframes.match(/round var\(--ni-r\)/g)?.length).toBe(3);
});

test("boxes holding buttons take their corner from them: the button's plus the room around it", () => {
  expect(last(".ac-toast", "border-radius")).toBe("calc(var(--control-r-sm) + var(--toast-pad))");
  expect(last(".noai-banner", "border-radius")).toBe("calc(var(--control-r-sm) + var(--space-2))");
  expect(last(".cmp-banner", "border-radius")).toBe("calc(var(--control-r-sm) + 10px)");
  // The toast's × sits 4 from its side and 12 from its top: no plate there can follow the corner.
  expect(last(".ac-toast>.ac-toast__close:hover", "background")).toBe("0 0");
});
