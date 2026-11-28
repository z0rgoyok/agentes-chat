import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("in bubbles, the cards under someone else's words are bubbles of that message", () => {
  const row = src("features/chat/MessageRow.tsx");
  expect(row).toContain("const bubblePart = bubbled ? { fill: otherFill, edge: bubbleEdge } : null;");
  expect(row).toContain("<RowParts top={partTop} part={bubblePart} head={bubbleHead}>");
  expect(row).toContain("<BubblePartContext.Provider value={part}>");
  // Three points under the bubble, as a run of bubbles; cards of a message with no words start where it does.
  expect(row).toContain("const BUBBLE_JOIN = 3;");
  expect(row).toContain("const partTop = bubbled && (body || media) ? BUBBLE_JOIN - rhythm.part : cardTop;");
  // Every card on the shared surface takes the bubble's fill and no shadow there.
  const parts = src("features/shared/parts.tsx");
  expect(parts).toMatch(/part\s*\?\s*\{ backgroundColor: part\.fill, \.\.\.part\.edge \}/);
  // The ones outlined elsewhere (its tools, what it changed, a check, a poll, the work it handed) take the one frame
  // of a message's card: the bubble's fill and no outline there (`useMessageCardFrame`, below).
  expect(src("features/chat/Receipts.tsx")).toContain("const frame = [styles.card, card.style];");
  // The work it handed is a quiet line under the bubble, its mark where the bubble's words start.
  expect(src("features/chat/WorkLine.tsx")).toContain("quietInBubble: { paddingLeft: 14 },");
  expect(src("features/shared/bubble-part.ts")).toContain(
    "export const BUBBLE_PART_CORNERS = corners(RADIUS.sm, RADIUS.xl, RADIUS.xl, RADIUS.sm);",
  );
});

test("one frame for every card in a message: the bubble's fill with no outline in bubbles, the bubble's sides", () => {
  const look = src("features/chat/look.ts");
  expect(look).toContain("style: [{ backgroundColor: part.fill, borderWidth: 0 }, cardCorners, part.edge],");
  // In a message of the other looks, raised with a hairline; outside a message, the app's raised card.
  expect(look).toContain(
    "? { backgroundColor: colors.raised, borderColor: colors.line2, borderWidth: StyleSheet.hairlineWidth }",
  );
  expect(look).toContain(": { backgroundColor: colors.raised, boxShadow: ");
  const framed = [
    "features/chat/Receipts.tsx",
    "features/chat/ToolCalls.tsx",
    "features/chat/TeamChecks.tsx",
    "features/chat/ReachLines.tsx",
    "features/chat/FeedbackOffer.tsx",
    "features/chat/WorkLine.tsx",
    "features/right-hand/TeamWeekCard.tsx",
    "features/blocks/PollCard.tsx",
    "features/blocks/ChoicesCard.tsx",
    "features/blocks/LiveBlock.tsx",
    "features/chat/asks.tsx",
    "features/chat/issue-work.tsx",
    "features/missions/cards.tsx",
    "features/files/MessageFiles.tsx",
    "features/browser/HandoffCard.tsx",
    "features/live-files/LiveFileCard.tsx",
  ];
  for (const file of framed) {
    const text = src(file);
    expect([file, text.includes(" = useMessageCardFrame();")]).toEqual([file, true]);
    // Never a surface of its own beside the frame's: that is what left two kinds of card in one conversation.
    expect([
      file,
      /backgroundColor: c(olors)?\.raised, borderColor: c(olors)?\.line2 \}, cardCorners/.test(text),
    ]).toEqual([file, false]);
  }
  // A bubble has no sky across its top, in a poll, a choice or a block as in a request.
  for (const file of ["features/blocks/PollCard.tsx", "features/blocks/LiveBlock.tsx"])
    expect([file, src(file).includes("{card.bubble ? null : (")]).toEqual([file, true]);
  expect(src("features/blocks/ChoicesCard.tsx")).toContain("const sky = card.bubble ? null : (");
  // The sides: a bubble's own 14, so a card's content starts where the words over it do.
  expect(src("ui/rhythm.ts")).toContain("export const MESSAGE_CARD_X = 14;");
  expect(src("ui/RowAction.tsx")).toContain(
    "export const ROW_CARD_INSET = { paddingLeft: MESSAGE_CARD_X, paddingRight: MESSAGE_CARD_X - FACE_PAD } as const;",
  );
  for (const file of [
    "features/chat/Receipts.tsx",
    "features/chat/asks.tsx",
    "features/chat/WorkLine.tsx",
    "features/chat/issue-work.tsx",
    "features/missions/cards.tsx",
    "features/files/MessageFiles.tsx",
  ])
    expect([file, src(file).includes("paddingHorizontal: MESSAGE_CARD_X")]).toEqual([file, true]);
  // A tool block's head and rows on the same 14 (the lines' 4 and a row's own 10).
  expect(src("features/chat/ToolCalls.tsx")).toContain("const ROW_PAD = 10;");
});

