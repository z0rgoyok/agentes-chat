import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pushedByDefault } from "../main-stack";
import { translator } from "./fixtures";

/** The agents, AI, members and team screens: components the tests can't render, read as text. */
const src = (path: string) => readFileSync(new URL(`../../src/features/${path}`, import.meta.url), "utf8");

describe("Agents", () => {
  test("the team's rows while it loads, a failed load with Try again, never the first agent's invitation", () => {
    const screen = src("agents/AgentsScreen.tsx");
    const skeleton = screen.indexOf("<SkeletonList rows={4} />");
    const failed = screen.indexOf("<LoadFailed onRetry={() => void directory.refetch()} />");
    const first = screen.indexOf('place="agents"');
    expect(skeleton).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(skeleton);
    expect(first).toBeGreaterThan(failed);
    expect(screen).toContain("directory.isError && !directory.data");
    // Its pull as the other tabs' (the tab screen draws the wheel or the orbit), and the team itself read again.
    expect(screen).toContain("pull={pull}");
    expect(screen).not.toContain("<RefreshControl");
    expect(screen).toContain("directory.refetch(),");
  });

  test("a private agent unlisted to me (listed: false) stays off every list, while its name and face still resolve", () => {
    const hooks = src("shared/hooks.ts");
    expect(hooks).toContain("const agents = all.filter((a) => a.listed !== false);");
    expect(hooks).toContain("const agentById = new Map(all.map((a) => [a.id, a]));");
    expect(hooks).toContain("const agents = useAllAgents(orgId);");
    // The brakes' list of agents it may call is a list too: the directory's, not its lookups.
    expect(src("agents/BrakesSection.tsx")).toContain("const others = dir.agents.filter(");
  });

  test("a message's mentions and a new @ read every agent, unlisted ones too: they still name it and hold its @", () => {
    for (const file of ["chat/EventLine.tsx", "chat/MessageRow.tsx"])
      expect(src(file)).toContain("agentsByAnyHandle([...dir.agentById.values()])");
    expect(src("chat/MessageSpans.tsx")).toContain("mentionTint(handle, [...agentById.values()], scheme)");
    for (const file of ["agents/AgentEditScreen.tsx", "agents/NewAgentScreen.tsx"])
      expect(src(file)).toContain("takenHandles([...dir.agentById.values()],");
  });

  test("rows are memoized on plain values and share the screen's one clock", () => {
    const screen = src("agents/AgentsScreen.tsx");
    expect(screen).toContain("const AgentRow = memo(function AgentRow(");
    expect(screen.match(/useNow\(\)/g)).toHaveLength(1);
    // Every row's props come from the screen's one read (`rowOf`); only a row that says how long gets the clock.
    expect(screen.match(/\{\.\.\.rowOf\(l\)\}/g)).toHaveLength(3);
    expect(screen).toContain("now: ticks ? now : 0,");
    const row = screen.slice(screen.indexOf("const AgentRow = memo("), screen.indexOf("function useGreeting("));
    for (const hook of ["usePresenceOf(", "useAiStatus(", "usePlanHold(", "useAgentWorkLine(", "useNow("])
      expect({ hook, read: row.includes(hook) }).toEqual({ hook, read: false });
    expect(screen).toContain("() => teamLines(agents, work, dms.data ?? [], asking, offline, atWork),");
    expect(screen).not.toContain("line={l}");
  });
});

