import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
/** The source with every run of white space as one space, for checks across a formatter's line breaks. */
const flat = (file: string) => src(file).replace(/\s+/g, " ");

describe("a switch moves as it is tapped", () => {
  test("the workspace's settings change in the cache at once (the shared hook), so no row waits on the server", () => {
    // The hook's own behaviour is tested in the client package (update-settings.test.ts); General reads it as is.
    const general = flat("features/settings/GeneralScreen.tsx");
    expect(general).toContain("toggle={settings.data?.actionCheck ?? true}");
    // The usage report's switch shows the value on its way, and is never turned off while it saves.
    expect(general).toContain(
      "const on = (set.isPending ? set.variables : undefined) ?? (data.enabled && !data.envOff);",
    );
    expect(general).toContain("toggle={on} disabled={data.envOff}");
  });

  test("skills and a computer's switches show the pending value and stay pressable", () => {
    const skills = flat("features/settings/SkillsScreen.tsx");
    expect(skills).toContain(
      'action.isPending && action.variables?.type === "settings" ? action.variables.settings : undefined',
    );
    expect(skills).toContain("toggle={improves}");
    expect(skills).toContain("toggle={autoUpdate}");
    expect(skills).toContain("const saving = pendingPatch(action, s.id)?.agentsImprove;");
    for (const row of ["toggle={improves}", "toggle={autoUpdate}", "toggle={on}"]) {
      const at = skills.indexOf(row);
      expect({
        row,
        waits: skills.slice(at, skills.indexOf("/>", at)).includes("disabled={action.isPending}"),
      }).toEqual({ row, waits: false });
    }
    const computer = flat("features/devices/ComputerSection.tsx");
    expect(computer).toContain("(spill.isPending ? spill.variables?.[key] : undefined) ?? d.spill[key]");
    expect(computer).toContain(
      "const belongs = (mark.isPending ? mark.variables : undefined) ?? d.belongsToWorkspace;",
    );
    expect(computer).not.toContain("disabled={mark.isPending}");
    expect(computer).not.toContain("spill.isPending ||");
  });
});

describe("a list that didn't load says so, with the way to ask again", () => {
  test.each([
    ["features/settings/AppsScreen.tsx", "list.refetch()"],
    ["features/settings/MediaSettingsScreen.tsx", "settings.refetch()"],
    ["features/settings/StorageScreen.tsx", "storage.refetch()"],
    ["features/settings/AuditScreen.tsx", "audit.refetch()"],
    ["features/settings/SkillsScreen.tsx", "skills.refetch()"],
    ["features/vault/VaultScreen.tsx", "vault.refetch()"],
    ["features/vault/VaultItemScreen.tsx", "item.refetch()"],
    ["features/usage/UsageScreen.tsx", "usage.refetch()"],
  ])("%s", (file, refetch) => {
    const text = flat(file);
    expect(text).toContain(`<LoadFailed onRetry={() => void ${refetch}} />`);
    expect(text).not.toContain('<Note icon="x">{t("common.loadFailed")}</Note>');
  });

  test("coming back on a network reads again what went stale, and requests still go out with none", () => {
    const query = flat("providers/query.ts");
    expect(query).toContain("onlineManager.setEventListener((setOnline) => {");
    expect(query).toContain("Network.addNetworkStateListener((state) => setOnline(state.isConnected !== false))");
    expect(query).toContain("void Network.getNetworkStateAsync()");
    expect(query).toContain("return () => sub.remove();");
    expect(query).toContain("bindOnlineToNetwork(); return new LiveQueryClient(");
    // Nothing waits paused for a network: a screen still says it couldn't load, a change still says it failed.
    expect(query).toContain('refetchOnWindowFocus: false, networkMode: "always", }');
    expect(query).toContain('mutations: { retry: 0, networkMode: "always" }');
  });
});

