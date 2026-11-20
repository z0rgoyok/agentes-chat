import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../src", path), "utf8");

describe("one bar for the task sheets", () => {
  test("the code, the chart, New, Share and a pick have the kit's bar; a form's header is the same bar inset", () => {
    const bar = src("ui/SheetBar.tsx");
    expect(bar).toContain('label={icon === "x" ? t("mobile.common.close") : t("mobile.common.back")}');
    expect(bar).toContain("edge: { paddingTop: SHEET_BAR.top, paddingHorizontal: SHEET_X },");
    expect(bar).toContain('row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: SHEET_BAR.height },');
    expect(src("features/chat/CodeCard.tsx")).toMatch(/<SheetBar\s+title=\{codeLabel\(code\.lang\)/);
    expect(src("features/chat/CodeCard.tsx")).toContain("trailing={<CopyButton text={code.text} plate />}");
    expect(src("features/chat/ChartCard.tsx")).toContain("<SheetBar onClose={() => router.back()} />");
    expect(src("features/new/NewScreen.tsx")).toContain('<SheetBar title={t("mobile.new.title")} onClose={cancel} />');
    expect(src("features/share/ShareScreen.tsx")).toContain(
      '<SheetBar title={t("mobile.share.title")} onClose={cancel} />',
    );
    // A form's header closes its sheet (×); none draws a back inside a sheet.
    expect(src("features/new/parts.tsx")).toContain(
      "<SheetBar inset title={title} onClose={onPress ?? (() => goBack())} />",
    );
    // None keeps a bar of its own.
    for (const file of ["features/new/NewScreen.tsx", "features/share/ShareScreen.tsx"]) {
      expect({ file, own: src(file).includes("function SheetBar(") }).toEqual({ file, own: false });
      expect({ file, cancel: src(file).includes('t("mobile.common.cancel")') }).toEqual({ file, cancel: false });
    }
  });

  test("New and Share grow to the whole screen while typed in, through TrueSheet's own detents", () => {
    for (const file of ["features/new/NewScreen.tsx", "features/share/ShareScreen.tsx"]) {
      const screen = src(file);
      expect({ file, sheet: screen.includes("const navigation = useTrueSheetNavigation();") }).toEqual({
        file,
        sheet: true,
      });
      expect({
        file,
        set: screen.includes("navigation.setOptions({ detents: typing ? DETENTS_TYPING : DETENTS_REST });"),
      }).toEqual({ file, set: true });
      expect({ file, screens: screen.includes("sheetAllowedDetents") }).toEqual({ file, screens: false });
    }
  });
});
