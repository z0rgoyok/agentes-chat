import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, rules, topLevel } from "./built-css";

const css = await builtCss("src/styles.css", "src/pages/routines.css", "src/components/plan-usage.css");
const top = topLevel(css);
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a settings row's control centres on its words, never pinned to the first line, the row one compact control tall", () => {
  // Nothing lifts or tops what ends a row: the label and its control share the row's middle, a status line included.
  const pinned: string[] = [];
  for (const rule of rules(css))
    for (const s of rule.selectors.filter(
      (s) => s.includes(".settings-row") && /settings-row__(end|control|chevron)/.test(s),
    ))
      for (const [p, v] of rule.declarations)
        if ((p === "translate" && v !== "none") || (p === "align-self" && v === "flex-start"))
          pinned.push(`${s} {${p}: ${v}}`);
  expect(pinned).toEqual([]);
  const row = last(top, ".settings-row", "align-items");
  expect(row).toBe("center");
  expect(last(top, ".settings-row", "min-height")?.replace(/\s+/g, "")).toBe(
    "calc(var(--control-h-sm)+2*var(--row-py))",
  );
  // On a phone every control but a switch goes under the words, from their edge, and sits where it falls.
  const phone = atRule(css, "@media (max-width: 760px)");
  const under = ".settings-row--lead>.settings-row__end:not(:has(>.ac-switch))";
  expect(last(phone, under, "flex-basis")).toBe("100%");
  expect(last(phone, under, "padding-left")?.replace(/\s+/g, "")).toBe("calc(28px+var(--space-3))");
  // Never wider than the row: a select or a field shrinks into it instead of running past the card's edge.
  expect(last(phone, under, "min-width")).toBe("0");
  expect(last(phone, ".settings-row--lead>.settings-row__end:has(>.ac-seg)", "flex-basis")).toBeUndefined();
  // The agent's panel beside a narrow conversation lays a row with an icon out as a phone does.
  const panel = atRule(css, "@container agp-side (max-width: 479px)");
  expect(last(panel, ".agp-card .settings-row--lead", "flex-wrap")).toBe("wrap");
  expect(last(panel, ".agp-card .settings-row--lead>.settings-row__end:not(:has(>.ac-switch))", "translate")).toBe(
    "none",
  );
  expect(last(panel, ".agp-card .settings-row", "flex-direction")).toBeUndefined();
});

test("on a phone a switch stays beside its words only while they keep 24 characters there, else it goes under them", () => {
  // At 320 a long name beside its icon and a switch would get 150px, a word a line. The words keep the kit's
  // `.ac-actrow` basis; only a line that opens something (no ⓘ, its chevron never alone on a line) lets them shrink to
  // 160px.
  // The build writes `flex: 1 1 24ch` as `24ch`.
  expect(last(top, ".ac-actrow>.ac-actrow__text", "flex")).toBe("24ch");
  const phone = atRule(css, "@media (max-width: 760px)");
  for (const sheet of [phone, atRule(css, "@container agp-side (max-width: 479px)")])
    for (const rule of rules(sheet))
      for (const s of rule.selectors.filter((s) => s.endsWith(">.settings-row__text")))
        if (rule.declarations.some(([p]) => p.startsWith("flex"))) expect(s).toContain(".settings-row--open>");
  // With a status, the name itself takes that basis and the status goes under the switch at the row's width: a
  // wrapping row, never a grid, whose columns keep the switch beside the name however little room that leaves.
  const status =
    ".settings-row--lead:has(>.settings-row__end>.ac-switch)>.settings-row__text:has(>.settings-row__status)";
  expect(last(phone, status, "display")).toBe("contents");
  expect(last(phone, `${status}>:first-child`, "flex")).toBe("24ch");
  expect(last(phone, `${status}>:first-child`, "max-width")).toBe("max-content");
  const line = ".settings-row--lead:has(>.settings-row__end>.ac-switch)>.settings-row__text>.settings-row__status";
  expect(last(phone, line, "flex-basis")).toBe("100%");
  expect(last(phone, line, "order")).toBe("1");
  // With a status and a control that is neither a switch nor one button at its end (a select, a choice of several),
  // the status goes under the name at the row's width and the control under the status, from the words' edge. One
  // button keeps the name's line (`settings-row--button`, the next test).
  const button =
    ".settings-row--lead:not(.settings-row--open,.settings-row--button,:has(>.settings-row__end>.ac-switch)):has(>.settings-row__end)";
  expect(last(phone, `${button}>.settings-row__text:has(>.settings-row__status)`, "display")).toBe("contents");
  expect(last(phone, `${button}>.settings-row__text:has(>.settings-row__status)>:first-child`, "flex")).toBe("24ch");
  expect(last(phone, `${button}>.settings-row__text>.settings-row__status`, "flex-basis")).toBe("100%");
  expect(last(phone, `${button}>.settings-row__text>.settings-row__status`, "order")).toBe("1");
  const end =
    ".settings-row--lead:not(.settings-row--open,.settings-row--button):has(>.settings-row__text>.settings-row__status)>.settings-row__end:not(:has(>.ac-switch))";
  expect(last(phone, end, "order")).toBe("2");
  const grids = rules(phone).filter((r) => r.declarations.some(([p, v]) => p === "display" && v === "grid"));
  expect(grids.flatMap((r) => r.selectors).filter((s) => s.includes(".ac-switch"))).toEqual([]);
});

