import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  checkCondition,
  createFakeJudge,
  diffObservations,
  findInPage,
  type Judge,
  type JudgeRequest,
  observeSnapshot,
  runPlan,
  type ScreenJudgmentShadow,
  type ScreenSurface,
  setScreenJudgments,
} from "../src";

/**
 * Screen judgments send what matters on a long page, not all of it, and none at all when the words a step names are
 * already on the screen. A fake judge that reads the request the way a model would (it answers from the text it was
 * sent) shows the decisions stay the same.
 */

const ids = { orgId: "o", agentId: "a", runId: "r" };

// The smaller judgments are what most of this file is about; `SCREEN_JUDGMENTS` at the end covers the others.
beforeEach(() => setScreenJudgments("small"));
afterAll(() => setScreenJudgments("full"));

/** A long order history: a header, 600 rows of past orders, then the checkout panel at the bottom. */
function ordersPage(extra: { status?: string; total?: string } = {}) {
  const rows = Array.from(
    { length: 600 },
    (_, i) =>
      `    - row "Order #${10_000 + i} · ${(i % 28) + 1} Mar · ${(i * 7.3 + 12).toFixed(2)} USD · Delivered"\n      - link "View order ${10_000 + i}" [ref=e${100 + i}]`,
  );
  return [
    "- banner",
    '  - link "Northwind Supply" [ref=e1]',
    '  - button "Account: sam@example.com" [ref=e2]',
    "- main",
    '  - heading "Your orders" [level=1, ref=e3]',
    '  - table "Past orders"',
    ...rows,
    '  - region "Checkout"',
    '    - heading "Checkout" [level=2, ref=e900]',
    `    - paragraph: Cart total ${extra.total ?? "84.20 USD"}`,
    '    - button "Place order" [ref=e901]',
    ...(extra.status ? [`    - status: ${extra.status}`] : []),
  ].join("\n");
}

const look = (text: string, url = "https://shop.example.com/orders") => observeSnapshot({ text, url });

/** What a check sent the judge as the page's text. */
const sentText = (r: JudgeRequest) => (r.state.screen as { text: string }).text;

/** A judge that answers a check from the text it was sent: true when it reads `evidence`. */
const readingJudge = (evidence: string) =>
  createFakeJudge((kind, _id, state) =>
    kind === "screen_check" ? (JSON.stringify(state.screen).includes(evidence) ? 0.95 : 0.05) : undefined,
  );

const size = (r: JudgeRequest) => JSON.stringify(r.state).length + JSON.stringify(r.questions).length;

describe("screen checks on a long page", () => {
  const before = look(ordersPage());
  const after = look(ordersPage({ status: "Order #10600 placed. A receipt is on its way." }));

  test("a change far down the page is what the judge reads, and the page is cut to about 16k characters", async () => {
    expect(after.lines.join("\n").length).toBeGreaterThan(60_000);
    const judge = readingJudge("Order #10600 placed");
    const r = await checkCondition({
      judge,
      ...ids,
      condition: "the order was placed",
      observation: after,
      changes: diffObservations(before, after),
      focus: "Place order",
    });
    expect(r.met).toBe(true);
    const text = sentText(judge.calls[0] as JudgeRequest);
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain("- status: Order #10600 placed.");
    // The target the step acted on and the top of the page are there too.
    expect(text).toContain('- button "Place order" [ref=e901]');
    expect(text).toContain('- button "Account: sam@example.com" [ref=e2]');
    expect((judge.calls[0] as JudgeRequest).state.screen).toMatchObject({ left_out: expect.stringContaining("of") });
  });

  test("a page that didn't change: the lines with the condition's words, even far from the top", async () => {
    const judge = readingJudge("Cart total 84.20 USD");
    const r = await checkCondition({
      judge,
      ...ids,
      condition: "the cart total is 84.20",
      observation: before,
      changes: diffObservations(before, before),
    });
    expect(r.met).toBe(true);
    expect(sentText(judge.calls[0] as JudgeRequest)).toContain("- paragraph: Cart total 84.20 USD");
  });

  test("the same no as before: what the page doesn't show, the judge doesn't read", async () => {
    const judge = readingJudge("declined");
    const r = await checkCondition({
      judge,
      ...ids,
      condition: "an error says the card was declined",
      observation: after,
      changes: diffObservations(before, after),
    });
    expect(r.met).toBe(false);
  });

  test("a new page that is long: its top, its headings and the lines with the condition's words", async () => {
    const judge = readingJudge("Checkout");
    const page = look(ordersPage(), "https://shop.example.com/checkout");
    await checkCondition({
      judge,
      ...ids,
      condition: "the checkout panel shows the total",
      observation: page,
      changes: diffObservations(before, page),
    });
    const text = sentText(judge.calls[0] as JudgeRequest);
    expect(text).toContain('- heading "Your orders" [level=1, ref=e3]');
    expect(text).toContain('- heading "Checkout" [level=2, ref=e900]');
    expect(text).toContain("- paragraph: Cart total 84.20 USD");
    expect(text.length).toBeLessThanOrEqual(16_000);
  });

  test("a short page goes whole, exactly as before", async () => {
    const short = look(
      '- heading "Sign in" [level=1, ref=e1]\n- textbox "Email" [ref=e2]\n- button "Continue" [ref=e3]',
    );
    const judge = readingJudge("Sign in");
    await checkCondition({ judge, ...ids, condition: "the sign-in form is shown", observation: short });
    expect(sentText(judge.calls[0] as JudgeRequest)).toBe(short.lines.join("\n"));
    expect((judge.calls[0] as JudgeRequest).state.screen).not.toHaveProperty("left_out");
  });

  test("with a screenshot, the page's text is what it always was", async () => {
    const judge = readingJudge("placed");
    await checkCondition({
      judge,
      ...ids,
      condition: "the order was placed",
      observation: after,
      image: { data: "AAAA", width: 10, height: 10, viewport: { width: 10, height: 10 } },
    });
    const text = sentText(judge.calls[0] as JudgeRequest);
    expect(text.length).toBeGreaterThan(55_000);
    expect(after.lines.join("\n").startsWith(text)).toBe(true);
  });
});

