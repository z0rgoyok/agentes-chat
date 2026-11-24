import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CARD_PAD, GROUPED_ROW, SCREEN_X, SHEET_BAR, SHEET_GAP, SHEET_X, TOOL_H, TOUCH } from "../src/ui/rhythm";

const SRC = join(import.meta.dir, "../src");
const source = (file: string) => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

test("the phone's page rhythm: sides 16, cards 16 inside, a toolbar's controls 32 with a 44 target, grouped rows 52", () => {
  expect(SCREEN_X).toBe(16);
  expect(CARD_PAD).toBe(16);
  expect(TOOL_H).toBe(32);
  expect(TOUCH).toBe(44);
  // A wrapping row's label starts where a one-line row's does: its 22-point line centred in 52. Whatever leads a row
  // sits in one 36-point column.
  expect(GROUPED_ROW).toEqual({ minHeight: 52, padX: 16, padY: 10, tallPadY: 15, lead: 36 });
});

test("every sheet's body has one rhythm: a screen's sides, 12 between its blocks, the bar 50 tall 14 under the top", () => {
  expect(SHEET_X).toBe(SCREEN_X);
  expect(SHEET_GAP).toBe(12);
  expect(SHEET_BAR).toEqual({ height: 50, top: 14 });
  const sheet = source("Sheet.tsx");
  const body = sheet.slice(sheet.indexOf("export function useSheetBody("));
  expect(body).toContain("paddingHorizontal: SHEET_X,");
  expect(body).toContain("gap: SHEET_GAP,");
  // The sheets that are routes and a screen's sheet steps take that body rather than numbers of their own.
  const screen = source("SheetScreen.tsx");
  expect(screen).toContain("const body = useSheetBody();");
  expect(screen).toContain("contentContainerStyle={body}");
  expect(screen).not.toMatch(/padding(Horizontal|Top): \d|gap: \d/);
  const steps = readFileSync(join(SRC, "features/shared/SheetHost.tsx"), "utf8");
  expect(steps).toContain("contentContainerStyle={body}");
  expect(steps).not.toMatch(/gap: \d/);
  const picker = readFileSync(join(SRC, "features/shared/PickerSheet.tsx"), "utf8");
  expect(picker).toContain("search: { paddingHorizontal: SHEET_X,");
  expect(picker).not.toMatch(/paddingHorizontal: 1[68]\b/);
});

test("a sheet's action row leads with a grouped row's column: its text starts where the list's hairline does", () => {
  const parts = readFileSync(join(SRC, "features/shared/parts.tsx"), "utf8");
  expect(parts).toContain("actionLead: { width: GROUPED_ROW.lead,");
  expect(parts).toContain('actionTall: { alignItems: "flex-start", paddingVertical: GROUPED_ROW.tallPadY }');
  expect(parts).toMatch(/action: \{[^}]*gap: 12,[^}]*paddingHorizontal: GROUPED_ROW\.padX,/);
  // GroupedList starts the hairline after the same column and the same 12.
  const grouped = source("Grouped.tsx");
  expect(grouped).toContain("const LEAD = GROUPED_ROW.lead;");
  expect(grouped).toContain("GROUPED_ROW.padX + LEAD + 12");
  expect(GROUPED_ROW.padX + GROUPED_ROW.lead + 12).toBe(64);
});

test("the kit's screens, grouped rows and toolbar controls read those numbers instead of their own", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).not.toMatch(/minHeight: 50|paddingHorizontal: 14|\b14 \+ LEAD/);
  expect(grouped).toContain("minHeight: GROUPED_ROW.minHeight");
  // The segmented control is a touch-first capsule now (40, a screen's views 44): its own segment heights.
  expect(source("Segmented.tsx")).toContain("const SEGMENT_H = 34;");
  expect(source("Filters.tsx")).toContain("minHeight: TOOL_H");
  expect(source("Filters.tsx")).toContain("gap: 8");
  expect(source("LargeTitleHead.tsx")).toContain("paddingHorizontal: SCREEN_X");
  expect(source("SectionHeader.tsx")).toContain("paddingHorizontal: SCREEN_X");
  expect(source("Row.tsx")).toContain("paddingHorizontal: CARD_PAD");
});

