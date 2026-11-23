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

test("Sua IA is one row that opens its choice: what answers me, by its logo and what it is to me; Lodi's settings open with it", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  const profile = readFileSync(join(import.meta.dir, "../../src/features/agents/AgentProfileScreen.tsx"), "utf8");
  // The four states come from the client's rule, as on the web (ADR 0137 §11).
  expect(screen).toContain('const status = mineStatus(view, meId ?? "", platform, agent.brain?.maker);');
  for (const kind of ["nobody", "own", "key"]) expect(screen).toContain(`status.kind === "${kind}"`);
  // A plan of mine or lent to me: its maker's logo and whose it is. The sheet holds the ways out, the one in use
  // checked: another plan, or back to the workspace's. No word at the row's end, no second row under it.
  expect(screen).toContain('<ProviderLogo id={status.brain} size="sm" />');
  expect(screen).toContain("value: own ? MINE : WORKSPACE,");
  expect(screen).toContain('{ key: OTHER, label: t("agentPage.work.brain.connectPlan")');
  expect(screen).toContain("else if (picked === OTHER || (picked === MINE && !own)) connect();");
  // The plan's model is a choice of the same sheet, under the plan, and opens the model's page: account and model in
  // one place, as on an agent's AI. The row behind says the model too.
  expect(screen).toContain('key: MODEL,\n              label: t("agentPage.work.brain.planModel"),');
  expect(screen).toContain("if (picked === MODEL) openAgentModel(agent.id);");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the screen's source
  expect(screen).toContain("sub={model ? `${sub} · ${model}` : sub}");
  expect(screen).toContain("else if (picked === WORKSPACE && own) back();");
  expect(screen).not.toContain("value={t(");
  expect(screen).not.toContain("onPress={back}");
  expect(screen).toContain('t("rightHand.settings.mineOf", { owner: first(status.ownerId) })');
  expect(screen).toContain('{ scope: "mine", brain: "model" }');
  // The workspace's key or plan answers me: what it is, and Usar meu plano.
  expect(screen).toContain('t(status.kind === "key" ? "rightHand.settings.mineKey" : "rightHand.settings.minePlan")');
  expect(screen).toContain('{ key: MINE, label: t("rightHand.settings.useMine")');
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
    '? { action: { label: t("rightHand.profile.configure"), onPress: openRightHandSettings } }',
  );
  expect(profile).not.toContain(
    '? can(org, "manage_agents")\n              ? { action: { label: t("rightHand.profile.configure")',
  );
});

test("Lodi's settings: the workspace's plan has no lending switch, since a plan serves the whole workspace", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  // The workspace's AI is read and saved as such; the look opens from the row, with no "Mudar visual" on it.
  expect(screen).toContain('useAgentBrain(orgId, agent.id, true, false, "workspace")');
  expect(screen).toContain('{ scope: "workspace", ...input }');
  expect(screen).not.toContain("rightHand.settings.changeLook");
  // Who a plan serves is its owner's choice in IA e uso (ADR 0059 §3), not a switch here.
  expect(screen).not.toContain("rightHand.settings.lend");
  expect(screen).not.toContain("set({ onlyOwner: on })");
  expect(screen).toContain('t("rightHand.settings.planName", { name: a.label })');
  // The budget only where something bills per use, the audience only with someone else here.
  expect(screen).toContain("{usesApi ? (");
  expect(screen).toContain("{solo ? null : (");
  // What it is now is one row that opens the choice of the key or a plan, the one in use checked: no loose
  // "Usar uma chave de API" row and no second list of plans under another heading.
  expect(screen).toContain('title: t("rightHand.settings.workspace"),');
  expect(screen).toContain("value: kind ? (view?.account ?? null) : KEY,");
  expect(screen).toContain('if (kind) set({ brain: "model" });');
  expect(screen).toContain("set({ brain: plan.kind, account: plan.id });");
  expect(screen).toContain("disabled={busy || hold}");
  // On a plan, its model is the row under it (as the key's model is), saved as the workspace's.
  expect(screen).toContain('onPress={() => openAgentModel(agent.id, "workspace")}');
  const model = readFileSync(join(import.meta.dir, "../../src/features/ai/AgentAiScreen.tsx"), "utf8");
  const saves = readFileSync(join(import.meta.dir, "../../src/features/ai/useSaveBrain.ts"), "utf8");
  expect(model).toContain("const brain = useAgentBrain(orgId, agentId, true, false, scope);");
  expect(model).toContain("const { pending, save } = useSaveBrain(agentId, scope);");
  expect(saves).toContain("api.agents.setBrain(orgId, agentId, { ...(scope ? { scope } : {}), ...input })");
  expect(screen).not.toContain("noAi.rightHand.useKey");
  expect(screen).not.toContain("workspacePlan");
  // Any plan's CLI: Claude Code's, Codex's, Cursor's, OpenCode's, Grok Build's or the Antigravity CLI's.
  expect(screen).toContain('agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null');
  expect(screen).toContain("t(`aiAccounts.connect.$" + "{kind}`)");
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

test("the workspace's plan choice and its plans it can't think with now list each account once, as on the web", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/right-hand/SettingsScreen.tsx"), "utf8");
  expect(screen).toContain("const listed = accountChoices(");
});