describe("long pages in other scripts and with long lines", () => {
  test("a condition in a script without spaces finds its line far down the page", async () => {
    const rows = Array.from(
      { length: 600 },
      (_, i) =>
        `    - row "订单 #${10_000 + i} · 3月${(i % 28) + 1}日 · 已送达"\n      - link "查看订单 ${10_000 + i}" [ref=e${100 + i}]`,
    );
    const page = look(
      ['- heading "我的订单" [level=1, ref=e1]', ...rows, "    - paragraph: 您的退款已处理完毕"].join("\n"),
    );
    expect(page.lines.join("\n").length).toBeGreaterThan(16_000);
    const judge = readingJudge("退款已处理");
    const r = await checkCondition({ judge, ...ids, condition: "页面显示退款已处理", observation: page });
    expect(r.met).toBe(true);
    expect(sentText(judge.calls[0] as JudgeRequest).length).toBeLessThanOrEqual(16_000);
  });

  test("a very long line: the piece with the words goes, not only the line's start", async () => {
    const items = Array.from({ length: 900 }, (_, i) => `{"id":${i},"state":"open"}`);
    items.splice(700, 0, '{"id":"r1","state":"refund issued"}');
    const page = look(`- heading "Export" [level=1, ref=e1]\n- text: [${items.join(",")}]`);
    expect(page.lines[1]?.length).toBeGreaterThan(20_000);
    const judge = readingJudge("refund issued");
    const r = await checkCondition({ judge, ...ids, condition: "the export lists a refund", observation: page });
    expect(r.met).toBe(true);
    const text = sentText(judge.calls[0] as JudgeRequest);
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text.startsWith('- heading "Export" [level=1, ref=e1]\n- text: [{"id":0')).toBe(true);
    // The line's middle and end are left out around the piece that has the refund, each marked.
    expect(text.slice(0, -1)).toContain("…");
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("words already on the screen need no judge", () => {
  const page = look(ordersPage({ status: "Order #10600 placed. A receipt is on its way." }));

  test("a condition that names words: true when every one shows, whole words in a line", async () => {
    for (const condition of [
      '"Order #10600 placed"',
      'shows "receipt is on its way"',
      'The page shows "Cart total" and "Place order".',
      "“Your orders” is visible",
    ]) {
      const judge = createFakeJudge(() => 0);
      expect(await checkCondition({ judge, ...ids, condition, observation: page })).toEqual({ met: true, p: 1 });
      expect(judge.calls).toHaveLength(0);
    }
  });

  test("anything else still goes to the judge", async () => {
    for (const condition of [
      '"Order #10601 placed"',
      'shows "Your order"',
      'shows "Cart total" and "Refund issued"',
      'the order total isn\'t "84.20 USD"',
      'no "Place order" button',
      "the order was placed",
    ]) {
      const judge = createFakeJudge((kind) => (kind === "screen_check" ? 0.05 : undefined));
      expect((await checkCondition({ judge, ...ids, condition, observation: page })).met).toBe(false);
      expect(judge.calls).toHaveLength(1);
    }
  });

  test("words the page says aren't so, or writes otherwise, still go to the judge", async () => {
    const mug = look(
      '- heading "Blue mug" [level=1, ref=e1]\n- status: Not in stock\n- alert: Changes couldn\'t be saved\n- text: Price 5.00 EUR',
    );
    for (const condition of ['"in stock"', '"saved"', '"$5.00"', '"Price 5.00 USD"']) {
      const judge = createFakeJudge((kind) => (kind === "screen_check" ? 0.05 : undefined));
      expect((await checkCondition({ judge, ...ids, condition, observation: mug })).met).toBe(false);
      expect(judge.calls).toHaveLength(1);
    }
    const judge = createFakeJudge(() => 0);
    expect(await checkCondition({ judge, ...ids, condition: '"Price 5.00 EUR"', observation: mug })).toEqual({
      met: true,
      p: 1,
    });
  });

  test("long runs of spaces in a condition or a question take no time to read", async () => {
    const saved = look("- status: Saved");
    const spaces = " ".repeat(100_000);
    for (const text of [
      `"Saved"${spaces}x`,
      `page${spaces}x`,
      `"Saved"${spaces}and${spaces}x`,
      `"Saved" is${spaces}x`,
      `"Saved"${"  ".repeat(50_000)}.x`,
    ]) {
      const judge = createFakeJudge(() => 0.05);
      const started = performance.now();
      await checkCondition({ judge, ...ids, condition: text, observation: saved });
      await findInPage({ judge, ...ids, question: text, observation: saved });
      expect(performance.now() - started).toBeLessThan(200);
    }
  });

  test("a wait until words show ends on the first look that shows them, with no judgment", async () => {
    let n = 0;
    const surface: ScreenSurface = {
      observe: async () => look(ordersPage(n++ > 0 ? { status: "Export ready" } : {})),
      perform: async () => ({ ok: true, observation: null }),
    };
    const judge = createFakeJudge((kind) => (kind === "screen_check" ? 0.05 : undefined));
    const report = await runPlan({ judge, ...ids, scope: "s", surface, now: fakeClock() }, [
      { do: "wait", until: '"Export ready"', seconds: 30 },
    ]);
    expect(report.steps[0]?.status).toBe("done");
    expect(judge.calls).toHaveLength(1);
  });

  test("a find that names words returns their lines with context, with no judgment", async () => {
    const judge = createFakeJudge(() => 0);
    const found = await findInPage({ judge, ...ids, question: '"Cart total"', observation: page });
    expect(judge.calls).toHaveLength(0);
    expect(found.answered).toBe("yes");
    expect(found.text).toContain("- paragraph: Cart total 84.20 USD");
    expect(found.text).toContain('- button "Place order" [ref=e901]');
  });
});

describe("finding in a page sends each line once", () => {
  test("options are line ids; the same line is found far down the page", async () => {
    const page = look(ordersPage());
    const judge = createFakeJudge((kind, id, state) => {
      if (kind !== "screen_find") return undefined;
      const text = (state.page as { lines: string }).lines;
      const hit = /^(L\d+): - paragraph: Cart total/m.exec(text)?.[1];
      if (id === "answers") return hit ? 0.95 : 0.02;
      return hit ? { choice: hit, probabilities: { [hit]: 0.9 } } : "none";
    });
    const found = await findInPage({ judge, ...ids, question: "the cart total", observation: page });
    expect(found.answered).toBe("yes");
    expect(found.text).toContain("- paragraph: Cart total 84.20 USD");
    for (const c of judge.calls) {
      const criteria = (c.questions.where as { criteria: Record<string, string> }).criteria;
      for (const [key, value] of Object.entries(criteria)) {
        if (key !== "none") expect(value).toBe(`line ${key}`);
      }
      expect(size(c)).toBeLessThan(45_000);
    }
  });
});

describe("SCREEN_JUDGMENTS", () => {
  const page = look(ordersPage());
  /** Far enough down to be in a full check's 60k characters, and too far for a small one's 16k. */
  const deep = "Order #10300 ";

  test("by default a check sends the page as it always did, and quoted words still go to the judge", async () => {
    setScreenJudgments("full");
    const judge = readingJudge(deep);
    expect(await checkCondition({ judge, ...ids, condition: "the order history is shown", observation: page })).toEqual(
      { met: true, p: 0.95 },
    );
    const text = sentText(judge.calls[0] as JudgeRequest);
    expect(text.length).toBeGreaterThan(55_000);
    expect((judge.calls[0] as JudgeRequest).state.screen).not.toHaveProperty("left_out");
    await checkCondition({ judge, ...ids, condition: '"Cart total"', observation: page });
    expect(judge.calls).toHaveLength(2);
  });

  test("by default a find's options are the lines themselves", async () => {
    setScreenJudgments("full");
    const judge = createFakeJudge(() => undefined);
    await findInPage({ judge, ...ids, question: '"Cart total"', observation: page });
    expect(judge.calls.length).toBeGreaterThan(0);
    const criteria = ((judge.calls[0] as JudgeRequest).questions.where as { criteria: Record<string, string> })
      .criteria;
    expect(criteria.L2).toBe('- link "Northwind Supply" [ref=e1]');
  });

  test("small applies to the listed workspaces only", async () => {
    setScreenJudgments("small", ["o"]);
    const judge = readingJudge(deep);
    expect(
      (await checkCondition({ judge, ...ids, condition: "the order history is shown", observation: page })).met,
    ).toBe(false);
    expect(sentText(judge.calls[0] as JudgeRequest).length).toBeLessThanOrEqual(16_000);
    const other = { ...ids, orgId: "another" };
    expect(
      (await checkCondition({ judge, ...other, condition: "the order history is shown", observation: page })).met,
    ).toBe(true);
    expect(sentText(judge.calls[1] as JudgeRequest).length).toBeGreaterThan(55_000);
  });

  test("shadow: the full check decides, both are recorded and logged, the page's text never is", async () => {
    const lines: { level: string; message: string; data?: Record<string, unknown> }[] = [];
    setScreenJudgments("shadow", ["o"], {
      info: (message, data) => lines.push({ level: "info", message, data }),
      warn: (message, data) => lines.push({ level: "warn", message, data }),
    });
    const reading = readingJudge(deep);
    // A judge that reports tokens, as Jev and the small model do.
    const judge: Judge = {
      name: "counting",
      ask: (r) => {
        r.onUsage?.({ inputTokens: Math.ceil(size(r) / 4), outputTokens: 1 });
        return reading.ask(r);
      },
    };
    const shadow: ScreenJudgmentShadow[] = [];
    const r = await checkCondition({
      judge,
      ...ids,
      shadow,
      condition: "the order history is shown",
      observation: page,
    });
    expect(r).toEqual({ met: true, p: 0.95 });
    expect(shadow).toHaveLength(1);
    const [s] = shadow as [ScreenJudgmentShadow];
    expect(s).toMatchObject({
      kind: "screen_check",
      agree: false,
      full: { decision: true, p: 0.95, calls: 1 },
      small: { decision: false, p: 0.05, calls: 1 },
    });
    expect(s.small.chars).toBeLessThan(s.full.chars / 3);
    expect(s.small.inputTokens).toBeLessThan(s.full.inputTokens as number);
    expect(lines).toEqual([
      { level: "warn", message: "screen judgment shadow", data: expect.objectContaining({ ...s, runId: "r" }) },
    ]);
    expect(JSON.stringify(lines)).not.toContain("Northwind");

    // Words already on the screen: the small path needs no judgment, and the two agree.
    await checkCondition({ judge, ...ids, shadow, condition: '"Cart total"', observation: page });
    expect(shadow[1]).toMatchObject({ agree: true, small: { decision: true, calls: 0, chars: 0, inputTokens: null } });
    expect(lines[1]?.level).toBe("info");
  });

  test("shadow on a find and in a plan: the full answer is returned, every judgment recorded", async () => {
    setScreenJudgments("shadow");
    const judge = createFakeJudge((kind, id, state) => {
      if (kind === "screen_check") return 0.95;
      if (kind !== "screen_find") return undefined;
      const hit = /^(L\d+): - paragraph: Cart total/m.exec((state.page as { lines: string }).lines)?.[1];
      if (id === "answers") return hit ? 0.95 : 0.02;
      return hit ? { choice: hit, probabilities: { [hit]: 0.9 } } : "none";
    });
    const shadow: ScreenJudgmentShadow[] = [];
    const found = await findInPage({ judge, ...ids, shadow, question: "the cart total", observation: page });
    expect(found.answered).toBe("yes");
    expect(shadow[0]).toMatchObject({ kind: "screen_find", agree: true, full: { decision: "yes" } });
    const surface: ScreenSurface = {
      observe: async () => page,
      perform: async () => ({ ok: true, observation: null }),
    };
    const report = await runPlan({ judge, ...ids, scope: "s", surface, shadow, now: fakeClock() }, [
      { do: "wait", until: "the cart shows a total", seconds: 5 },
    ]);
    expect(report.steps[0]?.status).toBe("done");
    expect(shadow[1]).toMatchObject({ kind: "screen_check", agree: true });
  });
});

/** A clock that moves a second each time it is read: a wait polls without sleeping. */
function fakeClock() {
  let t = 0;
  return () => (t += 1000);
}
