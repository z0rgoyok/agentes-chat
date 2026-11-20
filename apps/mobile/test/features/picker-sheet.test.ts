import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chatScreenSource } from "./chat-screen-source";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("pickers are the app's sheet, never the system's alert list", () => {
  test("one host at the root serves every picker and every action menu, on both systems", () => {
    expect(src("providers/AppProviders.tsx")).toContain("<PickerHost />");
    expect(existsSync(join(import.meta.dir, "../../src/ui/ChoiceHost.tsx"))).toBe(false);
    // The app's sheet first, whatever the system: the system's own only where no host is mounted.
    const choose = src("features/settings/parts.tsx");
    const body = choose.slice(choose.indexOf("export function chooseAction("));
    expect(body.indexOf("if (showActionSheet(title, options)) return;")).toBeLessThan(body.indexOf("Platform.OS"));
    // No screen reaches for the system's action sheet by itself.
    for (const file of [
      "features/dashboards/menu.tsx",
      "features/routines/hooks.tsx",
      "features/files/actions.ts",
      "features/me/parts.tsx",
      "features/work-along/WorkAlong.tsx",
      "features/wiki/WikiScreen.tsx",
    ]) {
      expect({ file, system: src(file).includes("ActionSheetIOS") }).toEqual({ file, system: false });
    }
    // A menu of actions reads as a conversation's "…": its title, then the list with each action's icon.
    const menu = src("features/shared/PickerSheet.tsx");
    expect(menu).toContain("{ask.title ? <SheetTitle title={ask.title} /> : null}");
    expect(menu).toContain("<ActionList");
    const sheet = src("features/shared/PickerSheet.tsx");
    // Faces for people and agents, a tile for icons, the check on the one in use, a search on long lists.
    expect(sheet).toContain('<Face who={{ type: "person", id: lead.userId }} size={36} />');
    expect(sheet).toContain("<AgentFace agentId={lead.agentId} size={36} framed live={live} />");
    expect(sheet).toContain("const SEARCH_FROM = 9;");
    expect(sheet).toContain("haptics.selection();");
  });

  test("the pickers go through pickOne, with who or what each option is", () => {
    // A person for a setor is one of many: chosen on the people's own pushed screen (ADR 0135), each with their photo.
    const sector = src("features/team/SectorScreen.tsx");
    expect(sector).toContain("openPersonChoose({");
    expect(sector).toContain('router.push("/person-choose")');
    expect(sector).not.toContain("pickOne(");
    expect(src("features/team/PersonChooseScreen.tsx")).toContain(
      '<Face who={{ type: "person", id: p.userId }} size={36} live={false} />',
    );
    // The audit's agent is one of many: it is picked on the shared agent picker's pushed screen instead
    // (settings-sweep.test.ts).
    for (const file of [
      "features/me/MeScreen.tsx",
      "features/routines/RoutineForm.tsx",
      "features/computer/usePickComputer.ts",
      "features/vault/VaultConnectScreen.tsx",
      "features/connectors/ToolReview.tsx",
      "features/dashboards/menu.tsx",
    ]) {
      expect({ file, picks: src(file).includes("pickOne({") }).toEqual({ file, picks: true });
    }
    for (const file of ["features/connectors/Access.tsx", "features/connectors/MailboxSheet.tsx"]) {
      expect({ file, picks: src(file).includes("pickLevel(t,") }).toEqual({ file, picks: true });
    }
  });
});

