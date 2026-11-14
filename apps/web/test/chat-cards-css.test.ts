import { expect, test } from "bun:test";
import { builtCss, declarations } from "./built-css";

const css = await builtCss(
  "src/styles.css",
  "src/components/agent-actions.css",
  "src/components/issue-work.css",
  "src/components/missions/missions.css",
  "src/components/browser/browser.css",
  "src/components/request-card.css",
);
const value = (selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];

test("a message's words use the whole column; a code block or a table scrolls in its own box", () => {
  for (const selector of [".ac-msg__text", ".shell__main--chat .ac-msg__text"])
    expect(value(selector, "max-width")).toBeUndefined();
  expect(value(".ac-msg__text pre", "overflow")).toBe("auto hidden");
  expect(value(".md__table", "overflow")).toBe("auto");
  // Outside a message (a wiki page) as wide as its columns, up to the page's.
  expect(value(".md__table", "width")).toBe("fit-content");
  expect(value(".md__table", "max-width")).toBe("100%");
  // In a message every table is the message's width, so tables one under another line up; a wide one scrolls
  // inside its box, which fades on the side with more columns.
  expect(value(".md--message .md__table", "width")).toBe("100%");
  expect(value(".md__table-scroll", "overflow-x")).toBe("auto");
  expect(value('.md__table[data-more="end"] > .md__table-scroll', "mask-image")).toContain("linear-gradient");
  expect(value('.md__table[data-more="start"] > .md__table-scroll', "mask-image")).toContain("linear-gradient");
  expect(value('.md__table[data-more="both"] > .md__table-scroll', "mask-image")).toContain("linear-gradient");
  expect(value(".code-card__code", "overflow-x")).toBe("auto");
});

test("the cards in a message share one width: the tools, a lone call's line and the other cards (receipts hug their words)", () => {
  expect(value(":root", "--msg-card-w")).toBe("640px");
  for (const selector of [
    ".ac-tools",
    // A request, a memory change, a question to another agent, the older work line.
    ".ac-approval",
    ".consult-pair__detail",
    ".ac-work",
    // Files, a chart, the redo-or-explain ask, an issue's work card.
    ".artifact-cards",
    ".chart-card",
    ".correction-ask",
    ".iw-card",
    // A request still waiting as a pill: connect an AI, a stretch, waiting for its computer.
    ".rq-open",
    // A mission's link and its command to approve.
    ".mi-linkcard",
    ".mi-cmd",
    // Open or not, the browser card; a request or its decided line; a mission's card.
    ".brw-ac",
    ".rq",
    ".rq-done",
    ".mi-card",
    ".brw-ac.brw-trail.is-open",
    ".brw-ac.brw-trail.brw-mf-end",
  ])
    expect([selector, value(selector, "max-width")]).toEqual([selector, "var(--msg-card-w)"]);
});

test("nothing in a message wears the hover plate's own gray: cards a step up, wells a tint that darkens with it", () => {
  // The row's hover is the soft plate; what sits on it never is.
  expect(value(".ac-msg:hover", "background")).toBe("var(--plate-soft)");
  expect(declarations(css, ".ac-msg>*")).toEqual(
    expect.arrayContaining([
      ["--raised", "var(--raised-2)"],
      ["--surface-raised", "var(--raised-2)"],
      ["--sunken", "var(--msg-well)"],
      ["--surface-sunken", "var(--msg-well)"],
      // The pressed-in well too ("Leu seu recado" under the tools).
      ["--card-well", "var(--msg-well)"],
    ]),
  );
  // Light: a well is the plate's tint over the row (darker hovered or not); dark: its own darker ground.
  expect(declarations(css, '[data-theme="light"]')).toContainEqual(["--msg-well", "var(--plate-soft)"]);
  expect(declarations(css, '[data-theme="dark"]')).toContainEqual(["--msg-well", "var(--sunken)"]);
  // Receipts and "redo or explain?" are cards like the tools: the card face and its hairline, never the sunken gray.
  for (const selector of [".ag-rc", ".ag-rcg", ".ac-tools", ".correction-ask"]) {
    expect([selector, value(selector, "background")]).toEqual([selector, "var(--surface-raised)"]);
    expect([selector, value(selector, "box-shadow")]).toEqual([selector, "var(--card-shadow)"]);
  }
  // A request (an agent's proposal with Revisar/Recusar, an approval, a question) is a face with its hairline.
  expect(value(".rq", "background")).toBe("var(--raised)");
  expect(value(".rq", "box-shadow")).toBe("0 0 0 1px var(--line2)");
  // No card in a message sits on the well: the well is the hover plate's tint.
  for (const selector of [".ag-rc", ".ag-rcg", ".ac-tools", ".correction-ask", ".ac-approval", ".rq"])
    expect(`${selector} ${value(selector, "background")}`).not.toMatch(/sunken|msg-well|plate/);
  // What waits for a click (connect an AI, a stretch, waiting for its computer) is a pill: a hairline, no fill.
  for (const selector of [".rq-open", ".rq-done"])
    expect([selector, value(selector, "background")]).toEqual([selector, undefined]);
});

