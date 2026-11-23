import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  askOf,
  connectAiHref,
  connectAiNow,
  endConnectAi,
  patchConnectAi,
  startConnectAi,
} from "../../src/features/ai/connect-flow";
import { MAIN, mainLayout, ownOptionsOf } from "../main-stack";

/**
 * "Conectar uma IA" as real navigation: one pushed screen per page on the native stack, the system's back going one
 * page back, what the pages share in a store that ends with the flow, Pronto leaving the whole flow. The screens are
 * components the tests can't render: what they wire in, as text.
 */
const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("the flow's pages are routes of their own", () => {
  test("its first page and each page after it are pushed screens on the grouped gray", () => {
    expect(existsSync(join(MAIN, "connect-ai.tsx"))).toBe(false);
    const layout = mainLayout();
    for (const page of ["index", "have", "plans", "plan", "key", "makers"]) {
      expect({ page, exists: existsSync(join(MAIN, "connect-ai", `${page}.tsx`)) }).toEqual({ page, exists: true });
      expect({ page, options: ownOptionsOf(`connect-ai/${page}`, layout) }).toEqual({ page, options: "connectAi," });
    }
    expect(layout).toContain("const connectAi = { ...page, contentStyle: { backgroundColor: colors.grouped } };");
    expect(readFileSync(join(MAIN, "connect-ai", "index.tsx"), "utf8")).toContain("<ConnectAiStart />");
    expect(readFileSync(join(MAIN, "connect-ai", "plan.tsx"), "utf8")).toContain('<ConnectAiPushed page="plan" />');
  });

  test("no page swaps in place, nothing steps back by stopping the system's back", () => {
    const sheet = src("ai/ConnectAi.tsx");
    const steps = src("ai/ConnectAiSteps.tsx");
    for (const source of [sheet, steps]) {
      expect(source).not.toContain("usePreventRemove");
      expect(source).not.toContain("onChrome");
      expect(source).not.toContain("setView(");
    }
    expect(steps).not.toContain("flowBack");
    // A page past the first is pushed one deeper; Pronto takes them all, down to the first.
    expect(sheet).toContain("router.push(connectAiHref(flowId, depth + 1, next) as never)");
    expect(sheet).toContain("const leave = () => router.dismiss(depth);");
    expect(sheet).toMatch(/label=\{t\("connectAi\.done"\)\} onPress=\{leave\} \/>/);
    // Criar agente takes the flow's place, its back landing where the flow was opened from.
    expect(sheet).toMatch(/leave\(\);\s+router\.push\(`\/new-agent\?account=/);
    // The first page starts the flow and ends it when it leaves the stack.
    expect(sheet).toContain("const [id] = useState(() => startConnectAi(askOf(params)));");
    expect(sheet).toContain("useEffect(() => () => endConnectAi(id), [id]);");
    expect(sheet).toContain("return <ConnectAiScreen flowId={id} depth={1} view={view} />;");
  });

  test("the makers are a choice that goes back to the key's page; a plan's agent is the pushed agent picker", () => {
    const steps = src("ai/ConnectAiSteps.tsx");
    expect(steps).toContain("<Makers form={props.keyForm} onDone={() => goBack()} />");
    expect(steps).toContain('onMakers={() => go({ page: "makers" })}');
    expect(steps).toContain("ids: agents.map((a) => a.id)");
    expect(steps).toContain('router.push("/agent-pick");');
    expect(steps).toContain("useEffect(() => closeAgentPick, []);");
    expect(steps).not.toContain("pickOne(");
    const pick = src("dashboards/AgentPickScreen.tsx");
    expect(pick).toContain("if (ids) return ids.flatMap((id) => dir.agentById.get(id) ?? []);");
    expect(src("dashboards/agent-pick.ts")).toContain("ids?: readonly string[];");
  });

  test("a row's sign-in and the agent picked go with the flow, not with a page", () => {
    const steps = src("ai/ConnectAiSteps.tsx");
    expect(steps).toMatch(/patchConnectAi\(flowId, \{\s*login: \{ choice, from: a\.id/);
    expect(steps).toContain("patchConnectAi(flowId, { pickedAgent: id ?? null })");
    // A plan's page reads the row's sign-in once, as it was when the page was pushed.
    expect(steps).toContain(
      'const [login] = useState(() => (view.page === "plan" && flow.login?.choice === view.choice ? flow.login : null));',
    );
  });
});

describe("what the pages share", () => {
  test("a flow starts from its address, its key's maker the one asked for", () => {
    const ask = askOf({ agentId: "a1", intent: "api_key", provider: "openai", ready: "", from: ["m1", "m2"] });
    expect(ask).toEqual({ agentId: "a1", intent: "api_key", provider: "openai" });
    const id = startConnectAi(ask);
    expect(connectAiNow(id)).toMatchObject({
      ask,
      linked: [],
      pickedAgent: null,
      login: null,
      waited: false,
      key: { provider: "openai", custom: false, text: "" },
    });
    endConnectAi(id);
  });

  test("its pages change it; once it ends, nothing is kept and nothing changes it", () => {
    const id = startConnectAi({});
    const other = startConnectAi({ provider: "custom" });
    expect(other).not.toBe(id);
    expect(connectAiNow(other)?.key.custom).toBe(true);
    patchConnectAi(id, { pickedAgent: "a2" });
    patchConnectAi(id, (now) => ({ linked: [...now.linked, "a2"], key: { ...now.key, text: "sk-x" } }));
    expect(connectAiNow(id)).toMatchObject({ pickedAgent: "a2", linked: ["a2"], key: { text: "sk-x" } });
    endConnectAi(id);
    expect(connectAiNow(id)).toBeNull();
    patchConnectAi(id, { waited: true });
    expect(connectAiNow(id)).toBeNull();
    // Another flow (Connect an AI opened again from inside this one) keeps its own.
    expect(connectAiNow(other)?.key.custom).toBe(true);
    endConnectAi(other);
  });

  test("a page's address names its flow and how deep it is", () => {
    expect(connectAiHref("connect-3", 2, { page: "plans" })).toBe("/connect-ai/plans?s=connect-3&d=2");
    expect(connectAiHref("connect-3", 3, { page: "plan", choice: "chatgpt" })).toBe(
      "/connect-ai/plan?s=connect-3&d=3&choice=chatgpt",
    );
    expect(connectAiHref("connect-3", 2, { page: "key" })).toBe("/connect-ai/key?s=connect-3&d=2");
    expect(connectAiHref("connect-3", 2, { page: "have" })).toBe("/connect-ai/have?s=connect-3&d=2");
  });
});
