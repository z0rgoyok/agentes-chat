import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownOptionsOf } from "../main-stack";

/** The second sweep of the settings, Você, people, devices and connectors screens: keyboard, scroll, bars, navigation. */
const src = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "src", path), "utf8");

describe("the settings and Você page frames", () => {
  test("a form page lets a drag take the keyboard away, and its docked action rides over the keyboard", () => {
    const page = src("features/settings/parts.tsx");
    expect(page).toContain('keyboardDismissMode="interactive"');
    // The docked action sits over the keyboard (over the system's ‹ › bar too) and a focused field stays clear of it.
    expect(page).toContain("<KeyboardStickyView");
    expect(page).toContain("offset={{ opened: insets.bottom - toolbarRoom }}");
    expect(page).toContain("const bar = toolbarRoom + docked;");
    expect(page).toContain("bottomOffset={bar + FIELD_CLEARANCE}");
    // The home indicator's room is the docked bar's, never added twice under the content.
    expect(page).toContain("paddingBottom: bottom ? 24 : 24 + insets.bottom");
    expect(src("features/me/parts.tsx")).toContain('keyboardDismissMode="interactive"');
  });

  test("a list read from the server is read again on a pull, on both frames", () => {
    const page = src("features/settings/parts.tsx");
    expect(page).toContain("onRefresh?: () => Promise<unknown>;");
    expect(page).toContain("<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />");
    // A large-title list with a search makes room for the keyboard.
    expect(page).toContain("keyboard={keyboard}");
    const me = src("features/me/parts.tsx");
    expect(me).toContain("usePullRefresh(onRefresh ?? NOTHING_TO_READ)");
  });
});

describe("no field takes the keyboard as its screen opens", () => {
  test("renaming a computer, a new category, suggesting someone, an invitation's note, a server's address", () => {
    for (const file of [
      "features/settings/MachineScreen.tsx",
      "features/categories/CategoryScreens.tsx",
      "features/members/SuggestPerson.tsx",
      "features/members/InvitePickers.tsx",
      "features/server/ServerAddress.tsx",
      "features/me/WorkspacesPages.tsx",
    ])
      expect({ file, autoFocus: src(file).includes("autoFocus") }).toEqual({ file, autoFocus: false });
  });
});

describe("Workspaces' ways in", () => {
  test("the team's server, while signed in, is a pushed screen with the system's back over its sky", () => {
    expect(ownOptionsOf("me/team-server")).toBe("cover,");
    const pages = src("features/me/WorkspacesPages.tsx");
    const server = pages.slice(pages.indexOf("export function TeamServerPage"));
    expect(server).toContain("<PushedHeader plate />");
    expect(server).not.toContain("onBack=");
  });

  test("Add workspace's sheet closes with ×, never a back arrow that only closes it", () => {
    const pages = src("features/me/WorkspacesPages.tsx");
    expect(pages).toContain('<SheetHeader title={t("mobile.me.addWorkspace")} />');
    expect(pages).not.toContain('icon="back"');
  });
});

describe("requests to join", () => {
  const route = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "app", "(app)", path), "utf8");

  test("a pushed screen with the system's bar, so each card's choices push over it", () => {
    // Out of the sheets: a choice pushed from a sheet would land under it, or close it with the card's draft.
    expect(route("_layout.tsx")).not.toContain('name="join-requests"');
    expect(route("(main)/join-requests.tsx")).toContain("<JoinRequestsScreen focus={request} />");
    expect(ownOptionsOf("join-requests")).toBeNull();
    const screen = src("features/members/JoinRequestsScreen.tsx");
    expect(screen).toContain("<SettingsPage");
    expect(screen).not.toContain("SheetScreen");
    expect(screen).toContain("onRefresh={() => Promise.allSettled([list.refetch(), roles.refetch()])}");
    // An empty list needs no Close of its own: the system's back is there.
    expect(screen).not.toContain("onClose");
  });

  test("denying's reason opens on the tap that asks for it, and its way out is Cancel, never a drawn Back", () => {
    const screen = src("features/members/JoinRequestsScreen.tsx");
    expect(screen).not.toContain('t("mobile.common.back")');
    expect(screen).toContain('label={t("mobile.common.cancel")}');
  });
});

