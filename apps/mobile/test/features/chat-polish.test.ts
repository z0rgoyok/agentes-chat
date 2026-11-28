import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyReceiptEvent, receiptTicks } from "@agenteschat/client";
import { dayInView } from "../../src/features/chat/logic";
import { appColors, toastToneOf, toneColor } from "../../src/ui/palette";
import { chatScreenSource } from "./chat-screen-source";
import { message } from "./fixtures";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe("the floating date while the conversation scrolls", () => {
  test("the day of the topmost row in view that has one: a day line, else a message", () => {
    const m = message({ id: "a", createdAt: "2026-10-30T12:00:00.000Z" });
    expect(
      dayInView([
        { index: 4, item: { kind: "message", message: m } },
        { index: 3, item: { kind: "unseen" } },
        { index: 5, item: { kind: "day", iso: "2026-10-31T00:00:00.000Z" } },
      ]),
    ).toBe("2026-10-30T12:00:00.000Z");
    expect(dayInView([{ index: 2, item: { kind: "day", iso: "2026-10-29T00:00:00.000Z" } }])).toBe(
      "2026-10-29T00:00:00.000Z",
    );
    expect(dayInView([{ index: 1, item: { kind: "run" } }])).toBeNull();
    expect(dayInView([])).toBeNull();
  });

  test("none while the list's first row is in view: above it are the greeting and the setup card, which have no day", () => {
    const m = message({ id: "a", createdAt: "2026-10-30T12:00:00.000Z" });
    expect(
      dayInView([
        { index: 0, item: { kind: "day", iso: "2026-10-30T00:00:00.000Z" } },
        { index: 1, item: { kind: "message", message: m } },
      ]),
    ).toBeNull();
    expect(dayInView([{ index: 1, item: { kind: "message", message: m } }])).toBe("2026-10-30T12:00:00.000Z");
  });

  test("the day it keeps stays the same string while rows of that day pass the top, so scrolling skips re-renders", () => {
    const at = (createdAt: string) => [
      { index: 3, item: { kind: "message", message: message({ id: createdAt, createdAt }) } },
    ];
    const prev = "2026-10-30T12:00:00.000Z";
    expect(dayInView(at(new Date(new Date(prev).getTime() + 60_000).toISOString()), prev)).toBe(prev);
    expect(dayInView(at("2026-10-27T12:00:00.000Z"), prev)).toBe("2026-10-27T12:00:00.000Z");
    expect(dayInView([], prev)).toBeNull();
  });

  test("it shows while the person drags or flings the list and fades a moment after it stops", () => {
    const screen = chatScreenSource();
    // The faces hold still while it moves (`useStillWhileScrolling`): a drag or a glide holds them, the end lets go.
    // (A drag also takes the list's reach to a screen's height at once: `setReachStep`.)
    expect(screen).toMatch(
      /const onDragStart = useCallback\(\(\) => \{\s*dragging\.current = true;\s*setReachStep\(REACH_LAST\);\s*still\.hold\(\);\s*showDay\(\);/,
    );
    expect(screen).toContain("onScrollBeginDrag={onDragStart}");
    expect(screen).toMatch(/const onGlide = useCallback\(\(\) => \{\s*still\.hold\(\);\s*showDay\(\);/);
    expect(screen).toContain("onMomentumScrollBegin={onGlide}");
    expect(screen).toMatch(
      /const onScrollSettled = useCallback\(\(\) => \{\s*still\.settle\(\);\s*releaseAtEnd\(\);\s*hideDay\(\);/,
    );
    expect(screen).toContain("onMomentumScrollEnd={onScrollSettled}");
    // Kept outside the screen's state: the pill alone redraws as a day reaches the top.
    expect(screen).toContain("topDay.set(dayInView(viewableItems, topDay.get()));");
    expect(screen).toContain("<DayPill day={topDay} shown={dayShown} top={hasPin ? 8 : headerHeight + 8} />");
    // The person's locale: the shared day words ("Hoje", "Ontem", a weekday this week, else a date).
    expect(src("features/chat/DatePill.tsx")).toContain('dayLabel(t, i18n.language || "en", day)');
  });
});

describe("toasts carry their tone in the icon", () => {
  test("a failure is danger, a done check success, any other icon neutral; a tone given wins", () => {
    expect(toastToneOf("x")).toBe("danger");
    expect(toastToneOf("alert")).toBe("danger");
    expect(toastToneOf(undefined)).toBe("success");
    expect(toastToneOf("check")).toBe("success");
    expect(toastToneOf("copy")).toBe("neutral");
    expect(src("ui/Toast.tsx")).toContain("item.tone ?? toastToneOf(item.icon)");
  });

  test("the toast is a calm capsule: the tone is its icon's color alone, no plate and no tint", () => {
    const toast = src("ui/Toast.tsx");
    expect(toast).toContain('<Icon name={item.icon ?? "check"} size={18} color={toneColor(colors, tone)} />');
    expect(toast).not.toContain("LinearGradient");
    expect(toast).not.toContain("styles.tile");
    expect(toast).toContain('box: { borderRadius: TOAST_R, maxWidth: "100%" },');
    for (const scheme of ["light", "dark"] as const)
      expect(toneColor(appColors(scheme), "danger")).toBe(appColors(scheme).danger);
  });
});

describe("nobody will answer: the receipt's sheet, never a line", () => {
  test("the sheet says it and offers each agent it reached to call, with its @handle put in the box", () => {
    const receipts = src("features/chat/AgentReceipts.tsx");
    expect(receipts).toContain('t(mentionNeeded ? "receipts.mentionNeeded" : "receipts.nobody")');
    expect(receipts).toContain('<GroupedHeader>{t("channel.callAgent")}</GroupedHeader>');
    expect(receipts).toMatch(/requestComposerText\(m\.channelId, `@\$\{c\.handle\} `\)/);
    // The marks are the clock, one tick and two.
    expect(receipts).toMatch(/if \(mark === "none"\) return null;\s*return <Icon name=\{mark\}/);
  });
});

describe("a reply heard live", () => {
  test("too big for its event, it still refreshes its thread's link and header", () => {
    expect(src("features/chat/live.ts")).toContain("const threadId = repliedThread(event);");
    expect(src("features/chat/live.ts")).toContain("refreshRepliedThread(qc, orgId, threadId)");
  });
});

describe("a reply in a task's conversation", () => {
  test("the task lists read again, as the web's", () => {
    expect(src("features/shared/userEvents.ts")).toContain("applyIssueEvent(qc, orgId, event);");
  });
});

describe("my message's clock from the moment it is sent", () => {
  test("sent into a channel with agents, it wears the clock before the server says anything, as the web's", () => {
    const screen = chatScreenSource();
    // At the optimistic write, as the web's: the clock is on my message's copy from its first frame (a GIF or a
    // sticker alone routes to nobody), and moves to its server id with it.
    const optimistic = screen.slice(
      screen.indexOf("onOptimistic: (local) => {"),
      screen.indexOf("onSent: (message, local) => {"),
    );
    expect(optimistic).toContain("if (isMediaAlone(local)) return;");
    expect(optimistic).toContain("if (channel && channelAgents.length > 0) live.picking(local.id);");
    expect(screen).toContain("live.retarget(local.id, message.id);");
    expect(src("features/chat/live.ts").replace(/\s+/g, " ")).toContain(
      'dispatch({ type: "event", event: { type: "message.routing", channelId, messageId, step: "plan" }, at: Date.now(), })',
    );
    const picking = applyReceiptEvent({}, { type: "message.routing", channelId: "c", messageId: "m", step: "plan" });
    expect(receiptTicks(picking.m)).toBe("clock");
    const routed = applyReceiptEvent(picking, {
      type: "message.routed",
      channelId: "c",
      messageId: "m",
      seenBy: ["a"],
      pickedBy: [],
      strategy: "router",
    });
    expect(receiptTicks(routed.m)).toBe("checks");
  });
});

describe("a conversation with a pinned message", () => {
  test("no header fade over the first messages: the list starts below the pinned bar, whose hairline is the edge", () => {
    const screen = chatScreenSource();
    const fade = screen.indexOf("styles.topFade, { height: headerHeight + 28 }");
    expect(fade).toBeGreaterThan(0);
    // Inside the keyboard's gesture area (`DockGestureArea`), only without a pinned bar or card.
    expect(screen.lastIndexOf("<DockGestureArea", fade)).toBeGreaterThan(0);
    expect(screen.lastIndexOf("{!hasPin ? (", fade)).toBeGreaterThan(screen.lastIndexOf("<DockGestureArea", fade));
    expect(src("features/chat/PinsSheet.tsx")).not.toMatch(/boxShadow|shadowOpacity|elevation/);
  });
});

describe("going to a message", () => {
  test("not shown after its page was read, it waits for a cached page refreshing before saying it's gone", () => {
    const screen = chatScreenSource();
    const refresh = screen.indexOf("if (!seekRefreshing) missing();");
    expect(refresh).toBeGreaterThan(0);
    expect(screen.lastIndexOf("if (around?.id === seek && around.done) {", refresh)).toBeGreaterThan(0);
    // In a thread too, once the conversation's own page has none of it.
    expect(screen.indexOf("if (seekRefreshing) return;", refresh)).toBeGreaterThan(refresh);
    expect(screen).toContain("const seekRefreshing = isThread ? threadMessages.isFetching : top.isFetching;");
  });
});

describe("back to the latest messages", () => {
  test("the round button sits at the bottom right, above the composer, riding the keyboard with it", () => {
    const screen = chatScreenSource();
    // In the composer's own dock, before the box: one view rides the keyboard and both move in the same frame.
    const dock = screen.indexOf("style={styles.composerDock}");
    expect(dock).toBeGreaterThan(0);
    expect(screen.lastIndexOf("<KeyboardStickyView", dock)).toBeGreaterThan(
      screen.lastIndexOf("</Animated.View>", dock),
    );
    const button = screen.indexOf("<ToLatest unseen={unseen} onPress={toEnd} />", dock);
    expect(button).toBeGreaterThan(dock);
    expect(screen.indexOf("ref={composerRef}", dock)).toBeGreaterThan(button);
    expect(screen).toContain('jumpAt: { alignSelf: "flex-end", marginRight: DOCK_SIDE + 4, marginBottom: 10 },');
    expect(screen).not.toContain("bottom: composerHeight + 10");
  });
});
