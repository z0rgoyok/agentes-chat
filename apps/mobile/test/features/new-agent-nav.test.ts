import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProposal } from "@agenteschat/client";
import { handleForName } from "@agenteschat/client/lib/new-agent";
import { IMPORT_AGENTS_HREF, IMPORT_PREVIEW_HREF } from "../../src/features/agents/import";
import {
  changeHref,
  flowDepth,
  NEW_AGENT_PHONE_STEPS,
  NEW_AGENT_STEP_HREF,
  nextStep,
  stepOf,
} from "../../src/features/agents/new-agent";
import {
  draftDirty,
  editNewAgent,
  endNewAgent,
  finishNewAgent,
  holdNewAgentRelease,
  type NewAgentStart,
  newAgentNow,
  startNewAgent,
} from "../../src/features/agents/new-agent-flow";
import { MAIN, pushedByDefault } from "../main-stack";

const src = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "src", "features", path), "utf8");
const route = (name: string) => readFileSync(join(MAIN, `${name}.tsx`), "utf8");

const START: NewAgentStart = {
  what: "",
  suggested: "Ada",
  from: null,
  channelId: null,
  accountId: null,
  levels: {},
  mail: {},
};

describe("Criar agente is real navigation: one pushed screen per step", () => {
  test("every step and the import are routes of their own, pushed with the stack's bar and back", () => {
    for (const name of [
      "new-agent/index",
      "new-agent/role",
      "new-agent/identity",
      "new-agent/instructions",
      "new-agent/review",
      "new-agent/import",
      "new-agent/import-preview",
    ])
      expect({ name, pushed: pushedByDefault(name) }).toEqual({ name, pushed: true });
    // The one screen that swapped its steps in place is gone.
    expect(existsSync(join(MAIN, "new-agent.tsx"))).toBe(false);
    for (const step of NEW_AGENT_PHONE_STEPS) {
      expect(NEW_AGENT_STEP_HREF[step]).toBe(`/new-agent/${step}`);
      expect(route(`new-agent/${step}`)).toContain(`<NewAgentStepScreen step="${step}"`);
    }
    expect(IMPORT_AGENTS_HREF).toBe("/new-agent/import");
    expect(IMPORT_PREVIEW_HREF).toBe("/new-agent/import-preview");
    expect(route("new-agent/import")).toContain("<NewAgentImportScreen />");
    expect(route("new-agent/import-preview")).toContain("<NewAgentImportPreviewScreen />");
  });

  test("a step goes on to the next one; Revisar's rows open a step to change it, saying why when Criar sent it", () => {
    expect(NEW_AGENT_PHONE_STEPS.map(nextStep)).toEqual(["identity", "instructions", "review", null]);
    expect(changeHref("identity")).toBe("/new-agent/identity?change=1");
    expect(changeHref("role", true)).toBe("/new-agent/role?change=1&tried=1");
  });

  test("the bar counts the steps from where the flow started; a proposal's Revisar and a change count nothing", () => {
    expect(stepOf("role", "role")).toEqual({ step: 1, total: 4 });
    expect(stepOf("role", "review")).toEqual({ step: 4, total: 4 });
    // An example of the empty Conversas starts on who it is: three steps, the role not among them.
    expect(stepOf("identity", "identity")).toEqual({ step: 1, total: 3 });
    expect(stepOf("identity", "role")).toBeNull();
    expect(stepOf("review", "review")).toBeNull();
  });

  test("finishing leaves the flow's screens at once, down to its first one, never a flow under it", () => {
    const flow = ["new-agent/index", "new-agent/identity", "new-agent/instructions", "new-agent/review"];
    expect(flowDepth(["(tabs)", "chat/[channelId]", ...flow])).toBe(4);
    // A step opened from Revisar to change it is on top of the same flow.
    expect(flowDepth(["(tabs)", ...flow, "new-agent/role"])).toBe(5);
    // The import from Configurações › Importar e exportar: only its own two screens.
    expect(flowDepth(["(tabs)", "me/index", "new-agent/import", "new-agent/import-preview"])).toBe(2);
    expect(flowDepth(["(tabs)", "new-agent/index", "new-agent/review", "new-agent/index", "new-agent/identity"])).toBe(
      2,
    );
    expect(flowDepth(["(tabs)", "agent/[id]"])).toBe(0);
  });
});

