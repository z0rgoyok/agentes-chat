import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatScreenSource } from "./chat-screen-source";

/** A file of the app, as text: where a reply's parts go lives in components the tests can't render. */
const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/chat", path), "utf8");
/** Where each piece first shows in a file, in the order given. */
const at = (text: string, pieces: string[]) =>
  pieces.map((p) => {
    const i = text.indexOf(p);
    if (i < 0) throw new Error(`not found: ${p}`);
    return i;
  });
const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || (xs[i - 1] ?? 0) < x);

describe("a reply's tools sit last", () => {
  test("saved: its words, what it changed and its cards, then its tools", () => {
    const row = source("MessageRow.tsx");
    expect(
      ascending(
        at(row, [
          "{openerPart}\n                    {words}\n                  </>\n                )}",
          "<Receipts message={m} onTap={onTap} onLongPress={press} />",
          "{cards}\n            {/* Its tools after",
          "<TurnTools",
          "<SavedTools",
          "<NoAiCard message={m} />",
          // The foot is the reply's last part: only the double tap's one-time hint follows it in the body (the time a
          // pull shows and the 👍 over the row are outside it).
          "{foot}\n          </RowParts>\n          {hintNode}\n        </Animated.View>\n",
        ]),
      ),
    ).toBe(true);
    // The cards above the tools are an issue's and a mission's; the thread, the reactions and the send state go under.
    const [cardsAt, footAt, endAt] = at(row, ["const cards = (", "const foot = (", "\n  if (onRight) {"]);
    const cards = row.slice(cardsAt, footAt);
    const foot = row.slice(footAt, endAt);
    for (const card of ["<IssueWorkCard", "<MissionCard", "<PlanCard", "<ReviewCard", "<SetupFailedCard"])
      expect([card, cards.includes(card)]).toEqual([card, true]);
    for (const part of ["<ThreadLink", "<Reactions", "<Sending"])
      expect([part, foot.includes(part)]).toEqual([part, true]);
  });

  test("what waits for a person's click comes after the tools, the thread and reactions under it", () => {
    const row = source("MessageRow.tsx");
    const [toolsAt, footAt] = at(row, [
      "<SavedTools\n",
      "{foot}\n          </RowParts>\n          {hintNode}\n        </Animated.View>\n",
    ]);
    const last = row.slice(toolsAt, footAt);
    for (const card of [
      "<NoAiCard",
      "<StretchCard",
      "<ProposalCard",
      "<InstructionProposals",
      "<ApprovalInline",
      "<HandoffCard",
      "<QuestionCard",
      "<SecretCard",
      "{missionDecision}",
    ])
      expect([card, last.includes(card)]).toEqual([card, true]);
  });

  test("live: none drawn, nor any of its words: the reply brings them whole", () => {
    const live = source("LiveRows.tsx");
    for (const part of ["<TurnTools", "<RevealText", "run.text"])
      expect([part, live.includes(part)]).toEqual([part, false]);
  });
});

