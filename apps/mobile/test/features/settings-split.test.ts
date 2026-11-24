import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrgSummary } from "@agenteschat/client";
import { SETTINGS_SECTIONS, visibleSections } from "../../src/features/settings/logic";
import {
  ACCOUNT_PAGE,
  ADVANCED_PAGE,
  SETTINGS_PAGES,
  settingsFallback,
  settingsSplit,
} from "../../src/features/settings/split";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");
const MAIN = join(import.meta.dir, "../../app/(app)/(main)");

/** A route's file for an address, an index's included (`/settings/roles` is `settings/roles/index.tsx`). */
const routeFile = (href: string) =>
  [join(MAIN, `${href.slice(1)}.tsx`), join(MAIN, href.slice(1), "index.tsx")].find((f) => existsSync(f));

const member = { id: "o1", name: "Team", role: "member", mode: "team", permissions: ["read"] } as unknown as OrgSummary;

describe("the workspace's settings in two panes (ADR 0212)", () => {
  test("every row's page is a route of its own; a personal workspace's Your account and Advanced too", () => {
    expect(SETTINGS_PAGES).toEqual([...SETTINGS_SECTIONS.map((s) => s.href), ACCOUNT_PAGE, ADVANCED_PAGE]);
    for (const page of SETTINGS_PAGES)
      expect({ page, route: routeFile(page) !== undefined }).toEqual({ page, route: true });
    // Deleting and resetting stay flows of their own.
    expect(SETTINGS_PAGES).not.toContain("/settings/delete");
    expect(SETTINGS_PAGES).not.toContain("/settings/reset");
  });

  test("with none chosen, the list's first row stands beside it; it is never the choice", () => {
    expect(settingsFallback(true, member)).toBe("/me/account");
    expect(settingsFallback(false, member)).toBe(visibleSections(member)[0]?.href ?? null);
    settingsSplit.offer("org-settings-a", "/settings/general");
    expect(settingsSplit.shown("org-settings-a")).toBe("/settings/general");
    expect(settingsSplit.chosen("org-settings-a")).toBeNull();
    settingsSplit.choose("org-settings-a", "/settings/roles");
    expect(settingsSplit.chosen("org-settings-a")).toBe("/settings/roles");
  });

  test("wide, the list and the open section side by side, each drawn as its route draws it", () => {
    const screen = src("settings/SettingsScreen.tsx");
    expect(screen).toMatch(
      /<PageSplitScreen\s+store=\{settingsSplit\}\s+pages=\{SETTINGS_PAGE_VIEWS\}\s+fallback=\{settingsFallback\(personal, org\)\}\s+list=\{<WorkspaceScreen \/>\}\s+testID="settings-split"/,
    );
    // Every page has its view, as its route renders it (the audit with no agent, usage on its summary).
    for (const page of SETTINGS_PAGES) {
      const file = routeFile(page);
      const route = file ? readFileSync(file, "utf8") : "";
      const view = /return <(\w+)[ />]/.exec(route)?.[1];
      expect({ page, view: screen.includes(`"${page}": () => <${view}`) }).toEqual({ page, view: true });
    }
    expect(screen).toContain('"/settings/audit": () => <AuditScreen agentId={null} />,');
    expect(screen).toContain('"/usage": () => <UsageScreen initialView="summary" />,');
    const route = readFileSync(join(MAIN, "settings/index.tsx"), "utf8");
    expect(route).toContain("return <SettingsScreen />;");
    // The list itself stays what the compact screen shows.
    expect(src("settings/WorkspaceScreen.tsx")).toContain(
      "return personal ? <PersonalSettingsList others={others} /> : <TeamSettingsList />;",
    );
  });

  test("its rows open their sections beside the list and stay lit; Advanced's own rows keep pushing", () => {
    const list = src("settings/WorkspaceScreen.tsx").replace(/\s+/g, " ");
    expect(list).toContain('{...lit("/me/account")} chevron onPress={() => open("/me/account")}');
    expect(list).toContain('{...lit("/settings/advanced")} chevron onPress={() => open("/settings/advanced")}');
    expect(list.match(/\{\.\.\.lit\(s\.href\)\} chevron onPress=\{\(\) => open\(s\.href\)\}/g)).toHaveLength(3);
    // The opener is the list pane's alone: a section in the detail pane (Advanced) pushes its rows.
    const panes = src("shared/SplitPanes.tsx");
    expect(panes).toContain("<PageOpenerContext.Provider value={opener}>{list}</PageOpenerContext.Provider>");
    expect(panes).toContain(
      "detail={page ? <SplitDetailContext.Provider value={detail}>{page()}</SplitDetailContext.Provider> : null}",
    );
  });
});