describe("the draft the steps share", () => {
  test("starts on the role, on who it is with an example, or on Revisar with a proposal", () => {
    const fresh = startNewAgent({ ...START, channelId: "c1" });
    expect(fresh).toMatchObject({ entry: "role", role: null, name: "", instructions: "", asked: ["c1"] });
    expect([...fresh.channelIds]).toEqual(["c1"]);
    expect(draftDirty(fresh)).toBe(false);
    const example = startNewAgent({ ...START, what: "Answers the support inbox" });
    expect(example).toMatchObject({
      entry: "identity",
      role: "custom",
      name: "Ada",
      handle: handleForName("Ada"),
      instructions: "Answers the support inbox",
    });
    expect(draftDirty(example)).toBe(true);
    const from = {
      messageId: "m1",
      canDecide: true,
      params: {
        draft: { name: "Lia", handle: "lia", role: "Recepção", instructions: "Atende", channelIds: ["c2"] },
        why: "",
      },
    } as unknown as AgentProposal;
    const proposal = startNewAgent({ ...START, from, levels: { github: "read" } });
    expect(proposal).toMatchObject({
      entry: "review",
      role: "custom",
      roleText: "Recepção",
      name: "Lia",
      handle: "lia",
      handleTouched: true,
      proposedLevels: { github: "read" },
    });
    expect([...proposal.channelIds]).toEqual(["c2"]);
    endNewAgent(proposal.id);
  });

  test("a step's change is everyone's; finishing lets the first screen's guard go; only its own first screen ends it", () => {
    const first = startNewAgent(START);
    editNewAgent({ name: "Lu" });
    editNewAgent((now) => ({ handle: `${now.name.toLowerCase()}-1` }));
    expect(newAgentNow()).toMatchObject({ name: "Lu", handle: "lu-1" });
    const now = newAgentNow();
    expect(now && draftDirty(now)).toBe(true);
    let released = 0;
    holdNewAgentRelease(first.id, () => {
      released += 1;
    });
    finishNewAgent();
    expect(released).toBe(1);
    const made = newAgentNow();
    expect(made && draftDirty(made)).toBe(false);
    // A newer flow is not ended by the older first screen going away.
    const second = startNewAgent(START);
    endNewAgent(first.id);
    expect(newAgentNow()?.id).toBe(second.id);
    endNewAgent(second.id);
    expect(newAgentNow()).toBeNull();
    // With no flow open, a late change writes nothing.
    editNewAgent({ name: "late" });
    expect(newAgentNow()).toBeNull();
  });
});

describe("no fake back anywhere in the flow", () => {
  const screen = src("agents/NewAgentScreen.tsx");

  test("no step drawn in place, no Back word, the system's back between steps", () => {
    expect(screen).not.toContain("usePreventRemove");
    expect(screen).not.toContain('t("common.back")');
    expect(screen).not.toContain("goTo(");
    expect(screen).not.toContain("setIndex");
    expect(screen).not.toContain("setImporting");
    expect(screen).not.toContain("closeImport");
    expect(screen).not.toContain("newAgent.backToChat");
    // On to the next step's screen, pushed.
    expect(screen).toContain("if (next) router.push(NEW_AGENT_STEP_HREF[next]);");
    // From Revisar, each row opens its step over it.
    for (const step of ["identity", "role", "instructions"])
      expect(screen).toContain(`onPress={() => router.push(changeHref("${step}"))}`);
    // The import is its own screens: the picker, then what a read found pushed over it, back dropping the plan.
    expect(screen).toContain("onPress={() => router.push(IMPORT_AGENTS_HREF)}");
    expect(screen).toContain("if (planned) router.push(IMPORT_PREVIEW_HREF);");
    expect(screen).toMatch(/return \(\) => \{\s+left\.current = true;\s+resetAgentImport\(\);/);
    expect(src("agents/ImportAgents.tsx")).not.toContain("export function ImportAgents(");
  });

  test("leaving the flow with something typed asks once, on its first screen; finishing leaves every screen of it", () => {
    expect(screen.match(/useUnsavedGuard\(/g)).toHaveLength(1);
    expect(screen).toContain("const leave = useUnsavedGuard(draftDirty(d));");
    expect(screen).toContain("useEffect(() => holdNewAgentRelease(first.id, leave), [first.id, leave]);");
    expect(screen).toContain("useEffect(() => () => endNewAgent(first.id), [first.id]);");
    expect(screen).toContain("if (depth > 0) router.dismiss(depth);");
    // Made: the guard lets go before anything navigates; a proposal goes back to its conversation past every step.
    const submit = screen.slice(
      screen.indexOf("const submit = async"),
      screen.indexOf("return (", screen.indexOf("const submit = async")),
    );
    expect(submit.indexOf("finishNewAgent();")).toBeGreaterThan(submit.indexOf("await create.mutateAsync"));
    expect(submit.indexOf("finishNewAgent();")).toBeLessThan(submit.indexOf("leaveFlow();"));
    expect(submit.indexOf("finishNewAgent();")).toBeLessThan(submit.indexOf("void openDm("));
    // What it thinks with, in the toast, is the AI chosen, not the apps' levels saved a few lines above.
    expect(submit).toContain("const grants = Object.fromEntries(");
    expect(submit).toContain("const thinksLabel = pickRow ? choiceText(t, pickRow, i18n.language).label : startsOn;");
  });

  test("a step opened from Revisar says Pronto and goes back there once; the next step's Continuar waits on its rules", () => {
    expect(screen).toContain('label={change ? t("mobile.common.done") : t("common.continue")}');
    expect(screen).toMatch(/if \(change\) \{\s+if \(gone\.current\) return;\s+gone\.current = true;\s+goBack\(\);/);
    expect(screen).toMatch(
      /if \(stepBlocked\("identity", \{ role: d\.role, name, handle, taken \}\)\) \{\s+setTried\(true\);/,
    );
    // A tap on a role moves on a beat later, never once the screen went away.
    expect(screen).toContain("useEffect(() => () => clearTimeout(timer.current), []);");
  });
});
