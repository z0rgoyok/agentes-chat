import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ICONS } from "../src/ui/icons.data";
import { SF_SYMBOLS, sfSymbolOf, TILE_TINTS } from "../src/ui/icons.sf";
import { appColors, cardEdge } from "../src/ui/palette";

const src = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");

describe("the system's symbols", () => {
  test("every icon has its system symbol, or says it keeps ours", () => {
    expect(Object.keys(SF_SYMBOLS).sort()).toEqual(Object.keys(ICONS).sort());
    // The system has no drawing of these: our own on every platform.
    for (const ours of [
      "agent",
      "wait",
      "checks",
      "sticker",
      "computerMac",
      "computerWindows",
      "computerLinux",
    ] as const)
      expect(SF_SYMBOLS[ours]).toBeNull();
  });

  test("a tile takes the filled symbol where the system has one, the line one where it doesn't", () => {
    expect(sfSymbolOf("bell")).toBe("bell");
    expect(sfSymbolOf("bell", true)).toBe("bell.fill");
    expect(sfSymbolOf("globe", true)).toBe("globe");
    expect(sfSymbolOf("agent", true)).toBeNull();
  });

  test("Icon draws the symbol on iOS through expo-image, its size and weight in the style", () => {
    const icon = src("src/ui/Icon.tsx");
    expect(icon).toContain("const symbol = IOS ? sfSymbolOf(name, filled) : null;");
    expect(icon).toMatch(/source=\{`sf:\$\{symbol\}`\}/);
    // expo-image reads an `sf:` source's point size and weight off `fontSize` and `fontWeight` (its own props for them
    // are overwritten from the style).
    expect(icon).toContain("fontSize: Math.round(size * SF_POINT_SCALE * 2) / 2,");
    expect(icon).toContain("fontWeight: WEIGHTS[weight],");
    // A symbol an older iOS can't draw falls back to our line icon.
    expect(icon).toContain("onError={() => setFailed(true)}");
  });

  test("the bars show the system's symbols: bar buttons, their menus and the tabs (Agentes keeps our agent)", () => {
    const bar = src("src/ui/headerActions.tsx");
    expect(bar).toContain(
      'const barIcon = ({ sf }: { sf: SFSymbolName }) => ({ type: "sfSymbol" as const, name: sf });',
    );
    expect(bar.match(/icon: barIcon\(a\),/g)).toHaveLength(3);
    expect(bar).toContain('icon: { type: "sfSymbol" as const, name: m.sf },');
    const tabs = src("app/(app)/(main)/(tabs)/_layout.tsx");
    // The inbox's tab (ADR 0218): the system's tray, filled when chosen.
    expect(tabs).toContain('sf: { default: "tray", selected: "tray.fill" },');
    expect(tabs).toContain('{ name: "agents", glyph: "agents", label: "mobile.tabs.agents" },');
    expect(tabs).toContain("{...(tab.sf ? { sf: tab.sf } : {})}");
  });
});

