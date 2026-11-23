import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, rules, topLevel } from "./built-css";

const sheet = (file: string) => Bun.file(join(import.meta.dir, "../src", file)).text();

test("a role card's padding is one length all round: as much above the face as under its last line", async () => {
  const layout = await sheet("layout.css");
  const padding = declarations(topLevel(layout), ".newag__role").filter(([p]) => p.startsWith("padding"));
  expect(padding.map(([p]) => p)).toEqual(["padding"]);
  expect(padding[0]?.[1]).toMatch(/^\d+px$/);
  // Its face row is a bare `.ac-faceline` (new-agent.test.tsx), and no rule that reaches it through the card gives it
  // room, at any width.
  const room = rules(`${layout}\n${await sheet("pages/new-agent.css")}`)
    .filter((r) =>
      r.declarations.some(([p]) => /^(padding|margin)(-top|-block(-start)?)?$|^min-(height|block-size)$/.test(p)),
    )
    .flatMap((r) => r.selectors.filter((s) => s.includes(".newag__role") && /\.ac-faceline[^ >+~]*$/.test(s)));
  expect(room).toEqual([]);
});

test("on a narrow screen, where the preview sits above the form, it waits for the step after the role's", async () => {
  const narrow = atRule(await sheet("pages/new-agent.css"), "@media (max-width: 1100px)");
  expect(declarations(narrow, '.newag__aside[data-step="role"]')).toEqual([["display", "none"]]);
});

test("the new agent's list rows are face lines: no rule centres a face against its two lines (ADR 0164)", async () => {
  const card = await sheet("components/new-agent/new-agent-card.css");
  const centred = rules(card).filter(
    (r) => r.selectors.some((s) => s.includes(".nac__item")) && r.declarations.some(([p]) => p === "align-items"),
  );
  expect(centred).toEqual([]);
});

test("the card's list and body fade at an edge only while there is more to scroll that way (ADR 0164)", async () => {
  const card = topLevel(await sheet("components/new-agent/new-agent-card.css"));
  for (const box of [".nac__list", ".nac__body"]) {
    const own = declarations(card, box);
    // No fade until the flags say so, and the scrollbar's strip stays clear.
    expect(own).toContainEqual(["--nac-fade-top", "0px"]);
    expect(own).toContainEqual(["--nac-fade-bottom", "0px"]);
    expect(own.find(([p]) => p === "mask-image")?.[1]).toContain("var(--scroll-strip)");
  }
  expect(declarations(card, ':is(.nac__list, .nac__body)[data-fade-top="true"]')).toEqual([["--nac-fade-top", "20px"]]);
  expect(declarations(card, ':is(.nac__list, .nac__body)[data-fade-bottom="true"]')).toEqual([
    ["--nac-fade-bottom", "28px"],
  ]);
});

test("narrow, the dialog takes two steps at one height, the card's cover stacks, its fitting room wraps (ADR 0164)", async () => {
  const card = await sheet("components/new-agent/new-agent-card.css");
  const top = topLevel(card);
  // One pane at a time, flagged by the dialog (NEW_AGENT_STEPS_QUERY): the list fills the body, the card scrolls in it.
  expect(declarations(top, ".nac__keys[data-steps] .nac__grid")).toContainEqual([
    "grid-template-columns",
    "minmax(0, 1fr)",
  ]);
  expect(declarations(top, ".ac-dialog.nac:has(> .nac__keys[data-steps])").map(([p]) => p)).toEqual(["height"]);
  expect(declarations(top, '.nac__keys[data-step="card"] .nac__card')).toEqual([["overflow", "visible"]]);
  // What it wears: as many columns as fit, never a fixed six.
  expect(declarations(top, ".nac__look .newag__opts--acc")).toEqual([
    ["grid-template-columns", "repeat(auto-fill, minmax(64px, 1fr))"],
  ]);
  // A card under 480px: the bubble under the agent, at the card's width.
  const narrow = atRule(card, "@container nac-card (max-width: 480px)");
  expect(declarations(narrow, ".nac__cover")).toContainEqual(["flex-direction", "column"]);
  expect(declarations(narrow, ".nac__bubble")).toContainEqual(["position", "relative"]);
  expect(declarations(narrow, ".nac__bubble")).toContainEqual(["align-self", "stretch"]);
});