test("a row's sentence and a tool's line wrap, whole; what an agent changed too, on a card as wide as its words", () => {
  for (const selector of [
    ".ag-rc__sentence",
    ".ag-rc__by",
    ".ac-tools__label",
    ".ac-tools__label b",
    ".ac-tools__label small",
  ]) {
    expect(value(selector, "text-overflow")).toBeUndefined();
    expect(value(selector, "white-space")).toBeUndefined();
  }
  for (const selector of [".ag-rc__sentence", ".ag-rc__by"]) expect(value(selector, "overflow-wrap")).toBe("anywhere");
  expect(value(".ac-tools__label", "flex-wrap")).toBe("wrap");
  // Nothing cuts a change's words with "…" any more.
  expect(css).not.toContain(".ag-rc__line");
  // A receipt is as wide as its words, up to 480px (its padding inside) and never past the column: a long routine's
  // receipt wraps short of the members column, a short one never spans the conversation.
  for (const selector of [".ag-rc", ".ag-rcg"]) {
    expect([selector, value(selector, "width")]).toEqual([selector, "fit-content"]);
    expect([selector, value(selector, "max-width")]).toEqual([selector, "min(100%,480px)"]);
    expect([selector, value(selector, "box-sizing")]).toEqual([selector, "border-box"]);
  }
  // The report offer is the cards' width from the start, as a request is: its report opening inside never widens it,
  // so Enviar and Agora não stay where they were.
  expect(value(".ag-rc.ag-fb", "width")).toBe("auto");
  expect(value(".ag-rc.ag-fb", "max-width")).toBe("var(--msg-card-w)");
});

test("a card's rows start under its title: a row's hover never covers it", () => {
  expect(value(".settings-rows", "margin")).toBe("calc(-1 * var(--card-pad))");
  expect(value(".ac-card__head+.settings-rows", "margin-top")).toBe("0");
  expect(value(".ac-card__head+.settings-rows>.settings-row:first-child", "border-top")).toBe("1px solid var(--line)");
});

test("two agents talking is one pair row; on a reach line it ends where the list's own line ends", () => {
  // Long names wrap whole, never cut: the row is one centred sentence, each face kept with its name's first word, the
  // faces and the ⇄ on the capitals of the words beside them.
  expect(value(".consult-pair__name", "text-overflow")).toBeUndefined();
  expect(value(".consult-pair__name", "overflow")).toBeUndefined();
  expect(value(".consult-pair__row", "white-space")).toBeUndefined();
  expect(value(".consult-pair__row", "display")).toBe("inline-block");
  expect(value(".consult-pair__row", "text-align")).toBe("center");
  expect(value(".consult-pair__row", "line-height")).toBe("18px");
  expect(value(".consult-pair__who", "white-space")).toBe("nowrap");
  expect(value(".consult-pair__who>.consult-pair__name", "white-space")).toBe("normal");
  expect(value(".consult-pair__faces", "vertical-align")).toContain("var(--cap-mid)");
  expect(value(".consult-pair__faces", "display")).toBe("inline-flex");
  expect(value(".consult-pair__word", "white-space")).toBe("nowrap");
  expect(value(".consult-pair__swap", "vertical-align")).toContain("var(--cap-mid)");
  expect(value(".ag-rcs .ag-rc--talk>.consult-pair", "padding-inline")).toBe("calc(16px - var(--msg-inline))");
});

test("a select's list keeps room under its last row once scrolled to the bottom", () => {
  expect(value(".ac-menu--select [data-radix-select-viewport]", "padding-block")).toBe("var(--menu-pad)");
});
