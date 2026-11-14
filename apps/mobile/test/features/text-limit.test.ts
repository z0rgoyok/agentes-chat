import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "src", path), "utf8");

describe("a long text field never cuts what is pasted or dictated", () => {
  test.each([
    "features/blocks/ChoicesCard.tsx",
    "features/chat/cards.tsx",
    "features/browser/useFinishHandoff.tsx",
    "features/browser/HandoffCard.tsx",
    "features/settings/GeneralScreen.tsx",
    "features/right-hand/Approvals.tsx",
    "features/agents/AgentProfileScreen.tsx",
    "features/agents/AgentEditScreen.tsx",
    "features/agents/NewAgentScreen.tsx",
    "features/issues/NewIssueForm.tsx",
    "features/members/InvitePeople.tsx",
    "features/members/SuggestPerson.tsx",
    "features/members/JoinRequestsSheet.tsx",
    "features/routines/RoutineForm.tsx",
  ])("%s gives its multi-line field a limit, never a native cut", (file) => {
    const source = read(file);
    expect(source).toMatch(/limit=\{/);
    for (const field of source.matchAll(/<(?:TextArea|PromptForm)\b[\s\S]*?\/>/g))
      if (/limit=\{/.test(field[0])) expect(field[0]).not.toContain("maxLength");
    expect(source).not.toMatch(/\.slice\(0, NOTE_MAX\)/);
  });

  test("the field shows the count near its limit and the line past it; the sheet's button waits", () => {
    const area = read("features/shared/TextArea.tsx");
    expect(area).toContain("LIMIT_NEAR");
    expect(area).toContain("overLimitText");
    expect(area).toContain('tone="danger"');
    const form = read("features/shared/PromptForm.tsx");
    expect(form).toContain("disabled={(!allowEmpty && !text.trim()) || overLimit(text, limit)}");
    expect(form).not.toContain("maxLength");
  });

  test("a written answer on a choice card holds a message; a refusal for its length says to shorten it", () => {
    const card = read("features/blocks/ChoicesCard.tsx");
    expect(card).toContain("limit={{ max: MAX_MESSAGE_LENGTH");
    expect(card).toContain('tooLongRefusal(t, i18n.language, e, t("mobile.choices.tooLongFix"))');
    expect(card).not.toContain("CHOICE_OTHER_MAX");
  });
});
