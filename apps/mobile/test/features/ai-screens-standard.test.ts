import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The AI, right hand and usage screens on the app's standard pieces (the screens are components the tests can't
 * render: what they wire in, as text): a list's shape while it loads, the native bar's title and no second one drawn
 * under it, lists that end with their own "+" row, one pinned action under a picker, the sheets' own bar.
 */
const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("loading is the list's shape, a failure asks again", () => {
  test("no bare spinner stands for content", () => {
    for (const file of [
      "ai/AgentAiScreen.tsx",
      "ai/AgentAdvancedScreen.tsx",
      "ai/AgentSetupScreen.tsx",
      "ai/AiAccountsScreen.tsx",
      "ai/ConnectAi.tsx",
      "usage/UsageScreen.tsx",
      "usage/AgentUsageScreen.tsx",
      "usage/people.tsx",
      "usage/UsageAccountScreen.tsx",
      "ai/AddAccount.tsx",
    ]) {
      const screen = source(file);
      expect([file, screen.includes("<ActivityIndicator")]).toEqual([file, false]);
      expect([file, screen.includes("<SkeletonList")]).toEqual([file, true]);
    }
    // A usage view that didn't load says so with the way to ask again, never a line of words alone.
    expect(source("usage/AgentUsageScreen.tsx")).toContain("<LoadFailed onRetry={() => void usage.refetch()} />");
    expect(source("usage/people.tsx").match(/<LoadFailed onRetry=/g)).toHaveLength(2);
  });
});

