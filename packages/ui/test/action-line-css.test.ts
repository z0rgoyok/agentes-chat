import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
/** The declarations of the first rule written exactly as `selector {`, at the top level or one block deep. */
const rule = (selector: string) =>
  (css.split(`\n${selector} {`)[1] ?? css.split(`\n  ${selector} {`)[1])?.split("}")[0] ?? "";

test("the action line: words on their one-line width, actions beside them only while that fits, an empty slot takes no room", () => {
  expect(rule(".ac-actline")).toContain("flex-wrap: wrap");
  expect(rule(".ac-actline")).toContain("gap: var(--space-2) var(--space-4)");
  expect(rule(".ac-actline > :first-child")).toContain("flex: 1 1 auto");
  expect(rule(".ac-actline > :not(:first-child)")).toContain("flex: none");
  expect(rule(".ac-actline > :not(:first-child)")).toContain("margin-inline-start: 0");
  // A slot the viewer has nothing in (an action they may not take) leaves no gap and no row behind.
  expect(rule(".ac-actline > :is(span, div):empty")).toContain("display: none");
});

test("a card's head keeps a lone switch or quiet link at its end, the words wrapping beside it", () => {
  const head = ".ac-card__head:has(> .ac-card__action > :is(.ac-switch, .ac-link--action):only-child)";
  expect(rule(head)).toContain("flex-wrap: nowrap");
  expect(rule(`${head} > .ac-card__lead`)).toContain("flex: 1 1 0%");
  expect(rule(`${head} > .ac-card__action`)).toContain("margin-inline-start: 0");
});

test("on a phone a lone button takes the width of what holds it, at its own height", () => {
  const phone = css.split("@media (max-width: 640px) {\n  .ac-card > .ac-acts > .ac-btn:only-child")[1] ?? "";
  expect(phone.split("}")[0]).toContain(":not(.ac-btn--ghost) {\n    flex: 1 1 auto;");
  // A dialog's foot or an empty state with one button: it takes a line of its own, under the foot's note.
  expect(rule(":is(.ac-dialog__foot, .ac-empty__actions):not(:has(> .ac-btn ~ .ac-btn)) > .ac-btn")).toContain(
    "flex: 1 1 100%",
  );
  // Beside a note the one button is the footer's group of buttons: the group takes the line, the button the group.
  expect(
    rule(
      ".ac-dialog__foot-acts:not(:has(> .ac-btn ~ .ac-btn)),\n  .ac-dialog__foot-acts:not(:has(> .ac-btn ~ .ac-btn)) > .ac-btn",
    ),
  ).toContain("flex: 1 1 100%");
  // A MediaRow's end that went under its row: the end takes the row, its one plated button too.
  expect(rule(".ac-mediarow__end--wrap:has(> .ac-btn:only-child:not(.ac-btn--ghost))")).toContain(
    "justify-self: stretch",
  );
  expect(rule(".ac-mediarow__end--wrap > .ac-btn:only-child:not(.ac-btn--ghost)")).toContain("flex: 1 1 auto");
});

test("a dialog's foot never holds a button wider than the dialog: its words end in an ellipsis", () => {
  expect(rule(".ac-dialog__foot .ac-btn")).toContain("max-width: 100%");
  const label = rule(".ac-dialog__foot .ac-btn__label");
  for (const d of ["min-width: 0", "overflow: hidden", "text-overflow: ellipsis"]) expect(label).toContain(d);
  // Beside a note, the buttons are one group no wider than the foot, which goes under the note when both can't share
  // a line (the action line).
  expect(rule(".ac-dialog__foot-acts")).toContain("max-width: 100%");
  // A ghost at its end reaches its plate past the group: as much wider than it, or its words end cut.
  const endGhost =
    ".ac-dialog__foot > .ac-btn--ghost:not(.ac-btn--icon):last-child,\n.ac-dialog__foot-acts > .ac-btn--ghost:not(.ac-btn--icon):last-child";
  expect(rule(endGhost)).toContain("margin-inline-end: calc(-1 * var(--ghost-plate))");
  expect(rule(endGhost)).toContain("max-width: calc(100% + var(--ghost-plate))");
  expect(rule(".ac-dialog__foot-acts")).toContain("flex: none");
});
