import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownOptionsOf } from "../main-stack";

const read = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("the agent's computer and a browser profile's live view are pushed screens", () => {
  test("pushed with the opaque bar, never a modal the app's sheets, pickers and toasts would open under", () => {
    expect(ownOptionsOf("computer/[agentId]")).toBe("solid,");
    expect(ownOptionsOf("browser-profile/[profileId]")).toBe("solid,");
  });

  test("their bars are the native bar: no close button or title of their own, no toast host of their own", () => {
    for (const file of ["computer/ComputerScreen.tsx", "browser/ProfileLoginScreen.tsx"]) {
      const screen = read(file);
      expect(screen).toContain("<PushedHeader");
      expect(screen).not.toContain("ToastHost");
      expect(screen).not.toContain('icon="x" plate');
      expect(screen).not.toContain("insets.top");
    }
    const computer = read("computer/ComputerScreen.tsx");
    // The conversation's pill is the bar's title; what the agent keeps running is the bar's own button.
    expect(computer).toMatch(/<PushedHeader\s+title=\{\s*<HeaderPill/);
    expect(computer).toContain("{...(kept.action ? { actions: [kept.action] } : {})}");
    expect(read("computer/KeptRunning.tsx")).toContain('sf: "play.circle"');
    expect(read("computer/KeptRunning.tsx")).not.toContain("IconButton");
  });

  test("sideways the picture takes the phone, and in control the edge swipe is the trackpad's", () => {
    const screen = read("computer/AgentScreen.tsx");
    expect(screen).toContain("useMemo(() => ({ headerShown: !wide, gestureEnabled: !inControl }), [wide, inControl])");
    expect(screen).toContain("<Stack.Screen options={barOptions} />");
    // Any other stage gives the bar and the swipe back, whatever the agent's screen left.
    const computer = read("computer/ComputerScreen.tsx");
    expect(computer).toContain("const BAR_SHOWN = { headerShown: true, gestureEnabled: true };");
    expect(computer).toContain("<Stack.Screen options={BAR_SHOWN} />");
  });

  test("under the bar, the keys and the trackpad still clear the keyboard", () => {
    expect(read("computer/AgentScreen.tsx")).toContain(
      '<KeyboardAvoidingView behavior="padding" style={styles.fill} automaticOffset>',
    );
  });
});

describe("lists load, fail and empty in the app's own states", () => {
  test("loading shows the rows' shape, never a bare spinner", () => {
    for (const file of [
      "members/MembersPage.tsx",
      "members/JoinRequestsScreen.tsx",
      "devices/DevicesScreen.tsx",
      "devices/AudienceScreen.tsx",
      "devices/PhoneScreen.tsx",
      "connectors/ConnectionScreen.tsx",
      "connectors/ToolsScreen.tsx",
      "connectors/ToolReview.tsx",
      "connectors/MailboxSheet.tsx",
    ]) {
      const code = read(file);
      expect(`${file}: ${code.includes("ActivityIndicator")}`).toBe(`${file}: false`);
      expect(code.includes("<RowBones") || code.includes("<SkeletonList")).toBe(true);
    }
  });

  test("a list that didn't load says so with a way to ask again, never a footer, a note or a blank page", () => {
    for (const file of [
      "members/InvitesScreen.tsx",
      "members/InviteEdit.tsx",
      "devices/DevicesScreen.tsx",
      "devices/AudienceScreen.tsx",
      "devices/PhoneScreen.tsx",
      "connectors/ConnectorsScreen.tsx",
      "connectors/ConnectionScreen.tsx",
      "connectors/MailboxSheet.tsx",
      "browser/ProfileLoginScreen.tsx",
    ])
      expect(read(file)).toContain("<LoadFailed onRetry=");
    expect(read("members/InviteEdit.tsx").match(/<LoadFailed onRetry=/g)?.length).toBe(2);
    expect(read("connectors/ConnectorsScreen.tsx")).not.toContain("mobile.connectors.loadFailed");
    expect(read("members/InvitesScreen.tsx")).not.toContain('icon="replay" label={t("common.retry")}');
  });

  test("empty is the empty state's words, never a card drawn for it", () => {
    const devices = read("devices/DevicesScreen.tsx");
    expect(devices).toContain('<EmptyState size="inline" title={t(copy.title)} subtitle={t(copy.text)} />');
    expect(devices).not.toContain("styles.empty");
    const gallery = read("connectors/ConnectorsScreen.tsx");
    expect(gallery).toMatch(/<FirstUse\s+place="connectors"\s+acts=\{mayAdd\}\s+size="inline"/);
    expect(gallery).not.toContain("EmptyHint");
  });
});

describe("every button does something the person sees", () => {
  test("a copy the system refused says so", () => {
    for (const file of [
      "members/InvitesScreen.tsx",
      "members/InviteSheets.tsx",
      "members/InvitePeople.tsx",
      "members/InviteEdit.tsx",
    ]) {
      const code = read(file);
      expect(code).not.toMatch(/if \(!ok\) return;/);
      expect(code).not.toContain("!(await copyText(url))) return;");
      expect(code).toContain('toast({ title: t("mobile.app.failed"), icon: "x" })');
    }
  });

  test("Try now and Stop waiting say what they did: a device still away changes nothing on the card", () => {
    const wait = read("devices/DeviceWait.tsx");
    expect(wait).toContain('t(action === "retry" ? "mobile.devices.wait.tried" : "mobile.devices.wait.stopped", {');
  });

  test("presses are the kit's: no pressable dimmed by hand where a standard control exists", () => {
    for (const file of ["computer/SetupWait.tsx", "browser/HandoffCard.tsx", "browser/parts.tsx"])
      expect(read(file)).not.toContain("<Pressable");
    const card = read("browser/BrowserCard.tsx");
    expect(card).toContain('<IconButton icon="stop" small label={t("mobile.browser.card.stop")} onPress={stop} />');
    expect(card).toContain('<Button variant="text" size="sm" label={t("browser.inCard.addNote")}');
    expect(card).not.toContain("pressedWord");
    const gallery = read("connectors/ConnectorsScreen.tsx");
    expect(gallery).not.toContain("styles.pressed");
    // A list row of the kit, which lights a beat late so a scroll never flashes it.
    expect(gallery).toContain("<RowPressable");
    const sheet = read("connectors/ConnectSheet.tsx");
    expect(sheet).toMatch(/<Button\s+variant="secondary"\s+size="sm"\s+label=\{t\("mobile\.connectors\.paste"\)\}/);
    expect(sheet).not.toContain("styles.paste");
  });
});

describe("rows and fields are the kit's", () => {
  test("a phone's name is a field row as the account's name is, never a row drawn for it", () => {
    const parts = read("devices/parts.tsx");
    const field = parts.slice(parts.indexOf("export function PhoneNameField"));
    expect(field).toContain("<GroupedField label={label}>");
    expect(field).not.toContain("<Pressable");
    expect(parts).not.toContain("nameRow");
  });

  test("the connect line holds its place while it is made", () => {
    expect(read("devices/ConnectScreen.tsx")).toMatch(
      /\) : make\.isPending \? \(\s*\/\/[^\n]*\n\s*<GroupedList>\s*<RowBones/,
    );
  });
});

describe("sheets read as the app's sheets", () => {
  test("a connector's sheets lead with the sheets' own title", () => {
    for (const file of ["connectors/ConnectSheet.tsx", "connectors/MailboxSheet.tsx"]) {
      const code = read(file);
      expect(code).toContain("<SheetTitle");
      expect(code).not.toContain("styles.head");
      expect(code).not.toContain('<Text variant="title"');
    }
    // Renaming is a pushed screen now (a form: screens, not sheets): the app's one-line field, its help under it.
    const rename = read("connectors/ConnectionScreen.tsx");
    expect(rename).toContain('<GroupedFooter>{t("connectors.renameHelp")}</GroupedFooter>');
    expect(rename).toContain("multiline={false}");
    expect(rename).not.toContain("styles.field");
  });

  test("a mailbox's tools are the next step over its sheet, never its content swapped in place", () => {
    const mailbox = read("connectors/MailboxSheet.tsx");
    expect(mailbox).toContain("sheet.push(");
    expect(mailbox).toContain("<MailReview account={account} onNext={sheet.back} onScreen />");
    expect(mailbox).not.toContain("setTools");
  });

  test("a join request's card fades in and out; nothing stretches its frame as its answer changes", () => {
    const requests = read("members/JoinRequestsScreen.tsx");
    expect(requests).not.toContain("LinearTransition");
    expect(requests).not.toContain("layout=");
  });
});