describe("headers: the native bar's, never one drawn in the content", () => {
  test("Contas de IA: its groups under grouped headers, the plans' ⓘ on the header, each list ending with its +", () => {
    const screen = source("ai/AiAccountsScreen.tsx");
    expect(screen).not.toContain('variant="title"');
    expect(screen).toMatch(
      /<GroupedHeader\s+hint=\{\{ name: t\("common\.about", \{ label: t\("aiAccounts\.page\.title"\)/,
    );
    expect(screen).toContain('<GroupedHeader>{t("settings.keysTitle")}</GroupedHeader>');
    expect(screen).toContain('<GroupedRow icon="plus" label={t("aiAccounts.page.connect")}');
    expect(screen).toContain('<GroupedRow icon="plus" label={t("settings.addKey")}');
    // VoiceOver hears an account's place in its order, which only its leading mark shows.
    expect(screen.match(/leadingSaid=\{n\?\.toString\(\)\}/g)).toHaveLength(2);
    // The way to one more account comes after every account, also after the accounts each order of use holds.
    expect(screen.indexOf("<GroupedList>{connect}</GroupedList>")).toBeGreaterThan(
      screen.lastIndexOf("</OrderSection>"),
    );
    // No small button floating under a list.
    expect(screen).not.toContain('size="sm"\n              variant={rows.length');
    // Making a key the default says why when it fails.
    expect(screen).toContain("update.mutate({ defaultCredentialId: k.id }, { onError: failed })");
  });

  test("Conectar uma IA: the system's own title in the bar, the question under the team's cover, the step in the page", () => {
    const sheet = source("ai/ConnectAi.tsx");
    expect(sheet).toContain('t("mobile.ai.question", agentGrammar(one.name))');
    // The bar's title is the system's own words on every page, never a view of ours with a line under it.
    expect(sheet).not.toContain("subtitle=");
    expect(sheet).toContain("<PushedHeader title={title} solid={false} grouped />");
    // The first page: the night edge to edge behind the clear bar, stretching on a pull; its question in the page, which
    // the bar takes as its title once it has gone under it.
    expect(sheet).toContain("<ConnectScene y={y} height={insets.top + BAR_HEIGHT + SCENE_HEIGHT} />");
    expect(sheet).toContain('<PushedHeader title={titled ? title : ""} plate solid={false} />');
    expect(sheet).toContain('<Text variant="display2" accessibilityRole="header">');
    expect(source("ai/ConnectScene.tsx")).toContain("<CoverParallax y={y} style={StyleSheet.absoluteFill}>");
    // What the question leaves open sits under it, 20 clear of the list, never glued to the list's top.
    expect(sheet).toContain("intro: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 20, gap: 6 },");
    // Past it, where the flow stands and for whom, as a line at the top of the page.
    expect(sheet).toContain('style={[styles.step, view.page === "plan" ? styles.center : null]}');
    const steps = source("ai/ConnectAiSteps.tsx");
    const hero = steps.slice(steps.indexOf("function Hero("), steps.indexOf("function CliMissingCard("));
    expect(hero).not.toContain("title2");
    expect(hero).not.toContain('accessibilityRole="header"');
    expect(sheet).toContain("return planTitle(t, view.choice);");
    // The flow lives on its screen only: no sheet head, no back row of its own.
    expect(steps).not.toContain("SheetHeader");
    expect(steps).not.toContain("backRow");
  });

  test("the right hand's settings: its groups by the standard section header", () => {
    const screen = source("right-hand/SettingsScreen.tsx");
    expect(screen).not.toContain('variant="title"');
    expect(screen.match(/<SectionHeader/g)?.length).toBe(3);
  });

  test("an agent's usage: the bar says whose, the first card what it draws; the month's sentence at the body's size", () => {
    const screen = source("usage/AgentUsageScreen.tsx");
    expect(screen.match(/usageViews\.agent\.title/g)).toHaveLength(1);
    expect(screen).toContain('title={t("usageViews.agent.daysLabel", { month })}');
    expect(screen).not.toContain('variant="title"');
  });
});

describe("pickers are the screen, never a list opening in place", () => {
  test("Usar em todos os agentes is Usar em outros agentes on the key, every agent that can take it picked", () => {
    const route = readFileSync(join(import.meta.dir, "../../app/(app)/(main)/key-for-all/[id].tsx"), "utf8");
    expect(route).toContain('<AgentSetupScreen account={{ id: id ?? "", machineId: machineId ?? "", model }} />');
    const screen = source("ai/AgentSetupScreen.tsx");
    expect(screen).toContain("const chosenSet = agentsPicked ?? new Set(account ? can : []);");
    // Another AI picked: the agents are picked again for it.
    expect(screen).toMatch(/setChoice\(next\);\s+setPicked\(null\);/);
  });

  test("a screen's one action is the shared bar pinned under it", () => {
    for (const file of ["ai/AgentSetupScreen.tsx", "ai/ConnectAi.tsx"]) {
      const screen = source(file);
      expect([file, screen.includes("<BottomBar bottom={insets.bottom}>")]).toEqual([file, true]);
      expect([file, screen.includes("borderTopWidth")]).toEqual([file, false]);
    }
  });
});

test("a row that opens a choice in place wears the up-down mark, never a chevron (that pushes a screen)", () => {
  const settings = source("right-hand/SettingsScreen.tsx");
  expect(settings).not.toContain("chevron={!hold}");
  // The one choice's fields open their lists in place: the up-down mark.
  const choice = source("ai/AiChoice.tsx");
  expect(choice.match(/\bmenu(=\{!lockAccount\})?\n/g)?.length).toBe(3);
  // A plan's agent is picked on the agent picker's pushed screen: its row wears the chevron.
  expect(source("ai/ConnectAiSteps.tsx")).toContain("{...(agents.length > 1 ? { chevron: true, onPress: pick } : {})}");
});

describe("rows and notes on the groups' edges", () => {
  test("a note under a group reads as its footer", () => {
    expect(source("ai/parts.tsx")).toContain("noteInset: { paddingHorizontal: 16, paddingTop: 8 },");
    for (const file of ["ai/AgentAiScreen.tsx", "ai/ConnectAiSteps.tsx", "ai/EndpointForm.tsx"])
      expect([file, /<Note icon=[^>]*inset/.test(source(file))]).toEqual([file, true]);
  });

  test("what sits in a grouped row keeps the rows' 16-point sides; a list without a header gets the settings' gap", () => {
    expect(source("ai/AgentAiScreen.tsx")).toContain("meter: { paddingHorizontal: GROUPED_ROW.padX,");
    expect(source("ai/AgentAdvancedScreen.tsx")).toContain("ramp: { paddingHorizontal: GROUPED_ROW.padX,");
    // The effort dock floats on the screen's own sides.
    expect(source("ai/AgentAiScreen.tsx")).toContain('dock: { position: "absolute", left: SCREEN_X, right: SCREEN_X,');
    for (const file of ["ai/AgentAiScreen.tsx", "ai/AgentAdvancedScreen.tsx", "ai/AgentSetupScreen.tsx"])
      expect([file, source(file).includes("marginTop: 20")]).toEqual([file, false]);
  });

  test("a plan's word beside an account's name is text in its tone, never a plate", () => {
    const parts = source("usage/parts.tsx");
    const tag = parts.slice(parts.indexOf("export function Tag("), parts.indexOf("export function UsageCard("));
    expect(tag).not.toContain("backgroundColor");
  });
});

describe("the team's sheets and screens", () => {
  test("the map's sheet has its own bar and no scroll view inside the sheet's", () => {
    const card = source("right-hand/TeamCard.tsx");
    expect(card).not.toContain('variant="title2"');
    expect(card).not.toContain("<ScrollView");
    expect(card).toContain('header={<SheetBar title={t(modeKey(org, "teamPlan.map.title"))} onClose={onClose} />}');
  });

  test("the templates are two pushed screens with the system's back, never steps swapped inside a sheet", () => {
    expect(source("right-hand/TeamCard.tsx")).not.toContain("TeamTemplatesSheet");
    const templates = source("right-hand/TeamTemplates.tsx");
    expect(templates).not.toContain("<Sheet");
    expect(templates).not.toContain('icon="back"');
    expect(templates).not.toContain("<Pressable");
    expect(templates).toContain('onPress={() => router.push({ pathname: "/team-template", params: { id: x.id } })}');
    // Made, both screens go: back where the list was opened.
    expect(templates).toContain("router.dismiss(2);");
    for (const caller of ["right-hand/FirstRun.tsx", "ai/NoAiCard.tsx"])
      expect({ caller, opens: source(caller).includes("openTeamTemplates(") }).toEqual({ caller, opens: true });
  });
});

test("Answer now that fails says why when the person pressed it", () => {
  const card = source("ai/NoAiCard.tsx");
  expect(card).toContain('if (code !== "ai.still_missing") failed(error);');
  expect(card).toContain("if (tapped) failed(error);");
});

test("the plans' list says which plans don't run on the computer's system, before one is picked", () => {
  const steps = source("ai/ConnectAiSteps.tsx");
  expect(steps).toContain("offSystem={(choice) => planOffSystem(t, gateAt(choice))}");
  expect(steps).toContain('? t("connectAi.offSystem", { system: offSystem(c) })');
});
