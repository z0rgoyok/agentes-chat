import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { teamWeekWhen } from "@agenteschat/client/lib/right-hand-prefs";
import {
  markedAtFirst,
  opensPlace,
  skipsAlone,
  type TeamWeekRow,
  teamWeekApplyLabel,
  teamWeekCardOf,
  teamWeekGroups,
  teamWeekGroupTitle,
  teamWeekRowText,
} from "@agenteschat/client/lib/team-week";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";

/**
 * Lodi's weekly card on the phone (ADR 0137 §9), as on the web: the same card (rows that open a place, then the
 * suggestions marked under each agent's face and one button for them), and its schedule in Settings.
 */

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

const tOf = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as unknown as TFunction;
};

test("an agent's message with the week's card draws it under its words, after the settings cards", () => {
  const row = src("chat/MessageRow.tsx");
  const settings = row.indexOf("<SettingsProposals message={m} />");
  const week = row.indexOf("<TeamWeek message={m} />");
  expect(settings).toBeGreaterThan(0);
  expect(week).toBeGreaterThan(settings);
  // Its week ("Como foi a semana do time…") is the message's own text on the phone: the card doesn't repeat it.
  expect(src("right-hand/TeamWeekCard.tsx")).not.toContain('t("chat.body.team_week"');
});

test("suggestions sit under their agent's face, a line each with no button; the footer's day and hour open Settings", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  // No row has a button of its own: the card's one button applies what is marked.
  expect(card).not.toContain('variant="secondary"');
  expect(card).not.toContain('size="sm"');
  // What opens a place leads the section, then the rest by agent, in the order each agent first shows.
  expect(card).toContain("const places = card.rows.filter(opensPlace);");
  expect(card).toContain("const groups = teamWeekGroups(card.rows);");
  // One face per group with its title beside it; under it each row's words leave out the agent's name.
  expect(card).toContain("<AgentFace agentId={group.agentId} size={FACE} live={false} />");
  expect(card).toContain("{teamWeekGroupTitle(t, group, names)}");
  expect(card).toContain("const text = teamWeekItemText(t, locale, row, names);");
  // Every mark starts where its group's words do, past the face and its gap; a row about no agent has its icon there.
  expect(card).toContain("const INDENT = FACE + 10;");
  expect(card).toContain('indent: { width: INDENT, paddingRight: INDENT - FACE, alignItems: "center" },');
  expect(card).toContain("{lead ? <LineIcon name={kindIcon(row)}");
  // A hairline between groups, as between the rows that open a place; none inside a group.
  expect(card).toContain("places.length + i > 0 && [styles.divided, { borderTopColor: c.line2 }]");
  // Three numbers share one line. With the workspace's money they are four, two by two.
  expect(card).toContain("stats.budgetNanoUsd > 0 ? styles.statOfFour : styles.statOfThree");
  expect(card).toContain("onPress={openRightHandSettings}");
  // Approvals open the phone's own approval screen, as the approvals card does.
  expect(card).toContain("router.push(`/approval/");
});

test("a row that opens a place is one tap on the whole row, a chevron at its end and no button", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  const place = card.slice(card.indexOf("function PlaceRow("), card.indexOf("function MarkRow("));
  expect(place).toContain('accessibilityRole="button"');
  expect(place).toContain("onPress={onOpen}");
  expect(place).toContain("<Disclosure color={c.faint} />");
  expect(place).not.toContain("<Button");
  // Where it goes is what a screen reader hears after the row's words.
  expect(place).toContain("accessibilityHint={action}");
  // The agent's face; with none, what waits on the reader leads with the clock in amber.
  expect(place).toContain("<AgentFace agentId={agentId} size={FACE} live={false} />");
  expect(place).toContain('color={row.kind === "waiting" ? c.amber : c.muted}');
  // Done, the chevron goes: the check and what was done in its line's place.
  const done = place.slice(place.indexOf("<View style={[styles.placeReach, styles.place]}>"));
  expect(done).not.toContain("<Disclosure");
  expect(done).toContain('<LineIcon name="check" size={13} color={c.ok} variant="footnote" />');
  // The tap does what the row's button did: the activity, the task, the conversation or the next approval.
  expect(card).toContain("onOpen={() => void apply(row).catch(failed)}");
});