test("a row that ends in one button keeps it on the name's line at the row's end, at every width, its state under the name", () => {
  // At every width, not only a phone's: the row wraps, the words' box steps aside so the name and its state are the
  // row's own items, the name's basis its longest word (it wraps whole words), the state on a line of its own from the
  // words' edge, the button at the end of the name's line.
  const row = ".settings-row.settings-row--button";
  expect(last(top, row, "flex-wrap")).toBe("wrap");
  expect(last(top, ".settings-row--button>.settings-row__text", "display")).toBe("contents");
  const name = ".settings-row--button>.settings-row__text>:first-child";
  expect(last(top, name, "flex")?.split(" ")[0]).toBe("1000");
  expect(last(top, name, "min-width")).toBe("min-content");
  expect(last(top, name, "max-width")).toBe("max-content");
  expect(last(top, ".settings-row--button>.settings-row__text>.settings-row__status", "flex-basis")).toBe("100%");
  expect(last(top, ".settings-row--button>.settings-row__text>.settings-row__status", "order")).toBe("1");
  expect(
    last(
      top,
      ".settings-row--lead.settings-row--button>.settings-row__text>.settings-row__status",
      "padding-left",
    )?.replace(/\s+/g, ""),
  ).toBe("calc(28px+var(--space-3))");
  const end = `${row}>.settings-row__end:not(:has(>.ac-switch))`;
  expect(last(top, end, "flex")).toBe("1 0 auto");
  expect(last(top, end, "justify-content")).toBe("flex-end");
  expect(last(top, end, "padding-left")).toBe("0");
  // Nothing on a phone or in the agent's narrow panel sends it under the words again (a rule that leaves it out says so
  // in a `:not()`).
  const withoutNot = (s: string) => s.replace(/:not\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, "");
  for (const sheet of [atRule(css, "@media (max-width: 760px)"), atRule(css, "@container agp-side (max-width: 479px)")])
    for (const rule of rules(sheet))
      if (rule.selectors.some((s) => withoutNot(s).includes(".settings-row--button")))
        expect(rule.declarations.filter(([p]) => p === "flex-basis" || p === "order")).toEqual([]);
});

test("a text field of several lines in a settings row keeps its rows: the row's one-line control height spares it", () => {
  expect(last(top, "textarea.ac-input", "height")).toBe("auto");
  // What a rule in a settings row gives a height to, a textarea (`textarea`, or an `.ac-input` not kept to inputs).
  const squeezes = (selector: string) => {
    const inRow = selector.slice(selector.indexOf(".settings-row"));
    return (
      /(^|[^\w-])textarea\b/.test(inRow.replaceAll(":not(textarea)", "")) ||
      /\.ac-input(?![\w-])(?!:not\(textarea\))/.test(inRow)
    );
  };
  const squeezed = rules(css).flatMap((rule) =>
    rule.declarations.some(([p]) => p === "height" || p === "block-size")
      ? rule.selectors.filter((s) => s.includes(".settings-row") && squeezes(s))
      : [],
  );
  expect(squeezed).toEqual([]);
});

test("what a row says wraps instead of losing its end to an ellipsis", () => {
  for (const selector of [
    ".routine-row__when-text b",
    ".routine-row__when-text small",
    ".plan-acct__sub",
    ".settings__org>span",
  ]) {
    expect([selector, last(top, selector, "text-overflow")]).toEqual([selector, undefined]);
    expect([selector, last(top, selector, "white-space")]).toEqual([selector, undefined]);
  }
  // An agent's and a connector's names wrap by words, never a letter a line; a level stays whole.
  expect(last(top, ".level-matrix th", "white-space")).toBe("normal");
  expect(last(top, ".level-matrix th", "overflow-wrap")).toBe("break-word");
  expect(last(top, ".level-matrix td", "white-space")).toBe("nowrap");
});

test("usage on a phone: the figures under the name, as wide as the row, not squeezed into a column beside it", () => {
  const phone = atRule(css, "@media (max-width: 720px)");
  expect(last(phone, ".plan-api__row", "grid-template-columns")?.replace(/\s+/g, "")).toBe("28pxminmax(0,1fr)");
  expect(last(phone, ".plan-api__value", "grid-column")?.replace(/\s+/g, "")).toBe("1/-1");
  expect(last(phone, ".plan-api__value", "text-align")).toBe("left");
  expect(last(phone, ".plan-source", "grid-template-columns")?.replace(/\s+/g, "")).toBe("minmax(0,1fr)");
  expect(last(phone, ".plan-source__n", "align-items")).toBe("flex-start");
});

test("a long workspace name never widens the settings' nav", () => {
  expect(last(top, ".settings__nav", "min-width")).toBe("0");
});

test("an agent's identity on a phone: its card as wide as the page, a long role wrapping inside its tag", () => {
  for (const sheet of [atRule(css, "@media (max-width: 640px)"), atRule(css, "@container agp-side (max-width: 640px)")])
    expect(last(sheet, ".agp-id__fields", "align-self")).toBe("stretch");
  expect(last(top, ".agp-roletag", "height")).toBeUndefined();
  expect(last(top, ".agp-roletag", "min-height")).toBe("28px");
  expect(last(top, ".agp-roletag__text", "white-space")).toBeUndefined();
  expect(last(top, ".agp-roletag__text", "text-overflow")).toBeUndefined();
  // The field it turns into keeps the tag's one line.
  expect(last(top, ".agp-roletag.agp-roletag--edit", "height")).toBe("28px");
  // A name that wraps keeps its pencil on its first line.
  expect(last(top, ".agp-inplace", "align-items")).toBe("flex-start");
  expect(last(atRule(css, "@supports (top: 1lh)"), ".agp-inplace__pen", "height")).toBe("1lh");
});