describe("every sheet is the system's own (TrueSheet), and a sheet's next step stacks over it", () => {
  test("the sheet is TrueSheet, sized to its content unless it says otherwise, never one drawn and dragged here", () => {
    const sheet = src("ui/Sheet.tsx");
    expect(sheet).toContain('from "@lodev09/react-native-true-sheet"');
    expect(sheet).toContain('const AUTO: SheetDetent[] = ["auto"];');
    expect(sheet).toMatch(/presentOnMount = false,\s*detents = AUTO,/);
    expect(sheet).toMatch(/return \{\s*\.\.\.look,\s*detents,/);
    expect(sheet).toContain("scrollableRef={scroll}");
    expect(sheet).not.toContain("PanResponder");
    expect(sheet).not.toContain("@gorhom/bottom-sheet");
    // Solid, never see-through: the sheet's gray on every sheet (iOS 26 would draw Liquid Glass without a color).
    expect(sheet).toContain("backgroundColor: inside.grouped,");
    expect(sheet).not.toContain("GLASS");
    // The gestures' root always gets a style: without one it takes flex: 1, no height in a content-sized sheet.
    expect(sheet).toContain("<GestureHandlerRootView style={fill ? styles.fill : styles.fit}>");
  });

  test("a sheet of fixed heights fills them; a picker with a search rests at 70% and takes the screen while typed in", () => {
    const sheet = src("ui/Sheet.tsx");
    expect(sheet).toContain(
      "const props = useSheetProps({ open, onClose, onGone, ref, ...(detents ? { detents } : {}) });",
    );
    expect(sheet).toContain('const fill = !props.detents.includes("auto");');
    expect(sheet).toContain("<SheetContent fill={fill}>");
    expect(sheet).toContain("style={fill ? styles.fill : undefined}");
    // Its pinned header reads the sheet's colors, as its content does.
    expect(sheet).toContain("<OnSheet>{header}</OnSheet>");
    const picker = src("features/shared/PickerSheet.tsx");
    expect(picker).toContain("const SEARCH_DETENTS = [0.7, 1];");
    expect(picker).toContain("const TYPING_DETENTS = [1];");
    expect(picker).toContain("{...(searchable ? { detents: typing ? TYPING_DETENTS : SEARCH_DETENTS } : {})}");
    expect(picker).toContain("onFocus={() => setTyping(true)}");
    expect(picker).toContain("onBlur={() => setTyping(false)}");
    // A new ask starts at rest.
    expect(picker).toMatch(/setQuery\(""\);\s*setTyping\(false\);/);
  });

  test("a pick's bar is the task sheets' bar: × at the left, the title centered; a menu of actions keeps no bar", () => {
    const picker = src("features/shared/PickerSheet.tsx");
    expect(picker).toContain("<SheetBar title={ask.title} onClose={() => finish(null)} />");
    expect(picker).not.toContain('t("mobile.common.cancel")');
    expect(picker).toContain('ask?.mode === "pick" ? (');
  });

  test("the sheets that are routes are TrueSheet's too, on the same look: none is react-native-screens' form sheet", () => {
    const root = (path: string) => readFileSync(join(import.meta.dir, "../../app", path), "utf8");
    const app = root("(app)/_layout.tsx");
    expect(app).toContain('from "@lodev09/react-native-true-sheet/navigation/expo-router"');
    expect(app).toContain('<Sheet.Screen name="(main)" />');
    for (const name of ["new", "approval/[id]", "consultation/[id]", "chart", "code", "me/add-workspace"]) {
      expect({ name, sheet: app.includes(`<Sheet.Screen name="${name}"`) }).toEqual({ name, sheet: true });
    }
    expect(root("(auth)/_layout.tsx")).toContain('<Sheet.Screen name="where" options={sheet(["auto"])} />');
    expect(src("ui/Sheet.tsx")).toContain("export function useRouteSheetOptions()");
    expect(src("ui/navigation.tsx")).not.toContain('presentation: "formSheet"');
  });

  test("a step is a sheet over the one before: forward with push, back with back() or a flick down", () => {
    const host = src("features/shared/SheetHost.tsx");
    expect(host).toContain("<TrueSheet ref={ref} {...props} scrollableRef={scroll}>");
    expect(host).toContain("presentOnMount: true");
    const chat = chatScreenSource();
    for (const next of ["sheet.push(<PinsSheet", "sheet.push(<ConversationSearch"]) {
      expect({ next, pushed: chat.includes(next) }).toEqual({ next, pushed: true });
    }
    // Managing who is in a channel is screens pushed over the conversation, never sheet steps.
    expect(chat).not.toContain("<ChannelMembersSheet");
    const members = src("features/chat/ChannelMembers.tsx");
    expect(members).not.toContain("useSheet");
    expect(members).toContain("router.push(channelMembersHrefs.agent(channelId, w.id))");
    expect(members).toContain("router.push(channelMembersHrefs.add(channelId))");
  });
});
