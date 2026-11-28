import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvalPhase, PHASE_STATUS } from "@agenteschat/client/lib/approval-card";
import { requestFacts } from "../../src/features/approvals/logic";
import { approval, translator } from "./fixtures";

const read = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");
/** The source between two of its own lines, both of which must be there. */
const between = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect({ from, found: start >= 0 }).toEqual({ from, found: true });
  expect({ to, found: end > start }).toEqual({ to, found: true });
  return source.slice(start, end);
};

describe("the phone's request screen reads as the web's review (ADR 0218, addendum 2026-11-24)", () => {
  test("its facts: where it acts with the repository and its pull request, what it does outside, who answers for it", async () => {
    const pt = await translator("pt-BR");
    const merge = approval({
      id: "m",
      tool: "github_create_issue_comment",
      scope: "github:issues.write",
      connector: "github",
      params: { owner: "acme", repo: "loja", issue_number: 45 },
    });
    const facts = requestFacts(pt, merge, { source: "GitHub", mark: null, role: "Ops" });
    expect(facts.map((f) => [f.label, f.value])).toEqual([
      ["Onde", "GitHub · acme/loja #45"],
      ["Efeito", "Sai da empresa"],
      ["Quem decide", "Qualquer pessoa de Ops"],
    ]);
    // A personal workspace has no company to leave (ADR 0159); a decided request has nobody left to answer for it.
    const personal = requestFacts(
      pt,
      { ...merge, status: "approved" },
      { source: "GitHub", mark: null, personal: true },
    );
    expect(personal.map((f) => f.value)).toEqual(["GitHub · acme/loja #45", "Sai do seu workspace"]);
    // Production is said in amber, as on the web.
    const deploy = approval({ id: "d", tool: "vercel_deploy", scope: "vercel:deploy" });
    expect(requestFacts(pt, deploy, { source: "Vercel", mark: null }).find((f) => f.key === "effect")).toMatchObject({
      value: "Vai para produção",
      tone: "waiting",
    });
  });

  test("each fact once: the deadline stays the fuse's line, how it ended the foot's line, the effect leaves the foot", () => {
    const sheet = read("approvals/ApprovalSheet.tsx");
    const who = between(sheet, "const who = (", "// The decision stays at the screen's foot");
    expect(who.indexOf("<RequestFacts approval={a}")).toBeGreaterThan(who.indexOf("<ApprovalUndoChip approval={a} />"));
    expect(who).toContain("{pending ? <ExpiryLine createdAt={a.createdAt} expiresAt={a.expiresAt} /> : null}");
    expect(sheet).toContain(".filter((tr) => tr !== undo && tr !== effect)");
    expect(read("approvals/logic.ts")).not.toContain("approvals.review.deadline");
  });

  test("what approving lets the agent do, over the buttons; Aprovar sempre on says it in its own row", () => {
    const sheet = read("approvals/ApprovalSheet.tsx");
    const decision = between(sheet, "if (!refusing)", "body = refusing ? (");
    const line = between(decision, "{always ? null : (", "<View style={styles.pair}>");
    expect(line).toContain('t("approvals.review.grants", {');
    expect(line).toContain("doing: approvalDoing(t, a, i18n.language)");
    expect(line).toContain('t("approvals.clickNoteAhead", { when: runAt ?? "" })');
    // The line may wrap: the request scrolls clear of the dock's measured height, not a fixed one.
    expect(sheet).toContain("bottomInset={dock ? dockHeight : 24}");
    expect(sheet).toContain("onLayout={(e) => setDockHeight(Math.ceil(e.nativeEvent.layout.height) + 24)}");
  });

  test("Como chegou aqui: the steps before the ask, the ask, the decision and what ran after, in one block", () => {
    const sheet = read("approvals/ApprovalSheet.tsx");
    expect(sheet).toContain("<ApprovalTrail approval={a} color={agentLook(agent).color} />");
    const trail = between(read("chat/ToolCalls.tsx"), "export function ApprovalTrail(", "/** A call's row:");
    expect(trail).toContain("const around = stepsAround(run.data.steps, a);");
    expect(trail).toContain('milestone("asked", t("approvals.review.asked")');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the component's own template, read as source text
    expect(trail).toContain("t(`approvals.status.${PHASE_STATUS[phase]}`)");
    expect(trail).toContain('text: [t("approvals.review.trail"), t("chat.work.steps", { count: steps })].join(" · ")');
  });

  test("the phases the web and the phone read a request by live in the client, one word each", () => {
    expect(approvalPhase(approval({ id: "p" }))).toBe("waiting");
    const now = Date.now();
    const refused = approval({ id: "r", status: "refused", decidedAt: new Date(now).toISOString() });
    expect(approvalPhase(refused, now)).toBe("refused");
    const ran = approval({ id: "a", status: "approved", decidedAt: new Date(now).toISOString(), executedAt: "x" });
    expect(PHASE_STATUS[approvalPhase(ran, now) as Exclude<ReturnType<typeof approvalPhase>, "waiting">]).toBe(
      "approved",
    );
  });
});
