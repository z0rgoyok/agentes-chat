import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("rows that became MediaRows lay nothing out of their own: the kit's grid puts the face, the name and the rest", async () => {
  const css = topLevel(
    await builtCss(
      "src/styles.css",
      "src/components/team-plan.css",
      "src/pages/issues.css",
      "src/pages/approvals.css",
      "src/pages/notifications.css",
      "src/pages/home.css",
      "src/components/roles/roles.css",
    ),
  );
  for (const row of [".tp-agent", ".ap-li", ".ap-row", ".nt-item", ".home-row"]) {
    for (const p of ["display", "grid-template-columns", "align-items", "gap", "column-gap", "all"])
      expect([row, p, last(css, row, p)]).toEqual([row, p, undefined]);
  }
  // An option, a list row or a button the kit's MediaRow is mixed with loses to it at the same weight.
  expect(last(css, ".ac-mediarow", "display")).toBe("grid");
});

test("the stalled line wraps on a narrow screen: its words under the icon, its two buttons together at its end", async () => {
  const css = topLevel(await builtCss("src/styles.css", "src/pages/issues.css"));
  expect(last(css, ".issues-stalled", "flex-wrap")).toBe("wrap");
  expect(last(css, ".issues-stalled__text", "min-width")).toBe("0");
  expect(last(css, ".issues-stalled__acts", "display")).toBe("flex");
  expect(last(css, ".issues-stalled__acts", "margin-left")).toBe("auto");
});

test("the task list on a phone: stacked as a card, the title, its facts with the number among them, who has it", async () => {
  const css = await builtCss("src/styles.css", "src/pages/issues.css");
  const phone = atRule(css, "@media (max-width: 720px)");
  expect(last(phone, ".issue-list__row", "display")).toBe("flex");
  expect(last(phone, ".issue-list__row", "flex-direction")).toBe("column");
  expect(last(phone, ".issue-list__row", "grid-template-columns")).toBeUndefined();
  // The number leaves its column and leads the facts, as on a card.
  expect(last(phone, ".issue-list__num", "display")).toBe("none");
  expect(last(phone, ".issue-list__row>.issue-card__facts>:first-child", "display")).toBe("inline-flex");
  // The list clips its rows at its rounded corners: the first and last rows take them, so a ring is drawn whole.
  const top = topLevel(css);
  expect(last(top, ".issue-list>li:first-child>.issue-list__row", "border-top-left-radius")).toBe("inherit");
  expect(last(top, ".issue-list>li:last-child>.issue-list__row", "border-bottom-right-radius")).toBe("inherit");
});
