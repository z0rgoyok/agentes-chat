import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "src", path), "utf8");

test("Aprovações on the agent's profile: one row with the level, a sheet only for who manages it, off while saving", () => {
  const row = read("features/agents/ApprovalsLevelRow.tsx");
  // The row says the level, or that it follows the workspace; the three choices and their lines are the web's.
  expect(row).toMatch(/followsWorkspace\(agent\) && !update\.isPending\s*\? t\("approvalsLevel\.follows"\)/);
  expect(row).toContain("APPROVALS_LEVELS.map(");
  expect(row).toContain("sub: t(`approvalsLevel.${value}.text`)");
  // Each line is a sentence: never cut to one line by a long language or large text.
  expect(row).toContain("subLines: 3");
  expect(read("features/shared/PickerSheet.tsx")).toContain("{ subLines: o.subLines }");
  // The level changes in its row through the picker: the value's up-down mark, never a chevron to a screen. Only who
  // manages the agent (the server's `canManage`): the "Edit agents" key alone doesn't reach every agent.
  expect(row).toMatch(/managesAgent\(agent\)\s*\? \{ menu: true, disabled: update\.isPending, onPress:/);
  expect(row).not.toContain('can(org, "manage_agents")');
  expect(row).not.toContain("chevron");
  // A failed save says so.
  expect(row).toContain("{ onError: failed }");
  expect(read("features/agents/AgentProfileScreen.tsx")).toContain("<ApprovalsLevelRow agent={agent} />");
});

test("Settings → Aprovações: the workspace's level for owners and administrators, with its ⓘ and how many keep their own", () => {
  const row = read("features/agents/ApprovalsLevelRow.tsx");
  expect(row).toContain(
    'hint={{ name: t("common.about", { label: title }), text: t("approvalsLevel.workspaceHelp") }}',
  );
  expect(row).toContain('t("approvalsLevel.ownAgents", { count: own })');
  expect(row).toContain("set.mutate({ level: next }, { onError: failed })");
  expect(row).toContain("disabled={set.isPending || !settings.data}");
  // It reaches private agents too, so the "Edit agents" key isn't enough (ADR 0085 addendum of 2026-11-17).
  const general = read("features/settings/GeneralScreen.tsx");
  expect(general).toMatch(/can\(org, "administrator"\) \? \(\s*<>\s*<WorkspaceApprovalsRow \/>/);
});

test("Mudar quando perguntar: in the request's Da próxima vez and under a conversation card's decision", () => {
  const when = read("features/approvals/when-asks.tsx");
  // Only for who decides it and manages its agent (who may set its level); the switch for every agent only for owners
  // and administrators, as the workspace's level.
  expect(when).toContain("changesWhenAsks(agent, approval)");
  expect(when).toMatch(/can\(org, "administrator"\)\s*\? \{ toggle: \{ label: t\("approvalsLevel\.everyAgent"\)/);
  // A choice approves nothing: it saves the level, then a toast with Desfazer.
  expect(when).not.toContain("useDecideApproval");
  expect(when).toContain("{ agentId: agent.id, level: next, everyAgent }");
  expect(when).toContain('label: t("approvalsLevel.undo")');
  expect(when).toContain("undo.mutate({ before, everyAgent }");
  const sheet = read("features/approvals/ApprovalSheet.tsx");
  expect(sheet).toContain("(approveAlwaysOffered(a) || when.shown)");
  expect(sheet).toMatch(/label=\{t\("approvalsLevel\.change"\)\}[\s\S]*?chevron[\s\S]*?onPress=\{when\.open\}/);
  // The inbox decides nothing on its rows (ADR 0218 §6): a request opens on its screen, where the row above is.
  const inbox = read("features/activity/ActivityScreen.tsx");
  expect(inbox).not.toContain("WhenAsksLink");
  expect(inbox).not.toContain("useDecideApproval");
  // The conversation's cards, one request or several, as the web's.
  const cards = read("features/chat/cards.tsx");
  expect(cards).toContain("<WhenAsksLink approval={a} />");
  expect(cards).toContain("{decider ? <WhenAsksLink approval={decider} /> : null}");
  // The right hand's routine group, when one agent asked them all.
  expect(read("features/ai/OfferApprovals.tsx")).toContain("{oneAgent ? <WhenAsksLink approval={oneAgent} /> : null}");
  // The picker's switch starts off on every ask and tells the caller each change.
  const picker = read("features/shared/PickerSheet.tsx");
  expect(picker).toContain("setToggled(false);");
  expect(picker).toContain("ask.toggle?.onChange(on);");
});
