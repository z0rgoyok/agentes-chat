import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The team's right hand on a plan (ADR 0137 §1, §7) on the phone: components the tests can't render, read as text. */
const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/ai", path), "utf8");

test("its plan's line: one plain line and Usar uma chave de API, which opens Connect on the key", () => {
  const card = source("NoAiCard.tsx");
  expect(card).toContain("noAi.rightHand.");
  expect(card).toContain('"noAi.rightHand.useKey"');
  expect(card).toContain('{ intent: "api_key" }');
  // The workspace's plan serves only its owner: the person's own plan answers them (ADR 0137 §11).
  expect(card).toContain('fix === "connectMine" ? "rightHand.settings.connectMine"');
});

test("Connect for it offers every plan the phone offers, ChatGPT's too, and its key moves it off the plan", () => {
  const sheet = source("ConnectAi.tsx");
  expect(sheet).not.toContain("claudeCodeOnly");
  expect(sheet).toContain("rightHandOnKey(api, orgId, one, key");
  const steps = source("ConnectAiSteps.tsx");
  expect(steps).toContain("options={PLAN_CHOICES.map((c) => ({");
});

test("Sua IA is the one choice, or the call to connect a plan; Lodi's settings open with it", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  const profile = readFileSync(join(import.meta.dir, "../../src/features/agents/AgentProfileScreen.tsx"), "utf8");
  // The four states come from the client's rule, as on the web (ADR 0137 §11).
  expect(screen).toContain('const status = mineStatus(view, meId ?? "", platform, agent.brain?.maker);');
  expect(screen).toContain('status.kind === "nobody"');
  // Otherwise the one choice every picker shares (Conta, Modelo, Esforço): "A do workspace" first, the plans that may
  // think for me, and Conectar uma IA last.
  expect(screen).toContain('target={{ kind: "lodi", agentId: agent.id, scope: "mine" }}');
  expect(screen).toContain('label: t("agentPage.work.brain.connectPlan"),');
  expect(screen).toContain("onPick: connect,");
  // Nobody answers me: the call to connect my plan, and why it is mine alone behind the ⓘ, not a paragraph under it.
  expect(screen).toContain('sub={t("rightHand.settings.mineNobody")}');
  expect(screen).toContain('text: t("rightHand.settings.mineHelp", agentGrammar(agent.name)),');
  expect(screen).not.toContain("rightHandFallback");
  expect(screen).toContain("openConnectAi({ agentId: agent.id })");
  // On the right hand's profile, and first in its settings, under "Só para você".
  expect(profile).toContain("<RightHandMine agent={agent} />");
  // The screen's groups by their names, each the standard section header over its lists (never a title drawn by hand).
  const mine = screen.indexOf('<SectionHeader title={t("rightHand.settings.groupMine")} />');
  const workspace = screen.indexOf(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the screen's source
    'title={`${t("rightHand.settings.groupWorkspace")} · ${t("rightHand.settings.groupAdmins")}`}',
  );
  expect(screen).not.toContain("function GroupTitle(");
  expect(mine).toBeGreaterThan(-1);
  expect(screen.indexOf("<RightHandMine agent={agent} />")).toBeGreaterThan(mine);
  expect(screen.indexOf("<RightHandApprovalsGroup />")).toBeGreaterThan(mine);
  expect(screen.indexOf("<RightHandApprovalsGroup />")).toBeLessThan(workspace);
  // The workspace's group is only for who manages it (the server's `canManage`), and the settings open for everyone
  // from the profile.
  expect(screen.slice(mine, workspace)).toContain("{managesAgent(agent) ? (");
  expect(profile).toContain(
    '? { action: { label: t("rightHand.profile.configure"), onPress: openRightHandSettings, opens: true } }',
  );
  expect(profile).not.toContain(
    '? can(org, "manage_agents")\n              ? { action: { label: t("rightHand.profile.configure")',
  );
});

test("Lodi's settings: the workspace's plan has no lending switch, since a plan serves the whole workspace", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  // The workspace's AI is read and saved as such; the look opens from the row, with no "Mudar visual" on it.
  expect(screen).toContain('useAgentBrain(orgId, agent.id, true, false, "workspace")');
  expect(screen).not.toContain("rightHand.settings.changeLook");
  // Who a plan serves is its owner's choice in IA e uso (ADR 0059 §3), not a switch here.
  expect(screen).not.toContain("rightHand.settings.lend");
  expect(screen).not.toContain("set({ onlyOwner: on })");
  // The budget only where something bills per use, the audience only with someone else here.
  expect(screen).toContain("{usesApi ? (");
  expect(screen).toContain("{solo ? null : (");
  // What it thinks with is the one choice, saved as the workspace's: the key or a plan open to everyone.
  expect(screen).toContain(
    '<AiChoiceFields target={{ kind: "lodi", agentId: agent.id, scope: "workspace" }} disabled={hold} />',
  );
  expect(screen).not.toContain("noAi.rightHand.useKey");
  expect(screen).not.toContain("workspacePlan");
});

test("Connect is everyone's for Lodi, and its own AI has no Atende outras pessoas", () => {
  const sheet = source("ConnectAi.tsx");
  expect(sheet).toContain("a.ownerUserId === meId || isRightHand(a)");
  const steps = source("ConnectAiSteps.tsx");
  expect(steps).toContain('gates.view?.scope === "mine" ? null : (');
  expect(steps).toContain('t("noAi.lockedOwner")');
});

test("another AI answered for its plan: a quiet pill with Change, and its dimmed plans with why (ADR 0137 §7, amended)", () => {
  const card = source("NoAiCard.tsx");
  // The stand-in line: neutral (never `waiting`), its words in the reader's language, Change opens its settings.
  expect(card).toContain("if (card.standIn) return <StandInLine standIn={card.standIn} />;");
  expect(card).toContain("t(standInKey(standIn.why), { via: standIn.via, plan: standIn.plan })");
  expect(card).toContain('router.push("/settings/right-hand" as never)');
  const row = readFileSync(join(import.meta.dir, "../../src/features/chat/MessageRow.tsx"), "utf8");
  expect(row).toContain('isStandInLine(meta) ? ""');
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  expect(screen).toContain("rightHandUnusable(aiAccounts, view?.account)");
  expect(screen).toContain('t("rightHand.unusable.title", g)');
  expect(screen).toContain('t("rightHand.unusable.computerOnly"');
  // The way out is the workspace's computers, for who may connect one: no button of Lodi's own.
  expect(screen).toContain('can(org, "pair_computers") && edition !== "cloud" && cant.some((u) => u.why === "away")');
  expect(`${card}${screen}`).not.toContain("Give Lodi a computer");
});

test("the workspace's plans it can't think with now list each account once, as on the web", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  expect(screen).toContain("const cant = rightHandUnusable(aiAccounts, view?.account);");
});

test("Connect for someone else's agent that the person manages signs a plan in for it, as on the web", () => {
  const sheet = source("ConnectAi.tsx");
  expect(sheet).toContain("named.includes(a.id) && connectsPlanFor(a, meId)");
  // `locked` (who connects it) is only for an agent that left the list: one they neither own nor manage.
  expect(sheet).toContain("agents.length > 0 || bare ? undefined : one ? noAiLockedLine(t, one.name, owner)");
});