describe("agents it asked first: quoted at the top of the reply, as a reply quotes a message", () => {
  test("saved: the quote opens the reply's words, in its bubble or over its words; with none, it stands alone", () => {
    const row = source("MessageRow.tsx");
    // In the bubble: the name line, the agents' talk, then the reply's own quote and words.
    expect(
      ascending(
        at(row, ["who(true) : null}", "{quoteInWords}", "{quote ? <QuotePlate reply={quote} onJump={onQuote} />"]),
      ),
    ).toBe(true);
    // A reply with no words (only cards) shows the quote on its own before it, and its face and name again.
    expect(row).toContain("const quoteAlone = consultQuote !== null && (!body || Boolean(choiceReply));");
    expect(row).toContain("const grouped = groupedIn && !quoteAlone;");
    expect(row).toContain("<ConsultQuote askerId={m.author.id} channelId={m.channelId} items={paired} alone />");
  });

  test("a face inside a line of words stands in its sky tile, in its middle", () => {
    const face = readFileSync(join(import.meta.dir, "../../src/features/shared/Face.tsx"), "utf8");
    expect(face).toContain("<AgentFace agentId={agentId} size={size} live={false} framed />");
  });

  test("live: the working line carries the pair, the one asking and the one asked, while the turn works", () => {
    const live = source("LiveRows.tsx");
    expect(live).not.toContain("useRunConsults");
    expect(
      ascending(
        at(live, [
          "if (asking && e.consult === asking)",
          '<AgentFace agentId={e.id} size={18} framed mode="idle" />',
          "agentId={asking.to}",
          'mode={asking.yours || asking.wait ? "idle" : "think"}',
        ]),
      ),
    ).toBe(true);
  });

  test("the quote says no answer: the agent asked, how it went, the question's subject, a chevron", () => {
    const pair = source("ConsultGroup.tsx");
    expect(pair).not.toContain("previewOf");
    expect(pair).not.toContain(".answer");
    expect(pair).not.toContain("ConsultPairRow");
    // No colored bar at its left edge: a plate a step off the bubble, the agent's name in its color.
    expect(pair).not.toContain("quote.bar");
    expect(pair).toContain('<Text variant="footnote" tone="muted" numberOfLines={2}>');
    // Standing alone, it says who asked: the asker's name and the arrows.
    expect(pair).toContain('<Icon name="swap" size={12}');
  });

  test("a notice whose reply isn't here is the same quote on its own, not a card with the answer", () => {
    const line = source("EventLine.tsx");
    expect(line).toContain("items={[pairItemOf(consulted.consultation)]}");
    expect(source("cards.tsx")).not.toContain("Consultation");
  });

  test("an answer far below its question is the same quote on its own, never a line of words or a pill", () => {
    const line = source("EventLine.tsx");
    expect(line).toContain("items={[fold.consultation]}");
    expect(line).not.toContain("consultFarKey");
    expect(source("ConsultGroup.tsx")).not.toContain("TalkPill");
  });

  test("a hand-off by direct message is the same quote on its reach line, left out of the reply's own", () => {
    const reach = source("ReachLines.tsx");
    expect(reach).toContain("<ConsultQuote askerId={authorId} channelId={channelId} items={[talk]} alone />");
    expect(reach).not.toContain("reach.see");
    // One older than the conversation's list goes back is loaded on its own, never the "Entregue ao" text.
    expect(source("ConsultGroup.tsx")).toContain(
      "useConsultationConversation(orgId, channelId, id && loaded && !listed ? id : null)",
    );
    const row = source("MessageRow.tsx");
    expect(row).toContain("const reached = useMemo(() => reachHandoffs(m.meta), [m.meta]);");
    expect(row).toContain("    consulted,\n    reached,\n  );");
  });
});

describe("an exchange between the same two agents", () => {
  test("is one row on its first asking run's reply, and one conversation when opened", () => {
    // Grouped once for the conversation (`RowConsults`), each reply's row reading its run's.
    expect(source("row-data.tsx")).toContain("byRun: groupsByRun(asExchanges(list ?? []))");
    expect(source("ConsultGroup.tsx")).toContain(
      "const group = useRowConsultsPart(where.channelId, (list) => (runId ? list.byRun.get(runId) : undefined), sameItems);",
    );
    // Each row follows only its own part of the questions: a reload while one is out (every 10 s, its progress moving)
    // draws again the rows whose part changed, not every message on screen.
    expect(source("row-data.tsx")).toContain(
      "return useSyncExternalStore(store?.subscribe ?? noSubscription, read, read);",
    );
    expect(source("MessageRow.tsx")).toContain("const helping = useRowConsultsPart(m.channelId, (list) =>");
    expect(source("ConsultGroup.tsx")).not.toContain("useRowConsults(");
    expect(source("ConsultGroup.tsx")).toContain("consultPair(items, now, askerId,");
    expect(chatScreenSource()).toContain("asExchanges(consultData)");
    expect(source("ConsultationScreen.tsx")).toContain("useExchangeConversation(");
  });
});

describe("one call is its own line", () => {
  test("live, kept and saved replies and a single question to a teammate draw the line, not the block", () => {
    const tools = source("ToolCalls.tsx");
    expect(tools).toContain("const one = oneCall(items);");
    expect(tools).toContain("one={one}");
    expect(tools).toContain("const lone = savedOneLine(meta, onCard);");
    expect(tools).toContain("<Line line={{ ...only.line, detail }} color={color} onToggle={onToggle} keep={keep} />");
  });
});

