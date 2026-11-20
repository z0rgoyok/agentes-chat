import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pushedByDefault } from "../main-stack";

/**
 * The agents, team, cargos, AI, right hand and usage screens against the phone's checklist: no keyboard that opens by
 * itself, fields the keyboard never hides or traps, real navigation, one bar per screen. Read as text: the tests can't
 * render React Native.
 */
const src = (path: string) => readFileSync(new URL(`../../src/features/${path}`, import.meta.url), "utf8");

describe("the keyboard waits for a tap", () => {
  test("a new setor's and a cargo's name fields don't take the focus as their screens open", () => {
    expect(src("team/NewSectorScreen.tsx")).not.toContain("autoFocus");
    expect(src("roles/LookScreen.tsx")).not.toContain("autoFocus");
  });

  test("Edit agent walks its fields: Next from the name, the @ and the role; the bar over the keyboard closes it", () => {
    const edit = src("agents/AgentEditScreen.tsx");
    expect(edit).toMatch(/<SettingsPage[\s\S]*?\btoolbar\b[\s\S]*?>/);
    expect(edit).toMatch(/autoCorrect=\{false\}\s+\{\.\.\.NEXT_FIELD\}/);
    expect(edit).toContain("next={!rightHand}");
    expect(edit).toMatch(/<RoleInput[\s\S]*?\bnext\b[\s\S]*?\/>/);
    expect(src("agents/HandleInput.tsx")).toContain('{...(next ? NEXT_FIELD : { returnKeyType: "done" as const })}');
    expect(src("agents/RoleInput.tsx")).toContain("{...(next ? NEXT_FIELD : {})}");
  });

  test("the right hand's budget is every agent's budget field, and its number pad closes from the bar over it", () => {
    const screen = src("right-hand/SettingsScreen.tsx");
    expect(screen).toContain('<SettingsPage title={agent.name} subtitle={t("rightHand.label")} toolbar>');
    expect(screen).toContain("<BudgetField");
    expect(screen).toContain("const { amount, invalid } = readBudget(budget);");
    expect(screen).not.toContain("<TextInput");
    // Its guidance is a row of a group, as every long field of the settings pages.
    const approvals = src("right-hand/Approvals.tsx");
    expect(approvals).toMatch(/<GroupedList>\s+<TextArea[\s\S]*?style=\{styles\.bare\}\s+\/>\s+<\/GroupedList>/);
  });

  test("Uso's budget field goes away with a drag down the page", () => {
    expect(src("usage/UsageScreen.tsx")).toContain('keyboardDismissMode="interactive"');
  });
});

describe("one bar, said once", () => {
  test("a cargo's page names it in its bar only: the head under it is its mark and its glance", () => {
    const parts = src("roles/parts.tsx");
    const head = parts.slice(parts.indexOf("export function CargoHead("), parts.indexOf("/** Back to the list"));
    expect(head).not.toContain("roleName(");
    expect(head).toContain("glanceLine(t, role, everyone, areas, people)");
    expect(src("roles/RoleScreen.tsx")).toContain("<SettingsPage title={name} locked={busy}>");
  });

  test("the cargos' code cites what it does, never the screens' working names", () => {
    for (const file of [
      "roles/AgentsScreen.tsx",
      "roles/ChannelsScreen.tsx",
      "roles/LookScreen.tsx",
      "roles/PeopleScreen.tsx",
      "roles/PermissionsScreen.tsx",
      "roles/RoleScreen.tsx",
      "roles/RolesScreen.tsx",
      "roles/logic.ts",
      "roles/parts.tsx",
    ])
      expect({ file, ids: src(file).match(/\b[PW]\d{1,2}b?\b/g) ?? [] }).toEqual({ file, ids: [] });
  });
});

describe("real navigation", () => {
  test("the team templates and one template's team are routes of their own, pushed with their bar and back", () => {
    for (const route of ["team-templates", "team-template", "team-adjust", "ai-account-rename"])
      expect({ route, pushed: pushedByDefault(route) }).toEqual({ route, pushed: true });
    // A template the first run points to opens over the list, so the system's back goes to the others.
    const templates = src("right-hand/TeamTemplates.tsx");
    expect(templates).toMatch(
      /router\.push\("\/team-templates"\);\s+if \(template\) router\.push\(\{ pathname: "\/team-template", params: \{ id: template \} \}\);/,
    );
  });
});

