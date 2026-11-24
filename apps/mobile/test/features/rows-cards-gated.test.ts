import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("an agent's row mounts only the cards its message carries", () => {
  const row = src("features/chat/MessageRow.tsx");

  test("each card with queries, the directory or a clock of its own is drawn only on a message that has it", () => {
    for (const gate of [
      "{isAgent && noAiCardOf(meta) ? <NoAiCard message={m} /> : null}",
      "{isAgent && stretchCardOf(meta) ? <StretchCard message={m} /> : null}",
      "{isAgent && costlyProposalOf(meta) ? <CostlyProposalCard message={m} /> : null}",
      "{isAgent && usagePauseCardOf(meta) ? <UsagePauseCard message={m} /> : null}",
      "{isAgent && usageWaitOf(meta) ? <UsageWaitCancel message={m} /> : null}",
      "{isAgent && messageToolOff(meta) ? <WaitToolOffAction message={m} /> : null}",
      "{isAgent && replyChipsOf(meta) ? <ReplyChips message={m} /> : null}",
      "{isAgent && filesTextOnlyOf(meta) ? <FilesTextOnlyFix message={m} /> : null}",
      "{isAgent && settingsCard ? <SettingsProposals message={m} /> : null}",
      "{isAgent && feedbackOfferOf(meta) ? <FeedbackOfferRow message={m} /> : null}",
    ])
      expect({ gate, drawn: row.includes(gate) }).toEqual({ gate, drawn: true });
    expect(row).toContain(
      'const settingsCard = actionKind === "settings_proposal" || actionKind === "workspace_action";',
    );
  });

  test("each gate is the card's own first check: a card never misses a message that carries it", () => {
    const card = (file: string) => src(`features/${file}`);
    expect(card("ai/NoAiCard.tsx")).toMatch(/const card = noAiCardOf\(m\.meta\);\s*if \(!card \|\| /);
    expect(card("ai/StretchCard.tsx")).toMatch(/const card = stretchCardOf\(m\.meta\);\s*if \(!card \|\| /);
    expect(card("ai/CostlyProposalCard.tsx")).toMatch(/const card = costlyProposalOf\(m\.meta\);\s*if \(!card \|\| /);
    expect(card("ai/UsagePauseCard.tsx")).toContain("const card = usagePauseCardOf(m.meta);");
    expect(card("ai/UsagePauseCard.tsx")).toContain(
      "if (!wait || (!skipped && (wait.canceled || wait.ended))) return null;",
    );
    expect(card("devices/ToolOneClick.tsx")).toContain("const off = messageToolOff(message.meta);");
    expect(card("right-hand/TeamCard.tsx")).toMatch(/const chips = replyChipsOf\(m\.meta\);\s*if \(!chips \|\| /);
    expect(card("chat/AgentReceipts.tsx")).toContain("failedRunFix(filesTextOnlyOf(m.meta), {");
    expect(card("right-hand/SettingsCard.tsx")).toContain(
      'const ids = card?.kind === "settings_proposal" ? card.proposalIds : [];',
    );
    expect(card("right-hand/SettingsCard.tsx")).toContain('if (card?.kind === "workspace_action")');
    expect(card("chat/FeedbackOffer.tsx")).toContain("feedbackOfferFor(m.meta, meId)");
  });

  test("its reactions are read once", () => {
    expect(row.match(/useReactions\(orgId, m\.id, false\)/g)?.length).toBe(1);
    expect(row.match(/useToggleReaction\(orgId, m\.id\)/g)?.length).toBe(1);
    expect(row).toContain("hangsUnder(m, Boolean(thread || replying), cachedReactions.data, meId)");
    // The pills take the row's reactions and its toggle.
    expect(row).toContain(
      "<Reactions message={m} reactions={reactions} meId={meId} end={onRight} onToggle={toggle.mutate} />",
    );
  });
});