test("each suggestion is a line to mark: marked as the card shows, flipped by a tap on the line, Dismiss when unmarked", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  // The reader's own marks over the card's first ones, never saved.
  expect(card).toContain("const [marks, setMarks] = useState<Record<string, boolean>>({});");
  expect(card).toContain("const isMarked = (row: TeamWeekRow) => marks[row.id] ?? markedAtFirst(row);");
  expect(card).toContain("setMarks((m) => ({ ...m, [row.id]: !(m[row.id] ?? markedAtFirst(row)) }))");
  const mark = card.slice(card.indexOf("function MarkRow("), card.indexOf("function Tick("));
  expect(mark).toContain('accessibilityRole="checkbox"');
  expect(mark).toContain("accessibilityState={{ checked: marked, disabled: applying }}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the card's source
  expect(mark).toContain("accessibilityLabel={`${title}, ${line}`}");
  expect(mark).toContain("onPress={onToggle}");
  expect(mark).not.toContain("<Button");
  // At least a finger's 44 tall, each line's press reaching into half the gaps around it.
  expect(card).toContain(
    'mark: { flexDirection: "row", alignItems: "flex-start", paddingVertical: REACH, minHeight: TOUCH },',
  );
  expect(card).toContain('markRow: { flexDirection: "row", alignItems: "flex-start", marginVertical: -REACH },');
  // Dismiss beside an unmarked line only, on the rows that can be put away alone.
  expect(mark).toContain("{!marked && onSkip ? (");
  expect(card).toContain("skipsAlone(row)");
  // The mark: filled in ink with the check in the page's color, a ring in faint unmarked, the check in ok once applied.
  const tick = card.slice(card.indexOf("function Tick("), card.indexOf("function UndoAction("));
  expect(tick).toContain('look === "on" && { backgroundColor: c.ink }');
  expect(tick).toContain('look === "off" && { borderWidth: 1.5, borderColor: c.faint }');
  expect(tick).toContain('<Icon name="check" size={13} weight="bold" color={c.bg} />');
  expect(tick).toContain('<Icon name="check" size={16} weight="bold" color={c.ok} />');
});

test("the card's one button applies the marked rows and says what they do; it goes once none is marked", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  expect(card).toContain("const marked = open.filter((r) => !opensPlace(r.row) && isMarked(r.row)).map((r) => r.row);");
  expect(card).toContain("{!dismissed && marked.length > 0 ? (");
  expect(card).toContain("label={teamWeekApplyLabel(t, marked)}");
  expect(card).toContain("for (const row of marked) await apply(row);");
  // Not now stays while anything is open.
  expect(card).toContain("{!dismissed && open.length > 0 ? (");
});

test("a day's card on the phone: what waits opens a place, the how-tos marked under one face, archiving unmarked", () => {
  const card = teamWeekCardOf({
    actionCard: {
      kind: "team_week",
      forUserId: "u1",
      period: "day",
      from: "2026-11-19",
      to: "2026-11-20",
      timezone: "UTC",
      stats: { done: 14, stuck: 0, waiting: 2, spentNanoUsd: 0, budgetNanoUsd: 0 },
      rows: [
        { id: "howto:1", kind: "howto", agentId: "dev", itemId: "i1", title: "Weekly sales report", uses: 19 },
        { id: "howto:2", kind: "howto", agentId: "dev", itemId: "i2", title: "Contract review", uses: 12 },
        { id: "howto:3", kind: "howto", agentId: "dev", itemId: "i3", title: "Monday's agenda", uses: 10 },
      ],
      moreRows: [
        { id: "waiting", kind: "waiting", count: 2, ids: ["n1", "n2"], agentId: null, since: "2026-11-06T14:13:00Z" },
        { id: "retire:infra", kind: "retire", agentId: "infra", proposalId: "p1" },
      ],
    },
  });
  const rows = card?.rows ?? [];
  // What waits leads, a row to open; every other row is a mark under its agent's face.
  expect(rows.filter(opensPlace).map((r) => r.id)).toEqual(["waiting"]);
  const groups = teamWeekGroups(rows);
  expect(groups.map((g) => [g.agentId, g.rows.map((r) => r.id)])).toEqual([
    ["dev", ["howto:1", "howto:2", "howto:3"]],
    ["infra", ["retire:infra"]],
  ]);
  const t = tOf("pt-BR");
  const names = {
    agent: (id: string | null) => (id === "dev" ? "Dev" : "Infra"),
    handle: () => null,
    channel: () => "general",
    usd: () => "",
    join: (l: string[]) => l.join(", "),
    since: () => "",
  };
  expect(groups.map((g) => teamWeekGroupTitle(t, g, names))).toEqual(["Dev aprendeu 3 jeitos de trabalhar", "Infra"]);
  // Marked as the card shows, archiving left to its own mark; the button says what the marked rows do.
  const marked = rows.filter((r) => !opensPlace(r) && markedAtFirst(r));
  expect(marked.map((r) => r.id)).toEqual(["howto:1", "howto:2", "howto:3"]);
  expect(teamWeekApplyLabel(t, marked)).toBe("Virar 3 skills");
  // One unmarked: the button counts the rest.
  expect(teamWeekApplyLabel(tOf("en"), marked.slice(1))).toBe("Make 2 skills");
  // The archive marked too: no longer all how-tos, so the button says how many it applies.
  expect(teamWeekApplyLabel(t, [...marked, rows.find((r) => r.kind === "retire") as TeamWeekRow])).toBe("Aplicar as 4");
  // Dismiss belongs to what can be put away alone (the card shows it once such a row is unmarked).
  expect(rows.filter(skipsAlone).map((r) => r.id)).toEqual(["retire:infra"]);
});