describe("nothing more than the message shows", () => {
  test("a lone quick read draws no block; no block opens on nothing or says it used no tools", () => {
    const tools = source("ToolCalls.tsx");
    expect(tools).toContain("const now = quietWork(items) || (done && !shows) ? null : toolNow(items);");
    expect(tools).toContain("if (lone && lone.ms !== null && quietLine(lone)) return null;");
    expect(tools).toContain("const shown = compact ? workSteps(compact, onCard) : 0;");
    expect(tools).not.toContain("chat.work.none");
    expect(tools).not.toContain("chat.work.see");
  });
});

describe("what agents did under each reply: the person's own setting, off by default", () => {
  test("off, a done reply draws nothing and a saved one no block; the live block stays", () => {
    const tools = source("ToolCalls.tsx");
    // Done and off: no call is "now", so nothing shows (the branch for a reply with no call: its words are the reply).
    // The setting is read through `useShowsWork`: in a code session's conversation the work always shows (ADR 0215).
    expect(tools).toContain("const shows = useShowsWork(org);");
    expect(tools).toContain("(done && !shows) ? null : toolNow(items);");
    expect(tools).toContain('const said = done ? [] : items.flatMap((i) => (i.kind === "say" ? [i] : []));');
    expect(tools).toContain("if (!compact || shown === 0 || !shows) return null;");
    // The cards that carry content or wait for a person aren't the tools' and stay in the row.
    const row = source("MessageRow.tsx");
    expect(row).toContain("<SecretCard");
    // Where it browsed and its desktop are step summaries (no picture): activity, gated like the tools.
    expect(row).toContain("const shows = useShowsWork(org);");
    expect(row).toContain("isAgent && m.author.id && !m.local && shows");
    expect(row).not.toContain("showsActivity");
    // A code session's conversation says so around its rows.
    expect(source("ChatScreen.tsx")).toContain("<CodeConversation.Provider value={codeId !== null}>");
  });

  test("Você has the row and its page, and a secret request's card shows without its text", () => {
    const me = readFileSync(join(import.meta.dir, "../../src/features/me/MeScreen.tsx"), "utf8");
    expect(me).toContain('onPress={() => open("/me/activity")}');
    const route = readFileSync(join(import.meta.dir, "../../app/(app)/(main)/me/activity.tsx"), "utf8");
    expect(route).toContain("<ActivityPage />");
    expect(source("logic.ts")).toMatch(/hidesBody = [^;]*secretRequestOf\(m\.meta\)/);
  });
});