test("one hierarchy for the words of every card in a message", () => {
  const text = src("ui/Text.tsx");
  // A step under the message's words (17): the title 15 semibold, what it is 13 semibold over it.
  expect(text).toContain('cardTitle: ["subhead", weights.semibold],');
  expect(text).toContain('cardKind: ["footnote", weights.semibold],');
  const titled = [
    "features/chat/WorkLine.tsx",
    "features/chat/asks.tsx",
    "features/chat/issue-work.tsx",
    "features/missions/cards.tsx",
    "features/files/MessageFiles.tsx",
    "features/blocks/ChoicesCard.tsx",
  ];
  for (const file of titled) expect([file, src(file).includes('variant="cardTitle"')]).toEqual([file, true]);
  // Never the message's own size for a card's title, nor a caption for what it is.
  for (const file of [
    "features/missions/cards.tsx",
    "features/files/MessageFiles.tsx",
    "features/chat/issue-work.tsx",
  ]) {
    const card = src(file);
    expect([file, /<Text variant="(body|callout)"/.test(card)]).toEqual([file, false]);
    expect([file, card.includes('variant="caption" tone="muted" style={styles.bold}')]).toEqual([file, false]);
  }
  // Handed work: its title over its state as a status badge (the lists' and the web's), then its facts.
  const work = src("features/chat/WorkLine.tsx");
  expect(work).toContain("<StatusBadge text={h.state} tone={badgeTone} color={agentColor} />");
  const quote = src("features/chat/RelayQuote.tsx");
  expect(quote).toContain('<Text variant="small" numberOfLines={1} style={[quote.name, { color: ink }]}>');
  // The waiting card, a thread's link, the tool block's head and the name line's words take the same roles.
  expect(src("features/shared/WaitingCard.tsx")).toContain('<Text variant="cardTitle" numberOfLines={3}>');
  expect(src("features/chat/ToolCalls.tsx")).toContain('<Text variant="label" tone="ink2" numberOfLines={1}>');
  expect(src("features/chat/cards.tsx")).toContain('<Text variant="label" tone="ink2">');
  expect(src("features/chat/MessageRow.tsx")).not.toContain(
    'variant="caption" tone="muted" numberOfLines={1} style={styles.medium}',
  );
  // "Show more" is an action said as a word, in a bubble as under a folded text.
  for (const file of ["features/chat/ClippedMessage.tsx", "features/chat/FoldedBody.tsx"])
    expect([file, src(file).includes('<Text variant="label" tone="ink2"')]).toEqual([file, true]);
});

test("a message that is only a request is a bubble of its own: its name at the top, its time at the end", () => {
  const row = src("features/chat/MessageRow.tsx");
  expect(row).toContain("[approvalId, question, secret].filter(Boolean).length === 1;");
  expect(row).toContain("const bubbleHead = askAlone ? { who: who(true), time: when.time(m.createdAt) } : null;");
  expect(row).toContain("{nameLine && !askAlone ? who(false) : null}");
  const asks = src("features/chat/asks.tsx");
  expect(asks).toContain("{bubbleHead ? <View style={styles.bubbleHead}>{bubbleHead.who}</View> : null}");
  expect(asks).toContain("{bubbleHead.time}");
  // A bubble has no sky across its top, and the preview fades into the bubble's own fill.
  expect(asks).toContain(
    '{part ? null : <Sky color={sky} depth={0.55} fade={0.15} surface="raised" style={styles.sky} />}',
  );
  expect(asks).toContain("colors={[withOpacity(fill, 0), fill]}");
});