test("Configurações › Lodi: Resumo do dia and its hour for anyone, the week's day and hour for admins", () => {
  const screen = src("right-hand/SettingsScreen.tsx");
  expect(screen).toContain("<OwnRows name={agent.name} />");
  expect(screen).toContain('can(org, "administrator")');
  expect(screen).toContain('teamWeekOn(prefs, "day", admin)');
  expect(screen).toContain("toggle={dayOn}");
  expect(screen).toContain("onPress={() => save({ dayOff: dayOn })}");
  expect(screen).toContain("{admin ? (");
  expect(screen).toContain("toggle={weekOn}");
  expect(screen).toContain("onPress={() => save({ weekOff: weekOn })}");
  // One list of switch rows, as the web's card: no header repeats a row's name over it.
  expect(screen).not.toContain("<GroupedHeader>{dayLabel}</GroupedHeader>");
  expect(screen).not.toContain("<GroupedHeader>{weekLabel}</GroupedHeader>");
  expect(screen).toContain('t("teamWeek.settings.dayLabel")');
  // The hour and the day are one row each that opens the app's picker, as "Your AI" does: no wall of 24 small pills.
  expect(screen).not.toContain("<Pills");
  // Three of them, and "Your AI" itself, which opens its choice the same way.
  expect(screen.match(/\bmenu\n/g)).toHaveLength(4);
  expect(screen).toContain("value={hourText(locale, prefs.dayHour)}");
  expect(screen).toContain("value={dayText(locale, prefs.day)}");
  expect(screen).toContain("(weekHour) => save({ weekHour })");
  expect(screen).toMatch(/void pickOne\(\{\s+title,\s+value: String\(value\),/);
});

test("the other switches show only for a feature the server lists, the workspace's only to who configures it", () => {
  const screen = src("right-hand/SettingsScreen.tsx");
  expect(screen).toContain("const shows = (s: LodiSwitch) => prefs.switches.includes(s);");
  expect(screen).toContain(".filter((r) => shows(r.id))");
  expect(screen).toContain('can(org, "configure") && settings');
  // A workspace switch says who it is for under its name, and saves through the workspace's settings.
  expect(screen).toContain('sub={t("rightHand.settings.groupWorkspace")}');
  expect(screen).toContain(".mutateAsync({ [id]: next })");
  // A switch flips on the tap; only the row whose save is on its way waits for it, every other one stays live.
  expect(screen).not.toMatch(/disabled=\{(set|setSettings)\.isPending\}/);
  expect(screen).toContain("if (savingPrefs && Object.keys(patch).some((k) => k in savingPrefs)) return;");
  expect(screen).toContain("if (flips.has(id)) return;");
  expect(screen).toContain("const on = flips.get(r.id) ??");
});

test("the right hand's own switches show on the tap, and a refused one goes back", () => {
  const queries = readFileSync(new URL("../../../../packages/client/src/api/queries.ts", import.meta.url), "utf8");
  const hook = queries.slice(
    queries.indexOf("export const useSetTeamWeekPrefs"),
    queries.indexOf("export const useActOnTeamWeek"),
  );
  // Written to the cache before the server answers, one save at a time, and put back if it is refused.
  expect(hook).toContain("qc.setQueryData<LodiPrefs>(keys.teamWeek(orgId), { ...before, ...patch });");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the hook's source
  expect(hook).toContain("scope: { id: `team-week-prefs:${orgId}` },");
  expect(hook).toContain("if (context?.before) qc.setQueryData(keys.teamWeek(orgId), context.before);");
  // An earlier answer never undoes a later choice still on its way.
  expect(hook).toContain("if (qc.isMutating({ mutationKey }) <= 1) qc.setQueryData(keys.teamWeek(orgId), prefs);");
});

test("the card's footer says when the card it sits on comes", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  expect(card).toContain('const period = admin ? (card.period ?? "week") : "day";');
  expect(card).toContain("teamWeekOn(prefs, period, admin) ? teamWeekWhen(t, locale, prefs, period)");
});

test("the approvals and the people cards live in files of their own, drawn as the other offers", () => {
  const offer = src("ai/OfferCard.tsx");
  expect(offer).toContain("<CardVia messageId={m.id}>\n        <OfferApprovals card={card} />");
  expect(offer).toContain('if (card.kind === "member_changes") return <OfferPeople card={card} message={m} />;');
  expect(src("ai/OfferApprovals.tsx")).toContain("<OfferShell");
  expect(src("ai/OfferPeople.tsx")).toContain("<OfferShell");
});

test("the phone reads the same card and says its rows in the person's language", () => {
  const meta = {
    actionCard: {
      kind: "team_week",
      forUserId: "u1",
      from: "2026-10-30",
      to: "2026-11-06",
      timezone: "UTC",
      stats: { done: 1, stuck: 0, waiting: 0, spentNanoUsd: 0, budgetNanoUsd: 0 },
      rows: [{ id: "u", kind: "unanswered", channelId: "c", count: 1 }],
    },
  };
  const card = teamWeekCardOf(meta);
  expect(card?.rows).toHaveLength(1);
  const t = tOf("pt-BR");
  const names = {
    agent: () => "Ada",
    handle: () => null,
    channel: () => "atendimento",
    usd: () => "US$ 0",
    join: (l: string[]) => l.join(", "),
    since: () => "",
  };
  expect(teamWeekRowText(t, "pt-BR", card?.rows[0] as never, names).line).toBe(
    "1 pergunta ficou sem resposta em #atendimento esta semana.",
  );
  expect(teamWeekWhen(tOf("en"), "en", { day: 5, weekHour: 17, dayHour: 9 }, "week")).toMatch(
    /^Every Friday at 5:00\sPM$/,
  );
  expect(teamWeekWhen(tOf("en"), "en", { day: 5, weekHour: 17, dayHour: 9 }, "day")).toMatch(/^Every day at 9:00\sAM$/);
});

test("the day's card: what waits opens Atividade, what is stuck its conversation or task, and neither is applied", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  expect(card).toContain("const place = teamWeekRowPlace(row);");
  expect(card).toContain('? "/activity"');
  expect(card).toContain("? `/issues/");
  expect(card).toContain(": chatHref(place.channelId)) as never,");
  // Still open only while the inbox says so, and the head counts suggestions alone.
  expect(card).toContain("waiting: waiting.data?.items.map((i) => i.id),");
  expect(card).toContain('t("teamWeek.suggestions", { count: suggested.length })');
  expect(card).toContain('t(card.period === "day" ? "teamWeek.needsYou" : "teamWeek.improve")');
  const meta = {
    actionCard: {
      kind: "team_week",
      forUserId: "u1",
      period: "day",
      from: "2026-11-05",
      to: "2026-11-06",
      timezone: "UTC",
      stats: { done: 0, stuck: 1, waiting: 1, spentNanoUsd: 0, budgetNanoUsd: 0 },
      rows: [],
      moreRows: [
        { id: "s", kind: "stuck", agentId: "a", channelId: "c", dm: true, code: "computer", count: 2, held: false },
        { id: "waiting", kind: "waiting", count: 3, ids: ["n"], agentId: null, since: "2026-11-05T12:00:00Z" },
      ],
    },
  };
  const parsed = teamWeekCardOf(meta);
  expect(parsed?.rows.map((r) => r.kind)).toEqual(["waiting", "stuck"]);
  const names = {
    agent: () => "Ada",
    handle: () => null,
    channel: () => "geral",
    usd: () => "",
    join: (l: string[]) => l.join(", "),
    since: () => "qui., 09:00",
  };
  expect(teamWeekRowText(tOf("pt-BR"), "pt-BR", parsed?.rows[1] as never, names)).toEqual({
    title: "Ada parou com erro 2 vezes",
    line: "O computador não respondeu.",
    action: "Abrir conversa",
  });
});

test("suggestions: a row with a proposal applies it, and the ones that can be put away alone have Dismiss", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  expect(card).toContain(
    'else if ("proposalId" in row) await decide.mutateAsync({ id: row.proposalId, decision: "accept" });',
  );
  expect(card).toContain("skipsAlone(row)");
  expect(card).toContain("act: { rowId: row.id, skip: true }");
  expect(card).toContain('label={t("teamWeek.skip")}');
  expect(card).toContain('t(state === "gone" ? "teamWeek.gone" : "teamWeek.skipped")');
  // Nothing takes a second tap while one is on its way, and the marks hold still while the button applies them.
  expect(card).toContain("disabled={busy || skipping}");
  expect(card).toContain("disabled={applying}");
  // Applied: what was done in the line's place, and Undo beside it while the receipt allows.
  expect(card).toContain('label={t("teamWeek.undo")}');
  expect(card).toContain('receipt?.undoneAt ? t("rightHand.card.undone") : doneText');
  expect(card).toContain("<UndoAction message={message} actionId={receipt.id} />");
});