test("the chat's band fits an AI and four apps at 360px and at 300px, and scrolls sideways past that (ADR 0164)", async () => {
  const card = await sheet("components/new-agent/new-agent-card.css");
  const wide = atRule(card, "@container nac-band (max-width: 520px)");
  const narrow = atRule(card, "@container nac-band (max-width: 400px)");
  // A value in force at a width: the narrower block's over the wider one's.
  const px = (blocks: string[], selector: string, property: string) => {
    const found = blocks
      .flatMap((b) => declarations(b, selector))
      .filter(([p]) => p === property)
      .at(-1)?.[1];
    return Number.parseFloat(found ?? "NaN");
  };
  for (const [width, blocks] of [
    [360, [wide]],
    [300, [wide, narrow]],
  ] as const) {
    const room =
      px([...blocks], ".nac-band__path", "left") +
      px([...blocks], ".nac-band__path", "right") +
      5 * (px([...blocks], ".nac-band__trail", "width") + px([...blocks], ".nac-band__slot", "width"));
    expect(room).toBeLessThanOrEqual(width);
  }
  // Narrower still, the path scrolls and fades only at an edge with more past it.
  expect(declarations(wide, ".nac-band__path")).toContainEqual(["overflow-x", "auto"]);
  expect(declarations(wide, '.nac-band__path[data-fade-end="true"]')).toEqual([["--nac-band-fade-end", "24px"]]);
});

test("the step's head keeps its gap: the onboarding's unlayered head rule never reaches Criar agente", async () => {
  // layout.css is in a cascade layer and onboarding.css is not: an unscoped rule there wins whatever the selector.
  const onboarding = rules(await sheet("pages/onboarding.css")).flatMap((r) => r.selectors);
  expect(onboarding.filter((s) => s.includes(".onb__head") && !s.includes(".onb--rail"))).toEqual([]);
  const layout = topLevel(await sheet("layout.css"));
  expect(declarations(layout, ".newag .onb__head")).toEqual([["margin-bottom", "var(--space-6)"]]);
  // A section's label: 24 over, 8 under, centred with its ⓘ and its action (never on an icon's baseline).
  const sect = declarations(layout, ".newag__sect");
  expect(sect).toContainEqual(["margin", "var(--space-6) 0 var(--space-2)"]);
  expect(sect).toContainEqual(["align-items", "center"]);
});

test("a select's trigger is the kit's one control tall: no screen class sets its height, bar the two-line row", async () => {
  const sheets = `${await sheet("layout.css")}\n${await sheet("pages/new-agent.css")}`;
  const tall = rules(sheets)
    .filter((r) => r.declarations.some(([p]) => p === "min-height" || p === "height"))
    .flatMap((r) => r.selectors.filter((s) => /\.(newag__sel|agp-brainsel)\b.*\.ac-select__trigger/.test(s)));
  expect(tall).toEqual([".agp-brainsel.agp-advrow .ac-select__trigger"]);
});

test("the review's rows: kit steps, and the name, the value and Editar start on one line height", async () => {
  const review = topLevel(await sheet("pages/new-agent.css"));
  const row = declarations(review, ".newag__rv");
  expect(row).toContainEqual(["padding", "var(--space-3) 0"]);
  expect(row).toContainEqual(["line-height", "var(--rv-line)"]);
  expect(declarations(review, ".newag__rv-k")).toContainEqual(["min-height", "var(--rv-line)"]);
});

test("a review row stacks by the room the review has, not the window's: narrow beside the app's sidebar too", async () => {
  const css = await sheet("pages/new-agent.css");
  expect(declarations(topLevel(css), ".newag__review")).toContainEqual(["container", "newag-review / inline-size"]);
  const narrow = atRule(css, "@container newag-review (max-width: 520px)");
  expect(declarations(narrow, ".newag__rv")).toContainEqual(["grid-template-areas", '"k end" "v v"']);
  expect(declarations(narrow, ".newag__rv-v")).toEqual([["grid-area", "v"]]);
  // Only there, so no window width decides it: a laptop's window is wide while the flow's column is a phone's.
  const stacked = rules(css).filter(
    (r) => r.selectors.includes(".newag__rv") && r.declarations.some(([prop]) => prop === "grid-template-areas"),
  );
  expect(stacked).toHaveLength(1);
});

test("the kit: an option's ⓘ follows its words, and a text button has no box", async () => {
  const kit = topLevel(await Bun.file(join(import.meta.dir, "../../../packages/ui/src/styles/components.css")).text());
  expect(declarations(kit, ".ac-hint.ac-menu__hint").find(([p]) => p === "margin")?.[1]).toBe("-5px 0");
  expect(declarations(kit, ".ac-hint.ac-menu__hint + .ac-menu__check")).toEqual([["margin-left", "auto"]]);
  const link = declarations(kit, ".ac-link--action").map(([p]) => p);
  for (const box of ["padding", "height", "min-height", "border", "background"]) expect(link).not.toContain(box);
  // Busy, the spinner is over the words, out of the flow: the button keeps its width and its neighbours their place.
  expect(declarations(kit, ".ac-link--loading > .ac-btn__spinner")).toContainEqual(["position", "absolute"]);
});