test("a small button and a card's footer button are a 34 capsule, their targets grown to 44 above and below only", () => {
  const button = source("Button.tsx");
  expect(button).toContain("const SMALL = { height: 34, radius: RADIUS.full, padding: 14");
  // Touch first: every button a capsule, the wide one 50; primary the ink, solid; secondary the tonal fill.
  expect(button).toContain('md: { height: 50, radius: RADIUS.full, padding: 22, text: "headline", icon: 18 },');
  expect(button).toContain("{ backgroundColor: colors.tonal }");
  expect(button).not.toContain("LinearGradient");
  expect(button).toMatch(/card: SMALL,\s*sm: SMALL,/);
  expect(button).toContain("const grow = (TOUCH - height) / 2;");
  expect(button).toContain("return grow > 0 ? { top: grow, bottom: grow } : undefined;");
  expect(button).toContain("hitSlop={slopOf(s.height)}");
  expect(source("HoldButton.tsx")).toContain("hitSlop={slopOf(s.height)}");
  // Nothing sizes a button of its own past the kit's sizes.
  const sized = files(SRC).filter((f) => /<(Button|HoldButton)\b[^>]*\bminHeight/.test(readFileSync(f, "utf8")));
  expect(sized.map((f) => relative(SRC, f))).toEqual([]);
});

test("a chip's label wraps inside it instead of ending in …, its icon on the first line; one line is the 24 pill", () => {
  const chip = source("Chip.tsx");
  const label = chip.slice(chip.indexOf("<RNText maxFontSizeMultiplier"), chip.indexOf("{label}"));
  expect(label).not.toContain("numberOfLines");
  expect(chip).toContain('alignItems: "flex-start"');
  expect(chip).toContain("paddingVertical: (HEIGHT - LINE) / 2");
  expect(chip).toContain("borderRadius: HEIGHT / 2");
  expect(chip).toContain('<View style={{ height: line, justifyContent: "center" }}>');
});

test("an icon button in a row or a heading is the toolbar's 32, its target still a finger's 44", () => {
  const button = source("IconButton.tsx");
  expect(button).toContain("const side = small ? TOOL_H : SIZE;");
  expect(button).toContain("hitSlop={small ? (TOUCH - TOOL_H) / 2 : 4}");
});

test("a strip that scrolls sideways under a screen's title runs edge to edge, its first item on the title's line", () => {
  expect(source("Filters.tsx")).toContain("paddingHorizontal: SCREEN_X");
  const tasks = readFileSync(join(SRC, "features/issues/IssuesScreen.tsx"), "utf8");
  expect(tasks).toContain("paddingLeft: SCREEN_X");
  expect(tasks).toContain("width - PEEK - SCREEN_X");
});

test("no screen keeps a 20-point side of its own: screens read SCREEN_X and cards CARD_PAD", () => {
  // A button's own padding isn't a screen's side.
  const NOT_A_SIDE = new Set(["ui/Button.tsx"]);
  const offenders = files(SRC)
    .filter((path) => !NOT_A_SIDE.has(relative(SRC, path)))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /\b(padding|paddingHorizontal|marginHorizontal): 20\b/.test(line) ? [`${relative(SRC, path)}:${i + 1}`] : [],
        ),
    );
  expect(offenders).toEqual([]);
});

test("a group's header can carry an ⓘ for the whole group, its text under the header", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).toMatch(/export function GroupedHeader\(\{ children, aside, hint \}/);
  expect(grouped).toContain('useInfoHint({ ...hint, variant: "footnote" })');
});

test("a row's ⓘ sits right after its label, and a short fact about its value goes on the value's line", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).toContain("<Row {...props} said={hint.text} labelAfter={info.button} />");
  // A labeled field's ⓘ never shares the label's column (a two-word label broke in two lines): after the value.
  expect(grouped).toMatch(/\{children\}\n\s+<\/View>\n\s+\{info\.button\}/);
  expect(grouped).toMatch(/<View style=\{styles\.labelLine\}>\s*<Text variant="body"/);
  expect(grouped).toMatch(
    /\{valueNote \? \(\s*<Text variant="footnote" numberOfLines=\{1\} style=\{\{ color: c\.label2 \}\}>/,
  );
});

test("no screen keeps a grouped row of its own at the old 50: its rows and fields read GROUPED_ROW", () => {
  // Not a grouped list's rows: the chat's receipt cards (a 50 row around a 32 action) and a new channel's bordered name
  // field. The sheets' bars are the kit's `SheetBar` now.
  const CARD_ROWS = new Set([
    "features/chat/TeamChecks.tsx",
    "features/chat/ReachLines.tsx",
    "features/new/NewChannelForm.tsx",
  ]);
  const offenders = files(join(SRC, "features"))
    .filter((path) => !CARD_ROWS.has(relative(SRC, path)))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) => (/\bminHeight: 50\b/.test(line) ? [`${relative(SRC, path)}:${i + 1}`] : [])),
    );
  expect(offenders).toEqual([]);
});
