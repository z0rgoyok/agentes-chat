import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The phone's digest card as text: the component can't be rendered here, so what it must hold is read from it. */
const source = readFileSync(join(import.meta.dir, "../../src/features/ai/OfferApprovals.tsx"), "utf8");

test("the one tap approves only what the server calls routine, and the card works nothing out by itself", () => {
  expect(source).toContain('decision: "approve", only: "routine"');
  expect(source).toContain("digestGroups(");
  // The group shows on a digest only, never on a card an agent posted when asked.
  expect(source).toContain("card.digest ? digestGroups(");
  // One summary: the pill's words count what waits, as the web's first line does.
  expect(source).toContain("words={digestLine(t, digestCounts(listed))}");
  // Its rows are the web's (the same requests of one agent on one row, the first three until asked for the rest),
  // with the agent that asked and what the calls hold under each name.
  expect(source).toContain("digestRows(");
  expect(source).toContain("(a) => approvalDetail(a, i18n.language),");
  expect(source).toContain("[dir.anyAgent(row.agentId)?.name, row.detail]");
  expect(source).toContain("{row.count > 1 ? `");
  expect(source).toContain(" × ");
  expect(source).toContain('t("rightHand.digest.more", { count: group.hidden })');
  // Opened, the same line folds the rows back.
  expect(source).toContain("group.folds ? (");
  expect(source).toContain('all ? t("folded.less")');
  expect(source).toContain("onPress={() => setAll((v) => !v)}");
  // No risk is judged on the phone: the words that would do it never appear.
  expect(source).not.toMatch(/approvalRisk|approvalAction|highRisk/);
  // Approved, the phone says so as the conversation's "Aprovar tudo" does. A failure says its cause.
  expect(source).toContain("successHaptic()");
  expect(source).toContain('t("mobile.approval.approved")');
  expect(source).toContain("errorText(t, error, i18n.language)");
});