describe("the system's lists", () => {
  test("tiles are the system Settings': one color per subject, the same in both themes", () => {
    const light = appColors("light");
    const dark = appColors("dark");
    expect(dark.tiles).toEqual(light.tiles);
    expect(light.tiles.red).toBe("#ff3b30");
    expect(TILE_TINTS.bell).toBe("red");
    expect(TILE_TINTS.agent).toBe("agent");
    const tile = src("src/ui/IconTile.tsx");
    // A subject's own color, or a row's (`tint`: what always asks for approval is orange), else the system's gray.
    expect(tile).toContain('backgroundColor: colors.tiles[danger ? "red" : (tint ?? TILE_TINTS[icon] ?? "gray")],');
    expect(tile).toContain("<Icon name={icon} size={Math.round(size * glyphShare(icon))} color={ON_TILE} filled />");
    expect(tile).toContain("const glyphShare = (icon: IconName) => (IOS ? 0.73 : MATERIAL_NAMES[icon] ? 0.66 : 0.6);");
    expect(src("src/features/shared/parts.tsx")).toContain(
      "if (icon && children == null) return <IconTile icon={icon} size={size} />;",
    );
  });

  test("a grouped list is flat with the system's corner and the cards' light edge, separator, values and marks", () => {
    const grouped = src("src/ui/Grouped.tsx");
    expect(grouped).not.toContain("boxShadow");
    expect(grouped).toContain('list: { borderRadius: LIST_CORNER, borderCurve: "continuous", overflow: "hidden" },');
    // The ring of the cards' shadow as an outline, so a list and a card read as one family; nothing inside moves.
    expect(grouped).toContain("<View style={[styles.list, { backgroundColor: c.raised }, cardEdge(scheme)]}>");
    expect(cardEdge("dark")).toEqual({
      outlineWidth: 1,
      outlineColor: "rgba(255, 255, 255, 0.1)",
      outlineStyle: "solid",
    });
    expect(cardEdge("light")).toEqual({
      outlineWidth: 0.5,
      outlineColor: "rgba(60, 60, 67, 0.12)",
      outlineStyle: "solid",
    });
    // A header in its own case, semibold, never in capitals; a first letter in lower case (a long date) a capital.
    expect(grouped).not.toContain("toLocaleUpperCase()");
    expect(grouped).toContain(
      'header: { paddingTop: 20, paddingBottom: 8, paddingHorizontal: 16, fontWeight: "600" },',
    );
    expect(grouped.match(/\{headerWords\(children\)\}/g)?.length).toBe(2);
    expect(grouped).toContain("backgroundColor: c.separator,");
    expect(grouped).toContain("<IconTile icon={icon} danger={danger} mark={mark ?? null} />");
    expect(grouped).toContain('<Text variant="body" numberOfLines={1} style={[styles.shrink, { color: c.label2 }]}>');
    for (const mark of ["<Disclosure />", "<MenuMark />", "<CheckMark />"]) expect(grouped).toContain(mark);
    const light = appColors("light");
    expect([light.separator, light.label2, light.label3, light.rowLit]).toEqual([
      "rgba(60, 60, 67, 0.29)",
      "rgba(60, 60, 67, 0.6)",
      "rgba(60, 60, 67, 0.3)",
      "#d1d1d6",
    ]);
  });
});

describe("a row pressed as the system's lists press theirs", () => {
  const row = src("src/ui/RowPressable.tsx");

  test("it lights at once and goes out over 0.3 s, on the opacity only, with no haptic", () => {
    expect(row).toContain("export const ROW_OUT_MS = 300;");
    expect(row).toContain('const LIT: Fade = { opacity: 1, transitionProperty: "opacity", transitionDuration: 0 };');
    expect(row).toContain("transitionDuration: ROW_OUT_MS,");
    expect(row).not.toContain("haptics");
    // A quick tap lights and lifts in one go: it goes out a frame later, so it is seen lit.
    expect(row).toContain("requestAnimationFrame(() => {");
  });

  test("a row that opens a screen stays lit until that screen covers it, never after the way back", () => {
    expect(row).toContain('return navigation.addListener("blur", () => {');
    expect(row).toContain('if (held.current === "waiting") release();');
    expect(row).not.toContain('addListener("focus"');
    expect(row).toContain("wait.current = setTimeout(release, HOLD_WAIT);");
    // The screen's navigation without following its state: a row never redraws when the stack moves.
    expect(row).toContain("const navigation = useContext(NavigationContext);");
    const grouped = src("src/ui/Grouped.tsx");
    expect(grouped).toContain("hold={chevron}");
    expect(grouped).toContain("light={toggle === undefined}");
  });

  test("the kit's rows and the screens' own list rows press this way", () => {
    for (const file of ["src/ui/Grouped.tsx", "src/ui/ListRow.tsx", "src/ui/Row.tsx", "src/features/shared/parts.tsx"])
      expect(src(file)).toContain("<RowPressable");
    for (const file of [
      "src/features/task-manager/TaskManagerScreen.tsx",
      "src/features/team/TeamScreen.tsx",
      "src/features/dashboards/parts.tsx",
      "src/features/chat/MentionPicker.tsx",
      "src/features/chats/HomeSection.tsx",
    ]) {
      const screen = src(file);
      expect(screen).toContain("<RowPressable");
      expect(screen).not.toContain("pressed && { backgroundColor: c.sunken }");
    }
  });
});

describe("the app's shared row data", () => {
  test("stands at the app's root before any workspace is chosen: its reads mount only with one", () => {
    const rows = src("src/features/chat/row-data.tsx");
    // `useOrg` throws until a workspace is chosen, and the root is drawn before that (it crashed the app at launch).
    const root = rows.slice(rows.indexOf("export function WorkspaceRowData"), rows.indexOf("function WorkspaceReads"));
    expect(root).toContain("const org = useOrgMaybe();");
    expect(root).not.toContain("useOrgId()");
    expect(root).toContain(
      "{org ? <WorkspaceReads key={org.orgId} onDirectory={setDir} onPeople={setPeople} /> : null}",
    );
    expect(src("src/providers/AppProviders.tsx")).toContain("<WorkspaceRowData>");
  });
});