describe("forms are pushed screens, not sheets", () => {
  test("Adjust on the team card is a settings page: rows that walk with Next, Save in the bar, a guard on leaving", () => {
    const card = src("right-hand/TeamCard.tsx");
    expect(card).not.toContain("AdjustSheet");
    expect(card).toContain("openTeamAdjust({ channelId: m.channelId, messageId: m.id, agent })");
    const screen = src("right-hand/TeamAdjustScreen.tsx");
    expect(screen).not.toContain("<Sheet");
    expect(screen).toContain('action={{ label: t("common.save"), onPress: save, disabled: !ready }}');
    expect(screen).toMatch(/<SettingsPage[\s\S]*?\btoolbar\b[\s\S]*?>/);
    expect(screen).toContain("{...NEXT_FIELD}");
    expect(screen).toContain("const leave = useUnsavedGuard(changed && !adjust.isPending);");
    expect(screen).not.toContain("autoFocus");
  });
});

describe("what loads from the server reads again on a pull", () => {
  test("Uso, a plan account, an agent's usage, Contas de IA, an agent's AI and its model", () => {
    for (const file of [
      "usage/UsageScreen.tsx",
      "usage/UsageAccountScreen.tsx",
      "usage/AgentUsageScreen.tsx",
      "ai/AiAccountsScreen.tsx",
      "ai/AgentAiScreen.tsx",
    ]) {
      const screen = src(file);
      expect({
        file,
        pull: screen.includes("<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />"),
      }).toEqual({ file, pull: true });
      expect({ file, hook: screen.includes("usePullRefresh(") }).toEqual({ file, hook: true });
    }
    // The model's screen reads its brain again.
    expect(src("ai/AgentAiScreen.tsx")).toContain("const pull = usePullRefresh(brain.refetch);");
  });
});

describe("the standard pieces", () => {
  test("where an agent merges: the search first under the title, what the switches do under them, an empty page said", () => {
    const merge = src("agents/MergeReposSection.tsx");
    const screen = merge.slice(merge.indexOf("export function MergeReposScreen("));
    expect(screen.indexOf("<SearchField")).toBeLessThan(screen.indexOf('t("repos.merge.dialogDesc")'));
    expect(screen).toContain(
      '<EmptyState icon="code" title={t("repos.none")} subtitle={t("repos.merge.dialogDesc")} />',
    );
  });

  test("the color swatches and the team's channel cards answer a press with the kit's scale", () => {
    const look = src("agents/LookPicker.tsx");
    expect(look).not.toContain("<Pressable");
    expect(look.match(/<PressScale/g)).toHaveLength(2);
    const team = src("team/TeamScreen.tsx");
    expect(team).toContain("<PressScale");
    expect(team).not.toContain("opacity: 0.7");
  });

  test("a setor renamed and not saved asks before it is left; deleting it leaves without asking", () => {
    const sector = src("team/SectorScreen.tsx");
    expect(sector).toContain("const leave = useUnsavedGuard(");
    expect(sector).toMatch(/remove\.ask\(group, \(\) => \{\s+leave\(\);\s+goBack\(\);/);
  });
});

test("a person's See my usage opens Uso on their own month, where the label says it goes", () => {
  expect(src("usage/people.tsx")).toContain('router.push({ pathname: "/usage", params: { view: "people" } })');
  expect(src("usage/UsageScreen.tsx")).toContain('useState<"summary" | "people">(initialView)');
  const route = readFileSync(new URL("../../app/(app)/(main)/usage.tsx", import.meta.url), "utf8");
  expect(route).toContain('<UsageScreen initialView={view === "people" ? "people" : "summary"} />');
});

test("adding people to a cargo: Adicionar is the bar's word, never a docked button the search's keyboard hides", () => {
  const people = src("roles/PeopleScreen.tsx");
  const add = people.slice(
    people.indexOf("export function AddToRoleScreen("),
    people.indexOf("export function PersonRolesScreen("),
  );
  expect(add).not.toContain("bottom={");
  expect(add).toContain("onPress: () => void add(),");
  expect(add).toContain("busy={busy}");
});
