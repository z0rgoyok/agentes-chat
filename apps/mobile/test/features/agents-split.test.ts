import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_TAB, agentHref, agentSplit, pushedAgentOf } from "../../src/features/agents/split";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("Agentes in two panes (ADR 0212)", () => {
  test("the agent beside the list, per workspace: the first agent offered, only a choice pushed when it closes", () => {
    agentSplit.offer("org-agents-a", "a1");
    expect(agentSplit.shown("org-agents-a")).toBe("a1");
    expect(agentSplit.chosen("org-agents-a")).toBeNull();
    agentSplit.choose("org-agents-a", "a2");
    expect(agentSplit.shown("org-agents-a")).toBe("a2");
    expect(agentSplit.chosen("org-agents-a")).toBe("a2");
    expect(agentSplit.shown("org-agents-b")).toBeNull();
    expect(agentHref("a2")).toBe("/agent/a2");
    expect(AGENTS_TAB).toBe("agents");
  });

  test("an agent's page pushed over the tabs is the main stack's agent route on top, and nothing else", () => {
    const agent = ["(app)", "(main)", "agent", "[id]"];
    expect(pushedAgentOf(agent, { id: "a1" })).toBe("a1");
    expect(pushedAgentOf(agent, { id: "../x" })).toBeNull();
    expect(pushedAgentOf(["(app)", "(main)", "chat", "[channelId]"], { channelId: "c1" })).toBeNull();
    expect(pushedAgentOf(["(app)", "(main)", "(tabs)", "agents"], { id: "a1" })).toBeNull();
    expect(pushedAgentOf(["(app)", "(main)", "agent-more", "[id]"], { id: "a1" })).toBeNull();
  });

  test("wide, the team's list and the chosen agent's page side by side; compact as always", () => {
    const screen = src("agents/AgentsScreen.tsx");
    const top = screen.slice(screen.indexOf("export function AgentsScreen()"), screen.indexOf("function AgentsList()"));
    expect(top).toContain("const wide = useWide();");
    expect(top).toContain("<Stack.Screen options={wide ? SPLIT_OPTIONS : LIST_OPTIONS} />");
    expect(top).toContain("<AgentsHandoff wide={wide} />");
    expect(top).toContain("{wide ? <AgentsSplit list={<AgentsList />} /> : <AgentsList />}");
    const split = src("agents/AgentsSplit.tsx");
    // The page as its route draws it, faces still while the tab isn't showing, its foot clear of the tab bar.
    expect(split).toContain("<AgentProfileScreen id={id} />");
    expect(split).toMatch(/<FocusLive>\s*<AgentProfileScreen id=\{id\} \/>\s*<\/FocusLive>/);
    expect(split).toContain("ownInsets");
    expect(split).toContain("detailKey={key && id ? key : null}");
    expect(split).toContain('empty={t("mobile.agents.splitEmpty")}');
    expect(featureKeysEn.agents.splitEmpty).toBe("Your agents' pages open here.");
    expect(featureKeysPtBR.agents.splitEmpty).toBe("As páginas dos seus agentes abrem aqui.");
  });

  test("a row opens its agent beside the list and stays lit; with none chosen the first agent shows", () => {
    const screen = src("agents/AgentsScreen.tsx");
    expect(screen).toContain("const firstId = order[0] ?? null;");
    expect(screen).toContain("if (opener) agentSplit.offer(opener.orgId, firstId);");
    const row = screen.slice(screen.indexOf("const AgentRow = memo("), screen.indexOf("function useGreeting("));
    expect(row).toContain("const chosen = agentSplit.useIsShown(opener?.orgId ?? null, a.id);");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the row's source
    expect(row).toContain("onPress={() => (opener ? opener.open(a.id) : router.push(`/agent/${a.id}`))}");
    expect(row).toContain("opens={!opener}");
    expect(row).toContain("background: withAlpha(c.ink, CHOSEN_TINT), accessibilityState: { selected: true }");
  });

  test("closing pushes the chosen page in place; opening takes back only a page pushed from this tab", () => {
    const split = src("agents/AgentsSplit.tsx");
    const handoff = split.slice(split.indexOf("export function AgentsHandoff("));
    expect(handoff).toContain("pushed: selectedTab() === AGENTS_TAB ? pushedAgentOf(segments, params) : null,");
    expect(handoff).toContain("push: (id) => router.push(stillHref(agentHref(id)) as never),");
    expect(handoff).toMatch(/agentSplit\.choose\(orgId, id, true\);\s*landOn\("\/agents"\);/);
  });
});
