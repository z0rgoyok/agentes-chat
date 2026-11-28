import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockGap,
  fitTableColumns,
  TABLE_LINK_MAX,
  TABLE_LINK_MIN,
  TABLE_TEXT_MIN,
  TEXT_RHYTHM,
} from "../../src/features/chat/logic";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");
const sum = (widths: number[]) => widths.reduce((a, b) => a + b, 0);

describe("a table fits its box before it scrolls", () => {
  test("room to spare goes to the text columns, so the rows run the box's width", () => {
    const { widths, scrolls } = fitTableColumns([40, 180, 90], ["index", "text", "short"], 360);
    expect(scrolls).toBe(false);
    expect(widths).toEqual([40, 230, 90]);
  });

  test("with no text column, every column but the count takes the room", () => {
    const { widths } = fitTableColumns([40, 100, 100], ["index", "number", "short"], 300);
    expect(widths[0]).toBe(40);
    expect(sum(widths)).toBe(300);
  });

  test("too wide, the text columns wrap first, then the links are cut, and the table fits", () => {
    // The phone's case: a count, a long name and a site, wider than the conversation.
    const { widths, scrolls } = fitTableColumns([40, 280, 200], ["index", "text", "link"], 361);
    expect(scrolls).toBe(false);
    expect(sum(widths)).toBe(361);
    expect(widths[2]).toBeLessThanOrEqual(TABLE_LINK_MAX);
    expect(widths[1]).toBeGreaterThanOrEqual(TABLE_TEXT_MIN);
  });

  test("numbers and short words never give way; past every floor it scrolls", () => {
    const natural = [280, 150, 200, 110, 90, 120];
    const kinds = ["text", "short", "link", "number", "number", "short"] as const;
    const { widths, scrolls } = fitTableColumns(natural, kinds, 361);
    expect(scrolls).toBe(true);
    expect(widths).toEqual([TABLE_TEXT_MIN, 150, TABLE_LINK_MIN, 110, 90, 120]);
  });

  test("the floors grow with the person's text size; with no box yet the drawn widths stand", () => {
    const big = fitTableColumns([400, 400], ["text", "text"], 300, 1.5);
    expect(big.widths).toEqual([TABLE_TEXT_MIN * 1.5, TABLE_TEXT_MIN * 1.5]);
    expect(fitTableColumns([90, 300], ["short", "link"], 0).widths).toEqual([90, TABLE_LINK_MAX]);
  });

  test("the table's first column stands still and a scroll rests at a column's start", () => {
    const spans = src("features/chat/MessageSpans.tsx");
    expect(spans).toContain('const standing = scrolls ? (kinds[0] === "index" && header.length > 2 ? 2 : 1) : 0;');
    expect(spans).toContain("snapToOffsets={snaps}");
    expect(spans).toContain("const fitted = fitTableColumns(widths, kinds, frame, fontScale);");
  });

  test("a message's table is the code card's frame, with copy, full screen and its first rows", () => {
    const card = src("features/chat/TableCard.tsx");
    expect(card).toContain('<CopyButton text={tsv} label={t("mobile.table.copy")} />');
    expect(card).toContain("<FullScreenButton onPress={open} />");
    expect(card).toContain("rows.slice(0, TABLE_PREVIEW_ROWS)");
    expect(src("features/chat/MessageText.tsx")).toContain(
      "<TableCard header={b.header} rows={b.rows} align={b.align} />",
    );
  });
});

describe("a message's text has room by what each block follows", () => {
  test("12 between blocks, a list's items 6 apart and 8 under their sentence, a heading 20 over and 4 under", () => {
    expect(blockGap(undefined, "paragraph")).toBe(0);
    expect(blockGap("paragraph", "paragraph")).toBe(TEXT_RHYTHM.block);
    expect(blockGap("paragraph", "bullet")).toBe(TEXT_RHYTHM.intoList);
    expect(blockGap("bullet", "bullet")).toBe(TEXT_RHYTHM.item);
    expect(blockGap("bullet", "paragraph")).toBe(TEXT_RHYTHM.block);
    expect(blockGap("paragraph", "heading")).toBe(TEXT_RHYTHM.heading);
    expect(blockGap("heading", "bullet")).toBe(TEXT_RHYTHM.underHeading);
    expect(blockGap("table", "paragraph")).toBe(TEXT_RHYTHM.block);
  });

  test("a lighter bold, code on the plate and someone's bubble holding a table out to the screen's margin", () => {
    const spans = src("features/chat/MessageSpans.tsx");
    expect(spans).toContain('bold: { fontWeight: "600" },');
    expect(spans).toContain("{ backgroundColor: c.plate, color: c.ink2 }");
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain(
      'const wide = useMemo(() => bubbled && Boolean(body) && hasWideBlock(body ?? ""), [bubbled, body]);',
    );
    expect(row).toContain('wideBubble: { alignSelf: "stretch", marginRight: -(BUBBLES_END - BUBBLES_EDGE) },');
  });
});
