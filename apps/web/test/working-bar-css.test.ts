import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

test("what ships keeps the bar above the composer one low width, the composer's: the words take what is left, the clock ticks in place", async () => {
  const css = topLevel(await builtCss());
  const last = (selector: string, property: string) =>
    declarations(css, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  const bar = '.ac-typing[data-active="true"]';
  // A bare line on the conversation's ground: no glass, no shadow (and no sky behind it).
  expect(last(bar, "background")).toBeUndefined();
  expect(last(bar, "box-shadow")).toBeUndefined();
  expect(declarations(css, ".ac-typing__sky")).toEqual([]);
  // One width whatever it says or shows (a turning phrase, the seconds, "Ver" coming and going): no width
  // of its own and no cap, so it fills the composer's column, its edges on the composer's (the channel, a thread in
  // the panel, a DM, a task's conversation alike).
  expect(last(bar, "width")).toBeUndefined();
  expect(last(bar, "max-width")).toBeUndefined();
  expect(last(".ac-typing", "margin")).toBe("0 0 var(--space-1)");
  // One low line, a second only for a name that needs it: a name is never cut.
  expect(last(bar, "min-height")).toBe("28px");
  expect(last(bar, "height")).toBeUndefined();
  // The words never size it: they take the room left, on one line.
  const words = `${bar} .ac-typing__text`;
  expect(last(words, "display")).toBe("flex");
  expect(last(words, "flex")).toBe("1 1 0");
  expect(last(words, "min-width")).toBe("0");
  expect(last(words, "white-space")).toBe("nowrap");
  // Who is typing keeps its width (the agents' words before it give way, their " · " cut with them), and only the
  // names in it end in "…".
  expect(last(".ac-typing__agents", "overflow")).toBe("hidden");
  expect(last(".ac-typing__people", "flex")).toBe("none");
  expect(last(".ac-typing__people", "max-width")).toBe("100%");
  expect(last(".ac-typing__typers", "text-overflow")).toBe("ellipsis");
  // Its round buttons fit the low line; it has no stop of its own (the composer's).
  expect(declarations(css, ".ac-typing .stop-run")).toEqual([]);
  expect(last(".ac-typing__browser.ac-btn", "height")).toBe("24px");
  // An agent's step in the bar is as wide as its words while the bar has room ("planos-concorrentes.md" whole), so
  // the time follows them; out of room it gives way first, down to nothing.
  expect(last(".ac-typing__step", "max-width")).toBeUndefined();
  expect(last(".ac-typing__step", "min-width")).toBe("0");
  expect(last(".ac-typing__step", "flex")).toBe("0 1000 auto");
  // One agent: its name, step, time and who types beside it are the bar's own pieces; the name wraps, never cut, and
  // what is typed beside it wraps ahead of Ver (no box that lets it run on under it).
  expect(
    last('.ac-typing[data-active="true"] .ac-typing__text:has(>.ac-typing__agents>.ac-typing__step)', "display"),
  ).toBe("contents");
  expect(last(".ac-typing__agents:has(>.ac-typing__step)>b", "white-space")).toBe("normal");
  expect(last(".ac-typing__also", "white-space")).toBeUndefined();
  expect(last(".ac-typing__also", "min-width")).toBeUndefined();
  // The time right after the words ("Ada pensando… · 14 s"), quiet as they are; the globe or the rule before Ver
  // takes the room left, after the time or else after the words, so Ver is at the end from the first frame.
  expect(last(".ac-typing__text+.ac-typing__elapsed", "margin-left")).toBeUndefined();
  expect(last(".ac-typing__elapsed", "font-weight")).toBe("400");
  expect(
    last(
      ".ac-typing__text:has(>.ac-typing__agents>.ac-typing__step)+:is(.ac-typing__browser,.ac-typing__sep)",
      "margin-left",
    ),
  ).toBe("auto");
  expect(last(".ac-typing__text+.ac-typing__elapsed+:is(.ac-typing__browser,.ac-typing__sep)", "margin-left")).toBe(
    "auto",
  );
  // The clock's figures are all one width (`ac-num`), so the seconds never nudge it.
  expect(last(".ac-num", "font-variant-numeric")).toBe("tabular-nums");
});

test("what ships draws who records a voice message: three still bars at every width, moving only where motion is welcome", async () => {
  const all = await builtCss();
  const css = topLevel(all);
  const last = (selector: string, property: string) =>
    declarations(css, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  // Three 3 px bars in the voice wave's look, ink and never red; still, at three heights, with reduced motion.
  expect(last(".ac-typing__bars", "height")).toBe("12px");
  expect(last(".ac-typing__bars span", "width")).toBe("3px");
  expect(last(".ac-typing__bars span", "background")).toBe("var(--ink-muted)");
  expect(last(".ac-typing__bars span", "animation")).toBeUndefined();
  expect(last(".ac-typing__bars span:nth-child(2)", "transform")).toMatch(/^scaleY\(0?\.75\)$/);
  const moving = declarations(atRule(all, "@media (prefers-reduced-motion: no-preference)"), ".ac-typing__bars span");
  expect(moving.find(([p]) => p === "animation")?.[1]).toContain("ac-typing-bar");
  // Their group: the bars, the faces and the words, keeping its width as who types does (the agents' words give way
  // first), the names alone giving way after them, never the verb.
  expect(last(".ac-typing__group", "display")).toBe("flex");
  expect(last(".ac-typing__group", "flex")).toBe("none");
  expect(last(".ac-typing__group", "max-width")).toBe("100%");
  expect(last(".ac-typing__group>.ac-typing__people", "min-width")).toBe("0");
  // Beside who types, a line of their own when one is short: both verbs whole.
  expect(
    last('.ac-typing[data-active="true"] .ac-typing__text:has(>.ac-typing__group+.ac-typing__group)', "flex-wrap"),
  ).toBe("wrap");
});

test("what ships draws the working row's rings with transforms only, still with reduced motion, paused off screen", async () => {
  const all = await builtCss();
  const css = topLevel(all);
  const last = (selector: string, property: string) =>
    declarations(css, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  // Still everywhere: each dot at its own place on its ring, turned by a transform alone.
  expect(last(".ac-orbit__spin", "animation")).toBeUndefined();
  expect(last(".ac-orbit__spin", "transform")).toBe("rotate(var(--start))");
  // Each ring rests at its own tilt: it turns round the face only where motion is welcome.
  expect(last(".ac-orbit__roll", "animation")).toBeUndefined();
  expect(last(".ac-orbit__roll", "transform-origin")).toBe("0 0");
  // The rings take no room: they reach into the row's gap, behind and in front of the face.
  expect(last(".ac-orbit>.ac-orbit__front", "position")).toBe("absolute");
  expect(last(".ac-orbit>.ac-orbit__back", "position")).toBe("absolute");
  expect(last(".ac-orbit>.ac-orbit__back", "z-index")).toBe("var(--z-under)");
  // Their box reaches past the row: the row clips it, or the conversation would scroll by it.
  expect(last(".working-tail", "overflow")).toBe("clip");
  // Turning only where motion is welcome, and paused off screen.
  const moving = atRule(all, "@media (prefers-reduced-motion: no-preference)");
  expect(declarations(moving, ".ac-orbit__spin").find(([p]) => p === "animation")?.[1]).toContain("ac-orbit-turn");
  expect(
    declarations(moving, ".ac-orbit[data-paused=true] :is(.ac-orbit__spin,.ac-orbit__unspin,.ac-orbit__roll)").find(
      ([p]) => p === "animation-play-state",
    )?.[1],
  ).toBe("paused");
  // Its keyframes move only transforms (the compositor's), never layout or paint.
  const frames = all.match(/@keyframes ac-orbit-turn\{[^}]*\{[^}]*\}[^}]*\{[^}]*\}\}/)?.[0] ?? "";
  expect(frames).toContain("transform:");
  expect(frames.replace(/transform:[^;}]*/g, "")).not.toMatch(/[a-z-]+:/);
  // The rings themselves turn round the face too, slowly, the light riding them: transforms alone again.
  expect(declarations(moving, ".ac-orbit__roll").find(([p]) => p === "animation")?.[1]).toContain("ac-orbit-roll");
  const roll = all.match(/@keyframes ac-orbit-roll\{[^}]*\{[^}]*\}[^}]*\{[^}]*\}\}/)?.[0] ?? "";
  expect(roll).toContain("rotate(360deg)");
  expect(roll.replace(/transform:[^;}]*/g, "")).not.toMatch(/[a-z-]+:/);
  // The row's line is a row's, not the bar's: no height cap, the message's size.
  const line = ".working-tail>.working-tail__body>.working-tail__line.ac-typing[data-active]";
  expect(last(line, "max-height")).toBe("none");
  expect(last(line, "font-size")).toBe("var(--msg-text)");
  // One line whatever it says: no piece wraps to a second (it came and went as the step turned, moving the
  // conversation and the composer), the step gives way first, and the name keeps its width up to half the line.
  expect(last(".working-tail__words", "flex-wrap")).toBeUndefined();
  expect(last(".working-tail__words", "white-space")).toBe("nowrap");
  expect(
    last(
      ".working-tail>.working-tail__body>.working-tail__line.ac-typing[data-active] .ac-typing__text",
      "white-space",
    ),
  ).toBeUndefined();
  const name = ".working-tail .ac-typing__agents:has(>.ac-typing__step)>b";
  expect(last(name, "flex")).toBe("none");
  expect(last(name, "max-width")).toBe("50%");
  expect(last(name, "white-space")).toBe("nowrap");
  // What it did so far wraps: never cut.
  expect(last(".working-tail__trail>li", "overflow-wrap")).toBe("anywhere");
});
