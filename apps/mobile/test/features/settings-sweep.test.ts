import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
/** The source with every run of white space as one space, for checks across a formatter's line breaks. */
const flat = (file: string) => src(file).replace(/\s+/g, " ");
const route = (file: string) => join(import.meta.dir, "../../app/(app)/(main)", file);

describe("the workspace's settings: one header standard", () => {
  test("a list of places to go takes the pushed lists' large title, a form keeps the compact bar", () => {
    const parts = flat("features/settings/parts.tsx");
    expect(parts).toContain("return props.largeTitle ? <LargeTitlePage {...props} /> : <CompactPage {...props} />;");
    expect(parts).toContain("<PushedLargeTitle title={title} grouped");
    for (const file of [
      "features/settings/WorkspaceScreen.tsx",
      "features/settings/SkillsScreen.tsx",
      "features/settings/AuditScreen.tsx",
    ])
      expect({ file, large: /<SettingsPage\s+title=\{t\("[^"]+"\)\}\s+largeTitle/.test(src(file)) }).toEqual({
        file,
        large: true,
      });
  });

  test("no page draws a heading of its own over its groups", () => {
    // A section's name is a group header (with its ⓘ), never a headline drawn over the groups.
    for (const file of ["features/settings/AccessScreen.tsx", "features/settings/GeneralScreen.tsx"]) {
      const text = src(file);
      expect({ file, drawn: /variant="(display|display2|title)"/.test(text) }).toEqual({ file, drawn: false });
    }
    // The bar names Apagar conta: no large title of its own under it.
    expect(src("features/me/DeleteAccountScreen.tsx")).not.toContain('variant="display"');
    // General's context is a field of the form: a group header with its ⓘ.
    expect(flat("features/settings/GeneralScreen.tsx")).toContain(
      '<GroupedHeader hint={{ name: t("common.about", { label: contextTitle }),',
    );
  });

  test("content that loads shows the rows' shape, never a bare spinner", () => {
    for (const file of [
      "features/settings/AccessScreen.tsx",
      "features/settings/AppsScreen.tsx",
      "features/settings/AuditScreen.tsx",
      "features/settings/ComputersScreen.tsx",
      "features/settings/GeneralScreen.tsx",
      "features/settings/MachineScreen.tsx",
      "features/settings/MediaSettingsScreen.tsx",
      "features/settings/SkillsScreen.tsx",
      "features/settings/StorageScreen.tsx",
      "features/me/DeleteAccountScreen.tsx",
      "features/outages/SwitchComputerSheet.tsx",
    ]) {
      const text = src(file);
      expect({ file, spinner: text.includes("<ActivityIndicator") }).toEqual({ file, spinner: false });
      expect({ file, skeleton: text.includes("<SkeletonList") }).toEqual({ file, skeleton: true });
    }
    // What didn't load says so, with the way to ask again.
    expect(flat("features/settings/MachineScreen.tsx")).toContain(
      "<LoadFailed onRetry={() => void machines.refetch()} />",
    );
    expect(flat("features/me/DeleteAccountScreen.tsx")).toContain("<LoadFailed onRetry={() => void plan.refetch()} />");
    expect(flat("features/me/PreferencePages.tsx")).toContain("<LoadFailed onRetry={() => void prefs.refetch()} />");
    expect(flat("features/me/ApprovalsPage.tsx")).toContain("<LoadFailed onRetry={() => void covers.refetch()} />");
  });
});

describe("choosing: pushed pickers and the app's short menu, never a list grown in place", () => {
  test("an agent's level of access is picked from its levels, the one in use checked", () => {
    const access = flat("features/settings/AccessScreen.tsx");
    expect(access).toMatch(
      /r\.levels\.map\(\(level\) => \(\{ label: t\(`access\.level\.\$\{level\}`\), checked: level === current,/,
    );
    expect(access).toContain("menu disabled={busyAgents.has(a.id)} onPress={() => chooseLevel(a, r, name, level)}");
    expect(access).not.toContain("nextLevel");
  });

  test("the audit's agent is picked on the shared agent picker's screen and taken off with the row's ×", () => {
    const audit = flat("features/settings/AuditScreen.tsx");
    expect(audit).toContain(
      'openAgentPick({ agentId, apply: setAgentId, title: t("audit.agent"), note: "", everyone: true }); router.push("/agent-pick");',
    );
    expect(audit).toContain("useEffect(() => closeAgentPick, []);");
    expect(audit).toContain('remove: { label: t("audit.anyAgent"), onPress: () => setAgentId(null) }');
    expect(audit).not.toContain("pickOne(");
  });

  test("a skill's change opens on a screen of its own, never inside the history's card", () => {
    const skills = flat("features/settings/SkillsScreen.tsx");
    expect(skills).toContain(
      'router.push({ pathname: "/settings/skills/change", params: { id: skillId, change: c.id } })',
    );
    expect(skills).toContain("export function SkillChangeScreen(");
    expect(skills).not.toContain("setOpen(");
    expect(existsSync(route("settings/skills/change.tsx"))).toBe(true);
  });

  test("Idioma is a pushed list; the dead Sons and Aparência screens are gone", () => {
    expect(flat("features/me/MeScreen.tsx")).toContain('chevron onPress={() => open("/me/language")}');
    expect(existsSync(route("me/sounds.tsx"))).toBe(false);
    expect(existsSync(route("me/appearance.tsx"))).toBe(false);
    const pages = src("features/me/PreferencePages.tsx");
    expect(pages).not.toContain("export function SoundsPage(");
    expect(pages).not.toContain("export function AppearancePage(");
  });

  test("a row that opens a sheet of actions shows the three dots, one that changes its value the up-down mark", () => {
    const machine = flat("features/settings/MachineScreen.tsx");
    expect(machine).toContain("{...(pausedNow ? {} : { more: true })}");
    expect(machine).toContain("? { more: true, onPress: () => chooseAction(");
    expect(machine).not.toContain('value={t("machines.access.remove")}');
    expect(flat("features/status/StatusScreen.tsx")).toContain(
      'label={t("presence.clearAfter")} value={untilLabel(d.until)} menu onPress={pickUntil}',
    );
    expect(flat("features/status/StatusScreen.tsx")).toContain('chooseAction( t("presence.clearAfter"),');
  });
});

describe("the standard components, never look-alikes", () => {
  test("presses are the design system's", () => {
    for (const file of [
      "features/me/AccountPage.tsx",
      "features/me/AppIconPage.tsx",
      "features/me/ChatLookPage.tsx",
      "features/me/MeScreen.tsx",
      "features/settings/GeneralScreen.tsx",
    ]) {
      const text = src(file);
      expect({ file, handRolled: text.includes("<Pressable") }).toEqual({ file, handRolled: false });
    }
  });

  test("Status: the line in a grouped card, the suggestions as the app's chips", () => {
    const status = flat("features/status/StatusScreen.tsx");
    expect(status).toContain("<GroupedList> <View style={styles.field}>");
    expect(status).toContain("<Filters items={STATUS_SUGGESTIONS.map((s) => ({");
    expect(status).not.toContain("<ScrollView");
    expect(status).not.toContain("shadows.e1");
  });

  test("chips that scroll run to the screen's edges, their first one where the groups start", () => {
    expect(flat("features/settings/AuditScreen.tsx")).toContain("<View style={styles.bleed}> <Filters");
    expect(src("features/settings/AuditScreen.tsx")).toContain("bleed: { marginHorizontal: -SCREEN_X },");
    expect(src("features/settings/SkillsScreen.tsx")).toContain(
      "bleed: { paddingTop: 10, marginHorizontal: -SCREEN_X },",
    );
  });

  test("forms ask before leaving with changes", () => {
    expect(src("features/settings/SkillsScreen.tsx")).toContain("const leave = useUnsavedGuard(dirty);");
  });

  test("the mode switch is docked under its page", () => {
    expect(flat("features/settings/ModeScreen.tsx")).toContain("{...(editable ? { bottom: ( <Button");
  });
});

describe("motion within the gate", () => {
  test("Você's horizon: built once, under 300 ms, a fade with reduced motion", () => {
    const me = flat("features/me/MeScreen.tsx");
    expect(me).toContain("const HORIZON_RISE = Array.from({ length: HORIZON }, (_, i) => FadeInUp.duration(280)");
    expect(me).toContain(
      "const enter = (i: number) => (!rise ? undefined : reducedMotion ? HORIZON_FADE : HORIZON_RISE[i]);",
    );
    expect(me).not.toMatch(/entering=\{[^}]*\.duration\(/);
  });
});