describe("a connection's screen", () => {
  test("its name is said once: the bar's title comes in as the name under the mark scrolls away", () => {
    const screen = src("features/connectors/ConnectionScreen.tsx");
    expect(screen).toMatch(/<PushedHeader\s+title=\{\s*<FadingHeaderTitle/);
    expect(screen).toContain("from={nameBox.top - headerHeight}");
    expect(screen).not.toContain("<PushedHeader title={name}");
  });

  test("renaming is a pushed screen with Save in the bar, and its field waits for a tap", () => {
    const screen = src("features/connectors/ConnectionScreen.tsx");
    expect(screen).toContain('router.push({ pathname: "/connectors/rename", params: { id } })');
    expect(screen).not.toContain("RenameSheet");
    const rename = screen.slice(screen.indexOf("export function RenameConnectionScreen"));
    expect(rename).toContain('action={{ label: t("common.save"), disabled: !ready, onPress: save }}');
    expect(rename).toContain("useUnsavedGuard(");
    expect(rename).not.toContain("autoFocus");
    const route = readFileSync(
      join(import.meta.dir, "..", "..", "app", "(app)", "(main)", "connectors", "rename.tsx"),
      "utf8",
    );
    expect(route).toContain('<RenameConnectionScreen id={id ?? ""} />');
  });
});

describe("lists read again on a pull, and searches make room for the keyboard", () => {
  test("Skills, the audit, invitations, devices, categories and workspaces pull to read again", () => {
    for (const file of [
      "features/settings/SkillsScreen.tsx",
      "features/settings/AuditScreen.tsx",
      "features/members/InvitesScreen.tsx",
      "features/devices/DevicesScreen.tsx",
      "features/categories/CategoryScreens.tsx",
      "features/me/WorkspacesPages.tsx",
    ])
      expect({ file, pull: src(file).includes("onRefresh") }).toEqual({ file, pull: true });
  });

  test("a list with a search under a large title makes room for the keyboard, and a drag takes it away", () => {
    expect(src("features/settings/SkillsScreen.tsx")).toContain("keyboard={searchable}");
    expect(src("features/connectors/ConnectorsScreen.tsx")).toMatch(/\/\/ The search's results[^\n]*\n\s+keyboard\n/);
    const zones = src("features/me/AccountPage.tsx");
    expect(zones).toContain('keyboardDismissMode="on-drag"');
    for (const file of [
      "features/me/DeleteAccountScreen.tsx",
      "features/computer/ComputerScreen.tsx",
      "features/browser/ProfileLoginScreen.tsx",
    ])
      expect({ file, drag: src(file).includes('keyboardDismissMode="interactive"') }).toEqual({ file, drag: true });
  });

  test("Ferramentas is the settings page, its Save docked over the keyboard", () => {
    const tools = src("features/connectors/ToolsScreen.tsx");
    expect(tools).toContain("<SettingsPage");
    expect(tools).not.toContain("<BottomBar");
    expect(tools).not.toContain("<PushedHeader");
  });

  test("a profile's live view and a channel's category show their shape while they load", () => {
    expect(src("features/browser/ProfileLoginScreen.tsx")).toContain("<SkeletonList rows={2} />");
    const pick = src("features/categories/CategoryScreens.tsx");
    const screen = pick.slice(
      pick.indexOf("export function PickCategoryScreen"),
      pick.indexOf("export function NewCategoryScreen"),
    );
    expect(screen).toContain("<SkeletonList rows={3} />");
    expect(screen).toContain("<LoadFailed");
  });
});

describe("forms", () => {
  test("writing a skill walks its fields with the keyboard's bar; editing one too", () => {
    const skills = src("features/settings/SkillsScreen.tsx");
    expect(skills).toContain('toolbar={tab === "write"}');
    expect(skills).toMatch(/minHeight=\{50\}\s+\{\.\.\.NEXT_FIELD\}\s+accessibilityLabel=\{t\("skills\.name"\)\}/);
    const edit = skills.slice(skills.indexOf("export function EditSkillScreen"));
    expect(edit).toMatch(/locked=\{action\.isPending\}[^>]*\btoolbar\b/);
  });

  test("the status line is named for screen readers", () => {
    expect(src("features/status/StatusScreen.tsx")).toContain('accessibilityLabel={t("mobile.status.doing")}');
  });

  test("a workspace computer's address never renders as bare text: ternaries, not `&&`", () => {
    const machine = src("features/settings/MachineScreen.tsx");
    expect(machine).not.toMatch(/\{managed && [^\n]*&& \(/);
    expect(machine).toContain("{moreOpen && egressIp ? (");
  });
});

describe("connecting a device", () => {
  test("Done leaves the whole flow for the devices' list, the computer's page over it", () => {
    const connect = src("features/devices/ConnectScreen.tsx");
    expect(connect).toContain('router.dismissTo("/settings/devices");');
    expect(connect).not.toContain("onPress={() => openComputer(");
    // Both of the flow's Done buttons (a computer by the app, a server by its line).
    expect(connect.match(/onPress=\{\(\) => [^\n]*finishOn\(/g)?.length).toBe(2);
  });
});