describe("what changes a picture shows it", () => {
  test("a photo or a logo uploading: a spinner over it, where it changes", () => {
    const parts = src("features/settings/parts.tsx");
    expect(parts).toContain("export function Uploading({ style }: { style: ViewStyle })");
    expect(flat("features/me/MeScreen.tsx")).toContain(
      '<PersonAvatar name={name || "?"} size={PHOTO} photo={photo} /> {uploading ? <Uploading style={styles.photoBusy} /> : null}',
    );
    expect(flat("features/me/AccountPage.tsx")).toContain(
      '<PersonAvatar name={draft.name || "?"} size={PHOTO} photo={photo} /> {uploading ? <Uploading style={styles.photoBusy} /> : null}',
    );
    expect(flat("features/settings/GeneralScreen.tsx")).toContain(
      "<OrgAvatar logo={org?.logo} size={LOGO} /> {uploading ? <Uploading style={styles.logoBusy} /> : null}",
    );
    // Your photo on Você no longer fades the whole button while it uploads: the spinner says it, and the press is the
    // design system's (it gives a little under the finger).
    expect(flat("features/me/MeScreen.tsx")).toContain(
      "<PressScale onPress={changePhoto} disabled={uploading} fill={false}",
    );
    expect(flat("features/me/MeScreen.tsx")).not.toContain("opacity: 0.6");
  });
});

describe("leaving and deleting ask through the app's one confirmation", () => {
  test("signing out and deleting the workspace use `confirmAction`, never an alert of their own", () => {
    for (const file of ["features/me/MeScreen.tsx", "features/settings/WorkspaceScreen.tsx"]) {
      const text = src(file);
      expect({ file, alert: text.includes("Alert.alert(") }).toEqual({ file, alert: false });
      expect({ file, confirms: text.includes("confirmAction({") }).toEqual({ file, confirms: true });
    }
  });
});

describe("who approves for me: one row and the app's picker", () => {
  test("a menu row opens the picker with a search, No one first, each person with their photo", () => {
    const page = flat("features/me/ApprovalsPage.tsx");
    expect(page).toContain('label={t("approvalCover.person")} value={coverName}');
    expect(page).toContain("menu onPress={pickCover}");
    expect(page).toContain(
      'void pickOne({ title: t("approvalCover.title"), value: cover?.userId || NOBODY, search: true,',
    );
    expect(page).toContain('{ key: NOBODY, label: t("approvalCover.nobody"), leading: { kind: "icon", name: "x" } }');
    expect(page).toContain('leading: { kind: "person" as const, userId: m.userId }');
    // No longer every member as a row of the page.
    expect(page).not.toContain("{people.map((m) => ( <GroupedRow");
  });
});

describe("a countdown repaints only itself", () => {
  test.each([
    ["features/auth/InviteSteps.tsx", "function ResendLine("],
    ["features/auth/InviteScreen.tsx", "function ProofSlot("],
    ["features/devices/AndroidSetupScreen.tsx", "function SlowHelp("],
    ["features/settings/parts.tsx", "export function ResendCode("],
  ])("%s keeps its clock in %s", (file, leaf) => {
    const text = src(file);
    const at = text.indexOf(leaf);
    expect(at).toBeGreaterThan(-1);
    // Every `useNow(` of the file is in that leaf, after its start.
    const clocks = [...text.matchAll(/useNow\(/g)].map((m) => m.index ?? 0);
    expect(clocks.length).toBeGreaterThan(0);
    for (const clock of clocks) expect(clock).toBeGreaterThan(at);
  });

  test("the screens that counted on their own top now use the shared resend button", () => {
    for (const file of [
      "features/me/DeleteAccountScreen.tsx",
      "features/settings/DeleteWorkspaceScreen.tsx",
      "features/me/AccountPage.tsx",
    ]) {
      const text = src(file);
      expect({ file, clock: text.includes("useNow(") }).toEqual({ file, clock: false });
      expect({ file, resend: text.includes("<ResendCode") }).toEqual({ file, resend: true });
    }
  });
});