describe("an agent's profile", () => {
  test("what it did for you and what it knows say they didn't load, with Try again, never Nothing yet", () => {
    const screen = src("agents/AgentProfileScreen.tsx");
    expect(screen).toContain("<LoadFailed onRetry={() => void forYou.refetch()} />");
    expect(screen).toContain("<LoadFailed onRetry={() => void knows.refetch()} />");
    // "Nothing yet" only under a list that loaded.
    expect(screen.indexOf("{forYou.data ? (")).toBeGreaterThan(-1);
    expect(screen.indexOf("{forYou.data ? (")).toBeLessThan(screen.indexOf("mobile.intentAgents.did.empty"));
  });

  test("the message field and Ask for access open a conversation it knows at once, else wait and take no second tap", () => {
    const screen = src("agents/AgentProfileScreen.tsx");
    expect(screen).toContain("if (opening) return;");
    expect(screen).toContain("const known = dms.data?.find(");
    expect(screen).toMatch(/if \(known\) \{\s+router\.push\(chatHref\(known\.channelId\)\);/);
    expect(screen.match(/loading=\{opening\}/g)).toHaveLength(1);
    expect(screen).toContain("busy={opening}");
    expect(screen).toContain(".finally(() => setOpening(false));");
  });

  test("its money and month formatters are built once per language, not per render", () => {
    const screen = src("agents/AgentProfileScreen.tsx");
    expect(screen.match(/new Intl\.\w+\(/g)).toHaveLength(2);
    expect(screen).toMatch(/useMemo\(\s*\(\) => new Intl\.NumberFormat/);
    expect(screen).toMatch(/useMemo\(\s*\(\) => new Intl\.DateTimeFormat/);
  });

  test("work nobody asked for: a number from its list in the picker, and forgetting the answers asks first", async () => {
    const brakes = src("agents/BrakesSection.tsx");
    expect(brakes).not.toContain("nextOf");
    expect(brakes.match(/menu=\{editable\}/g)).toHaveLength(2);
    expect(brakes).toContain("void pickOne({");
    expect(brakes).toMatch(/confirmAction\(\{\s+title: t\("mobile\.agent\.brakes\.forgetTitle"\)/);
    expect(brakes).toContain("onPress={forget}");
    const pt = await translator("pt-BR");
    expect(pt("mobile.agent.brakes.forgetText", { name: "Ada", context: "female" })).toBe(
      "A Ada volta a perguntar antes desse tipo de trabalho.",
    );
    expect((await translator("en"))("mobile.agent.brakes.forgetTitle")).toBe("Forget these answers?");
  });

  test("a repository's merge switch flips on the tap, and only its own row waits", () => {
    const merge = src("agents/MergeReposSection.tsx");
    expect(merge).toContain("const list = (save.isPending ? save.variables : undefined) ?? merge.data ?? [];");
    expect(merge).toContain("if (flipping.has(repo)) return;");
    expect(merge).not.toContain("disabled={save.isPending}");
  });

  test("where it merges is chosen on a screen of its own, never in a sheet over the profile", () => {
    const merge = src("agents/MergeReposSection.tsx");
    expect(merge).not.toContain("<Sheet");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the screen's own template, read as source text
    expect(merge).toContain("router.push(`/agent-merge/${agentId}` as never)");
    expect(pushedByDefault("agent-merge/[id]")).toBe(true);
  });

  test("Advanced is a settings page", () => {
    const more = src("agents/AgentMoreScreen.tsx");
    expect(more).toContain('<SettingsPage title={t("agentPage.tabs.advanced")}>');
    expect(more).not.toContain("<ScrollView");
  });
});

describe("saving forms", () => {
  test("a setup step's and Edit's Save spin in the bar while they save, the page locked under them", () => {
    const steps = src("agents/setup/SetupStepScreen.tsx");
    expect(steps.match(/busy=\{busy\}/g)).toHaveLength(4);
    expect(steps).toContain("busy={save.isPending}");
    expect(steps).not.toMatch(/disabled=\{busy\}|disabled: busy/);
    // Edit is a settings page: its Save spins in the bar, and leaving with changes asks through the shared guard.
    const edit = src("agents/AgentEditScreen.tsx");
    expect(edit).toContain("busy={update.isPending}");
    expect(edit).toContain("const leave = useUnsavedGuard(Boolean(changes));");
    expect(edit).not.toContain("usePreventRemove");
    const sector = src("team/SectorScreen.tsx");
    expect(sector).toContain("busy={action.isPending}");
    expect(sector).toContain("<LoadFailed onRetry={() => void groups.refetch()} />");
    expect(sector).not.toContain("<EmptyState");
  });

  test("Use on other agents says how it went in one toast; its buttons spin while they save", () => {
    const setup = src("ai/AgentSetupScreen.tsx");
    // One toast for the result, one for a failure.
    expect(setup.match(/toast\(\{/g)).toHaveLength(2);
    expect(setup).toContain('...(rest.length > 0 ? { subtitle: rest.join(" ") } : {}),');
    expect(setup).toMatch(/loading=\{busy\}\s+disabled=\{chosen\.length === 0\}/);
  });

  test("a device code's Copied says Copy again after a moment, with a tap of success; Start spins in place", () => {
    const flow = src("ai/AddAccount.tsx");
    expect(flow).toContain("const timer = setTimeout(() => setCopied(false), COPIED_MS);");
    expect(flow).toMatch(
      /if \(!login\?\.userCode \|\| !\(await copyText\(login\.userCode\)\)\) return;\s+successHaptic\(\);/,
    );
    expect(flow).toContain("loading={starting || loading}");
    expect(flow).not.toContain("styles.spinner");
  });

  test("Next goes on to the next field, the keyboard up between them", () => {
    const create = src("agents/NewAgentScreen.tsx");
    expect(create).toMatch(
      /returnKeyType="next"\s+submitBehavior="submit"\s+onSubmitEditing=\{\(\) => \{\s+toHandle\.current = true;\s+nameDone\(\);/,
    );
    expect(create).toContain("handleField.current?.focus();");
    expect(create).toContain("ref={handleField}");
    expect(src("agents/HandleInput.tsx")).toContain("ref={ref}");
    const suggest = src("members/SuggestPerson.tsx");
    expect(suggest).toMatch(/returnKeyType="next"\s+submitBehavior="submit"/);
    expect(suggest).toContain("onSubmitEditing={() => noteField.current?.focus()}");
    expect(suggest).toContain("ref={noteField}");
  });
});

describe("members", () => {
  test("a list that didn't load says so with Try again, and the page pulls to read it again", () => {
    const page = src("members/MembersPage.tsx");
    expect(page).toContain("<LoadFailed onRetry={() => void people.refetch()} />");
    // Você's own page frame (`Page`), its pull reading the people and their roles again: no frame of its own.
    expect(page).toContain("<Page");
    expect(page).not.toContain("MembersFrame");
    expect(page).toContain("onRefresh={() => Promise.allSettled([people.refetch(), rolesQ.refetch()])}");
    expect(src("members/JoinRequestsScreen.tsx")).toContain("<LoadFailed");
  });

  test("Remove and Leave confirm at once: what goes with the person is read as the row's menu opens", () => {
    const page = src("members/MembersPage.tsx");
    expect(page).toContain("if (removes) void qc.prefetchQuery(removalQuery(api, orgId, m.userId));");
    expect(page).toContain("preview = await qc.fetchQuery(removalQuery(api, orgId, m.userId));");
    expect(page).not.toContain("staleTime: 0");
  });
});

describe("Connect an AI and the right hand's cards", () => {
  test("a new page of Connect an AI is a screen pushed over the last, never one swapped in place", () => {
    const sheet = src("ai/ConnectAi.tsx");
    // Each page its own screen: it starts at its top and slides in with the system's push.
    expect(sheet).not.toContain("scrollTo(");
    expect(sheet).toContain(
      "const go = (next: PushedPage) => router.push(connectAiHref(flowId, depth + 1, next) as never);",
    );
    const steps = src("ai/ConnectAiSteps.tsx");
    expect(steps).not.toContain("<Animated.View key={pageKey}");
    expect(steps).not.toContain("PAGE_IN");
  });

  test("the team card's chips and the weekly card's link take a finger's 44 points", () => {
    const card = src("right-hand/TeamCard.tsx");
    expect(card).toContain('chipHit: { minHeight: 44, marginVertical: -4, justifyContent: "center" },');
    expect(card).toContain("style={styles.chipHit}");
    expect(src("right-hand/TeamWeekCard.tsx")).toContain(
      'when: { alignSelf: "flex-start", minHeight: 44, marginVertical: -8, justifyContent: "center" },',
    );
  });
});

describe("the agents' pages on the phone's standards", () => {
  test("a choice of one agent, of several or of a person is a pushed screen, never a list unfolding in a card", () => {
    for (const route of ["agent-choose", "person-choose", "agent-look", "agent-merge/[id]"])
      expect({ route, pushed: pushedByDefault(route) }).toEqual({ route, pushed: true });
    const reports = src("agents/ReportsToSection.tsx");
    expect(reports).toContain('router.push("/agent-choose");');
    expect(reports).not.toContain("[null, ...choices].map(");
    // Desfazer is the toast's word, not a row that appears under the field.
    expect(reports).toMatch(/action: \{\s*label: t\("agentGroups\.undo"\),\s*onPress: \(\) => apply\(previous, true\)/);
    const brakes = src("agents/BrakesSection.tsx");
    expect(brakes).toContain("multi: true,");
    expect(brakes).not.toContain("toggle={b.callAgentIds.includes(a.id)}");
    // Each opener closes its choice when it goes away, so a stale form never hears a pick.
    for (const file of ["agents/ReportsToSection.tsx", "agents/BrakesSection.tsx", "agents/LookPicker.tsx"])
      expect(src(file)).toMatch(/useEffect\(\(\) => \(\) => close\w+\(\), \[\]\);/);
    const roleWho = src("roles/AgentsScreen.tsx");
    expect(roleWho).toContain("openPersonChoose({");
    expect(roleWho).not.toContain("pickOne(");
  });

  test("states: the rows' shape while loading, a failed load with Try again, never a bare spinner or a blank page", () => {
    const steps = src("agents/setup/SetupStepScreen.tsx");
    expect(steps).not.toContain("ActivityIndicator");
    expect(steps.match(/<Bones \/>/g)).toHaveLength(3);
    const team = src("team/TeamScreen.tsx");
    expect(team).toContain("<SkeletonList rows={4} />");
    expect(team).toContain("<LoadFailed onRetry={() => void team.refetch()} />");
    expect(src("agents/ProposalsScreen.tsx")).toContain("{proposals.isPending ? <SkeletonList rows={3} /> : null}");
    expect(src("team/SectorScreen.tsx")).not.toContain("ActivityIndicator");
    const create = src("agents/NewAgentScreen.tsx");
    expect(create).toContain("{proposal.isPending ? (");
    expect(create).toContain("<RowBones />");
  });

  test("a setup step's app level is picked among the app's own levels, never cycled by taps", () => {
    const steps = src("agents/setup/SetupStepScreen.tsx");
    expect(steps).not.toContain("nextLevel");
    expect(steps).toContain("options: r.levels.map((level) => ({");
  });

  test("the app's own rows and groups, never hand-made look-alikes", () => {
    const profile = src("agents/AgentProfileScreen.tsx");
    expect(profile).not.toContain("function ButtonRow");
    // Its place in the usage line is a row of the page, not a small button floating under the cards.
    expect(profile).toMatch(/icon="wait"\s+label=\{t\("queue\.see"\)\}\s+more/);
    // The views are peers: switching them shows the other at once.
    expect(profile).not.toContain("entering=");
    const budget = src("agents/BudgetSection.tsx");
    expect(budget).toContain('<GroupedHeader>{t("rightHand.settings.budget")}</GroupedHeader>');
    // Saved apart from the form's Salvar, so it says it went.
    expect(budget).toContain('onSuccess: () => toast({ title: t("mobile.agentEdit.saved"), agentId: agent.id })');
    expect(budget).not.toContain('<Text variant="title"');
    expect(src("agents/setup/SetupStepScreen.tsx")).toContain("<BudgetField");
    const roles = src("roles/RolesScreen.tsx");
    expect(roles).not.toContain("<Pressable");
    expect(roles).toMatch(/<Button\s+variant="text"\s+size="sm"/);
    const imp = src("agents/ImportAgents.tsx");
    expect(imp).toContain("leading={<SourceMark card={card} />}");
    expect(imp).not.toContain("function Note(");
    expect(imp).not.toContain("<Toggle");
    const create = src("agents/NewAgentScreen.tsx");
    expect(create).toMatch(/label=\{t\("approval\.refuse"\)\}\s+danger/);
    // Back and Continue pinned under the step's scroll in the app's bottom bar, as a settings page's one action.
    expect(create).toContain("<BottomBar bottom={insets.bottom}>");
    expect(src("agents/LookPicker.tsx")).not.toContain("export function LookPicker(");
    // The fields are only ever rows of a grouped list: no loose bordered look-alike left behind.
    for (const field of ["agents/RoleInput.tsx", "agents/HandleInput.tsx"])
      expect({ field, loose: src(field).includes("grouped") && src(field).includes("borderWidth") }).toEqual({
        field,
        loose: false,
      });
  });

  test("a value changed through the app's picker shows the up-down mark; a row that opens a screen, the chevron", () => {
    const sector = src("team/SectorScreen.tsx");
    expect(sector).toMatch(/chevron: true,\s+onPress: \(\) => pick\(t\("team\.sectors\.leadLabel"\), "leadUserId"\)/);
    // The setor's "…" in Agentes is the app's action list, as every "…".
    expect(sector).toContain("chooseAction(");
    expect(sector).not.toContain("<ActionList");
    // Criar agente's "Quem pensa" is the one AI choice, whose fields open in place.
    expect(src("agents/NewAgentScreen.tsx")).toContain("<AiChoiceFields");
  });
});