describe("what an agent changed wraps whole, on a card as wide as its words", () => {
  test("a receipt's sentence and each line under it wrap whole, never cut with '…'; team checks wrap", () => {
    // No renderer for the phone's components in these tests: the line limits are read from the source.
    const receipts = source("Receipts.tsx");
    // The sentence, and the line every line under it is drawn with (its files, what it does alone, who undid it).
    const sentence = receipts.slice(receipts.indexOf("function Sentence("), receipts.indexOf("function ChangesSheet("));
    expect(sentence).not.toContain("numberOfLines");
    const under = receipts.slice(receipts.indexOf("const UnderLine = "), receipts.indexOf("function UndoneLine("));
    expect(under).not.toContain("numberOfLines");
    for (const line of ["lines.files", "lines.own", "lines.undone"])
      expect(receipts).toContain(`<${line === "lines.undone" ? "UndoneLine" : "UnderLine"} text={${line}} />`);
    expect(receipts).toContain(
      "<ChangesSheet row={r} channelId={m.channelId} title={title} under={under} close={sheet.close} />",
    );
    expect(source("TeamChecks.tsx")).not.toContain("numberOfLines");
  });

  test("a receipt's card, and the cards that look like it, are as wide as their words, up to the column", () => {
    for (const file of ["Receipts.tsx", "TeamChecks.tsx", "ReachLines.tsx"]) {
      const text = source(file);
      expect([file, text.includes('alignSelf: "flex-start",\n    maxWidth: "100%",')]).toEqual([file, true]);
      // A content-sized row collapses a `flex: 1` child to nothing: the words shrink instead.
      expect([file, /(fit|line|words|body): \{ flexShrink: 1, minWidth: 0/.test(text)]).toEqual([file, true]);
    }
    // The report offer keeps the column's width, as a request does: its report opening inside never widens it.
    const offer = source("FeedbackOffer.tsx");
    expect(offer).not.toContain('alignSelf: "flex-start"');
    expect(offer).toContain("body: { flex: 1, minWidth: 0 },");
  });

  test("a receipt is its sentence alone: no Desfazer, no Refazer, no time left, no clock", () => {
    const receipts = source("Receipts.tsx");
    for (const gone of ['t("agentActions.undo")', "agentActions.redo", "useAgentActions", "setInterval"])
      expect(receipts).not.toContain(gone);
    expect(receipts).not.toContain("RowButton");
    expect(receipts).not.toContain("ACT_LINE");
    // One undone elsewhere stays as history.
    expect(receipts).toContain("struck={Boolean(a.undoneAt)}");
    expect(receipts).toContain(
      "{lines.undone ? <UndoneLine text={lines.undone} /> : r.refs ? null : <CopyHook action={a} />}",
    );
  });

  test("a team check's icon stays outside its action line: Abrir goes under the words, from their edge", () => {
    const checks = source("TeamChecks.tsx");
    expect(
      ascending(
        at(checks, [
          "<LineIcon name={ICONS[targetKind(target)]}",
          "<View style={[ACT_LINE.row, styles.line]}>",
          "<RowAction",
        ]),
      ),
    ).toBe(true);
    expect(checks).not.toContain("styles.one, ACT_LINE.row");
  });

  test("they wear the message card's frame (as the tool block), never the sunken gray of a pressed row", () => {
    for (const file of ["Receipts.tsx", "TeamChecks.tsx"]) {
      const text = source(file);
      expect(text).not.toContain("sunken");
      // The one frame of a message card (`useMessageCardFrame`): raised with a hairline, a bubble in bubbles.
      expect(text).toContain("card.style");
    }
  });
});

describe("a shared approval card with actions approved ahead", () => {
  test("each waiting item says it approves a future action; an approved one says when and can be canceled", () => {
    const cards = source("cards.tsx");
    // Each item of a shared card is drawn by its own component.
    const start = cards.indexOf("function ApprovalGroupItem(");
    const group = cards.slice(start, cards.indexOf("\nfunction ", start + 1));
    expect(group).toContain("<ApprovalAheadLine approval={a} />");
    expect(group).toContain('t("approval.ahead.scheduled"');
    expect(group).toContain("cancelAhead.cancel(a.id)");
  });
});

describe("a stretch's pause on the phone (ADR 0089)", () => {
  test("waiting, a waiting pill with Continue tinted; once someone let them go on, a decided pill: who and when", () => {
    const card = source("../ai/StretchCard.tsx");
    const [doneAt, waitAt] = at(card, ["if (continued) {", "<AskWaiting"]);
    const done = card.slice(doneAt, waitAt);
    expect(done).toContain("<AskDone");
    expect(done).toContain('t("stretchCard.continuedByYou", { time })');
    expect(done).not.toContain("EventPillAction");
    const waiting = card.slice(waitAt);
    expect(waiting).not.toContain("continued");
    expect(waiting).toContain("forMe={may}");
    expect(waiting).toMatch(/<EventPillAction\s+key="continue"\s+primary/);
    expect(card).not.toContain("<Button");
  });
});

describe("a plan account on the phone (IA e uso › Contas): a row that pushes its own screen", () => {
  const screen = source("../usage/UsageScreen.tsx");
  const detail = source("../usage/UsageAccountScreen.tsx");

  test("its row: its mark, name, plan and owner, one meter for the fullest window, the alert; it opens a screen", () => {
    const row = screen.slice(...at(screen, ["function AccountRow(", "/** The API per agent:"]));
    expect(
      ascending(at(row, ["<ProviderLogo", "accountName(t, account)", "{owner}", "text.short(line.top)", "line.alert"])),
    ).toBe(true);
    expect(row).toContain("onPress={() => openUsageAccount(account.key)}");
    // Nothing opens in place under it.
    expect(row).not.toContain("{open ? (");
    expect(row).not.toContain("expanded");
    expect(screen).not.toContain("function AgentShares(");
  });

  test("its screen: the bars, one Detalhes row that opens the agents and the month in place, then the way to the AI accounts screen", () => {
    expect(
      ascending(at(detail, ['t("common.details")', "{details ? (", 't("shell.agents")', "{tokens}", "mobile.ai.row"])),
    ).toBe(true);
    // Split by agent only while Detalhes shows the agents that explain the colours.
    expect(detail).toMatch(/details\s+\? splitUsage\(/);
    // The title says the account: the meter doesn't say where the plan stands again.
    expect(detail).toMatch(/<PlanMeter\s+plain/);
    expect(detail).toContain('t("usageViews.monthTokens", {');
    // The logo names the maker: no line saying it again.
    expect(detail).not.toContain("brandOf(");
    // Only its owner manages it, on the AI accounts screen.
    expect(detail).toContain("account.mine && account.accountId ?");
    // Every agent, nothing folded, its share as the row's value, its tokens under its name, the row to its own usage.
    expect(detail).toContain("const agents = [...shares.shown, ...shares.rest];");
    expect(detail).not.toContain("usageViews.moreAgents");
    expect(detail).toContain("shareCells(t, i18n.language, window, a)");
    expect(detail).toMatch(/onPress=\{\(\) => router\.push\(`\/agent-usage\/\$\{a\.agentId\}`/);
    // Without an account's list inside, each window says when it renews under its bar; the age only once it matters.
    const parts = source("../usage/parts.tsx");
    expect(
      ascending(at(parts, ["!children ? (", "{children}\n      {children && renews ?", "planAgeShown(usage, now)"])),
    ).toBe(true);
  });

  test("no budget on plans alone: the API per agent, its spend by kind and the default budget wait for the API", () => {
    expect(screen).toContain("const usesApi = useWorkspaceUsesApi(orgId);");
    expect(screen).toContain("{usesApi ? <ApiCard data={data} /> : null}");
    expect(screen).toContain('{view === "summary" && allowed && usesApi && report.data ? (');
    expect(screen).toContain('{view === "summary" && allowed && usesApi ? <DefaultBudgetCard /> : null}');
    expect(screen).toContain("useUsageReport(orgId, allowed && usesApi)");
  });
});

describe("an approval card's layout", () => {
  const cards = source("cards.tsx");
  const fn = (name: string) => {
    const start = cards.indexOf(`function ${name}(`);
    return cards.slice(start, cards.indexOf("\nfunction ", start + 1));
  };

  test("the buttons sit in one row (a grouped request's at its row's end), Aprovar, Aprovar sempre and its ⓘ on a grouped request, Recusar, and only buttons there: what it covers opens from the ⓘ, under them", () => {
    const rows: [string, string[]][] = [
      ["ApprovalAsk", ['variant="primary"', 't("mobile.approval.refuse")', "</View>"]],
      [
        "ApprovalGroupItem",
        [
          'variant="primary"',
          "<ApproveAlwaysButton",
          "{info.button}",
          't("mobile.approval.refuse")',
          "</View>",
          "{info.text}",
        ],
      ],
    ];
    for (const [name, pieces] of rows) {
      const card = fn(name);
      const row = card.slice(card.indexOf("<View style={styles.itemActs}>"));
      expect([name, ascending(at(row, pieces))]).toEqual([name, true]);
      // Never a wide button stretched beside the text: each its own width, left-aligned in the row.
      expect([name, row.slice(0, row.indexOf("</View>")).includes(" wide")]).toEqual([name, false]);
    }
    // One request's card has only the two: its "Aprovar sempre" is a switch in the request's sheet.
    const ask = fn("ApprovalAsk");
    expect(ask.slice(...at(ask, ["foot={", "</AskFoot>"]))).not.toContain("ApproveAlways");
    expect(cards).toContain('itemActs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }');
    // A grouped request: its words and its buttons on one line while the words fit theirs, the buttons under the
    // words otherwise (the action line), its words whole and their code drawn as code.
    const item = fn("ApprovalGroupItem");
    // A replaced request returns its one quiet line first; the line with buttons is the main return.
    const live = item.slice(item.indexOf("<ApproveAlwaysInfo"));
    expect(
      ascending(
        at(live, [
          "<View style={[ACT_LINE.row, styles.itemWrap]}>",
          "<View style={ACT_LINE.text}>",
          "<View style={styles.itemActs}>",
        ]),
      ),
    ).toBe(true);
    expect(item.slice(0, item.indexOf("<View style={styles.itemActs}>"))).not.toContain("numberOfLines");
    expect(item).toContain("<Spans inline={parseInline(detail)} />");
    expect(item).toContain("<Spans inline={parseInline(own.why)} />");
    // A run's head too.
    expect(fn("ApprovalGroupAsk")).toContain("<View style={[ACT_LINE.row, styles.itemWrap]}>");
    expect(cards).not.toContain("flexBasis: 160");
  });

  test("waiting requests of one kind in a row fold into one run: its head, Aprovar todos and Ver cada um", () => {
    const group = fn("ApprovalGroupAsk");
    for (const piece of [
      "approvalRuns(items)",
      't("approval.run.head"',
      't("approval.run.approve")',
      'label: t("approval.run.show")',
      "approveAlwaysAlso(items, a)",
    ])
      expect([piece, group.includes(piece)]).toEqual([piece, true]);
  });
});

describe("the secret card on the phone", () => {
  const card = source("SecretCard.tsx");

  test("people read its label: its internal name only binds the box", () => {
    expect(card.match(/\br\.name\b/g)).toHaveLength(1);
    expect(card).toContain("secretAad({ requestId: r.id, orgId, name: r.name, target: r.target })");
    expect(card).toContain("title: label");
    expect(card).toContain("accessibilityLabel={label}");
  });

  test("a refused send ends the card with the real reason and clears what was typed, unless only the computer is away", () => {
    const failed = card.slice(card.indexOf("const failed = async"), card.indexOf("const showNewer"));
    expect(failed.indexOf("secretRefusalKey(err)")).toBeLessThan(failed.indexOf("api.secrets.get(orgId, r.id)"));
    expect(failed).toContain("secretClosedBy(err, r, fresh)");
    expect(failed).toContain("done(closed)");
    expect(failed).toContain('t(fresh ? "secret.changed" : "secret.failed")');
    expect(card).toContain('if (!pending) setValue("");');
    expect(card).toContain('t("secret.seeNewer")');
  });

  test('the name line reads whole (never cut mid-sentence), its mark on the title\'s line, "Ver …" under the words, the deadline at the foot', () => {
    const asks = source("asks.tsx");
    const line = asks.slice(asks.indexOf("const line = well ? ("), asks.indexOf("const opened ="));
    // The title and the detail wrap whole ("Ver …" is one word on one line).
    expect(line.slice(0, line.indexOf("{more ?"))).not.toContain("numberOfLines");
    expect(line.slice(line.indexOf("{well.detail"), line.indexOf("{more ?"))).not.toContain("numberOfLines");
    expect(asks).toContain('lineTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 }');
    // The detail spans the whole width under the title, and "Ver …" comes after it, on its edge: never a column
    // beside the words.
    expect(asks).toContain("lineDetail: { marginLeft: 30, marginTop: 1 }");
    expect(line.indexOf("{more ?")).toBeGreaterThan(line.indexOf("{well.detail"));
    expect(line.slice(line.indexOf("<View style={styles.lineTop}>"), line.indexOf("{well.detail"))).not.toContain(
      "lineMore",
    );
    expect(asks).toContain(
      'lineMore: { flexDirection: "row", alignItems: "center", gap: 3, alignSelf: "flex-start", marginLeft: 30',
    );
    // The agent's words and the detail are formatted text: code between backticks is drawn as code.
    expect(line).toContain("<Spans inline={parseInline(well.detail)} />");
    expect(asks).toContain("<Spans inline={parseInline(lead)} />");
    expect(asks).toContain("lineMark: { flexShrink: 0, width: 20, height: 20,");
    // The fuse and the time left under the decision, never on the card's top line.
    expect(asks).toContain('{waitsFor === "you" && expiry ? <View style={styles.expiryRow}>{expiry}</View> : null}');
    // From the card's edge, as the buttons above it: never floating at the other end on a line of its own.
    expect(asks).toContain('expiryRow: { flexDirection: "row", marginTop: 10 },');
    expect(asks).toContain('{waitsFor && waitsFor !== "you" && !ended ? (');
  });
});

describe("a JSON block", () => {
  const files = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/files", path), "utf8");

  test("reads formatted and wrapped, the text as written one press away, copy taking what shows", () => {
    const card = source("CodeCard.tsx");
    expect(card).toContain("isJsonLang(lang) ? formatJson(text) : null");
    expect(card).toContain("<RawToggle on={raw} onPress={() => setRaw((r) => !r)} />");
    expect(card).toContain("<CopyButton text={code} />");
    expect(card).toMatch(/\{pretty \? \(\s*<View style=\{styles\.body\}>\s*<CodeText lines=\{shown\} wrap \/>/);
    // Keys apart from the strings, in the web's colors.
    expect(card).toContain('kind === "property"');
  });

  test("a JSON file opens formatted too", () => {
    const viewer = files("DocumentViewer.tsx");
    expect(viewer).toContain("json={isJsonFile(info.name, info.mime)}");
    expect(viewer).toContain('<CodeText lines={highlightCode(raw ? text.data : formatted, "json")} wrap />');
  });
});

describe("an agent's offer card is done for everyone once it's done", () => {
  test("the skill library is read whatever the viewer may do, and anyone installs (a member as their own)", () => {
    const offer = readFileSync(join(import.meta.dir, "../../src/features/ai/OfferCard.tsx"), "utf8");
    const install = offer.slice(offer.indexOf("function InstallSkill("), offer.indexOf("\nfunction UpdateSkills("));
    expect(install).toContain("useSkills(orgId)");
    expect(install).toContain('action={t("actionCard.install_skill.open")}');
    // Its screen's row turns what installs on for the agent that posted it, as on the web.
    expect(install).toContain("openedFromCard({ url: card.url, agentId })");
    expect(install).toContain("&agent=");
  });

  test("Instalar skill's route keeps the agent only when that agent's card opened it, for the card's own link", async () => {
    const { openedFromCard, routeAgent } = await import("../../src/features/settings/install-from-card");
    const link = "https://github.com/acme/skills/tree/main/excel";
    // A link from outside the app that names an agent: the screen turns nothing on for it.
    expect(routeAgent(link, "a-dev")).toBeUndefined();
    openedFromCard({ url: link, agentId: "a-dev" });
    expect(routeAgent(link, "a-dev")).toBe("a-dev");
    expect(routeAgent("https://github.com/evil/skills", "a-dev")).toBeUndefined();
    expect(routeAgent(link, "a-other")).toBeUndefined();
    expect(routeAgent(link, undefined)).toBeUndefined();
    // The route hands the screen only what `routeAgent` keeps.
    const route = readFileSync(join(import.meta.dir, "../../app/(app)/(main)/settings/skills/new.tsx"), "utf8");
    expect(route).toContain("forAgentId={routeAgent(url, agent)}");
    // The screen sends it only on an install from the card's link with its row checked, never on a read.
    const screen = readFileSync(join(import.meta.dir, "../../src/features/settings/SkillsScreen.tsx"), "utf8");
    expect(screen).toContain("? { url: link, list, ...mine }");
    expect(screen).toContain(": { url: link, ...(forAgent ? { forAgentId: forAgent } : {}), ...mine }");
    expect(screen).toContain("forAgentId: sendFor(url)");
    // Its row only for a live agent the server would turn it on for: not archived or gone.
    expect(screen).toContain("const forName = forAgentId ? dir.agentById.get(forAgentId)?.name : undefined;");
    // What a pick replaces, as the server marks it: an installed skill, or a removed one.
    expect(screen).toContain('c.replaces === "removed" ? "skills.pickReplacesRemoved" : "skills.pickReplaces"');
    expect(screen).toContain("turnOn && cardLink !== undefined && link.trim() === cardLink ? forAgentId : undefined");
  });
});

describe("no colored bar at a left edge: quotes and plates on the scale's corner", () => {
  test("quotes, reports and opened notices sit on a plate with the plates' room, never a left bar", () => {
    const fromSrc = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");
    const files = [
      "features/chat/ConsultGroup.tsx",
      "features/chat/MessageText.tsx",
      "features/chat/MessageRow.tsx",
      "features/chat/QuoteLine.tsx",
      "ui/EventPill.tsx",
      "features/live-files/document/DocumentScreen.tsx",
      "features/wiki/WikiDoc.tsx",
    ];
    for (const file of files) {
      const text = fromSrc(file);
      // Only the reply's curve to its face draws a left line (a joint, not a bar on a card).
      const bars = (text.match(/borderLeftWidth: [2-9]/g) ?? []).length;
      expect({ file, bars }).toEqual({ file, bars: file.endsWith("QuoteLine.tsx") ? 1 : 0 });
      expect({ file, corner: /borderRadius: RADIUS(\.md)?\b/.test(text) }).toEqual({ file, corner: true });
    }
  });
});
