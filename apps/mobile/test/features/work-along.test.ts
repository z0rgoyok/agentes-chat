import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markedPieces, markInk } from "@agenteschat/client/lib/activity";
import type { WorkItem } from "@agenteschat/client/lib/working";
import {
  ALONG_STRIP,
  alongHref,
  alongInAccessory,
  alongRunId,
  alongStripBottom,
  alongWords,
  givesWay,
  runMenuItems,
  workAlong,
} from "../../src/features/work-along/logic";
import { translator } from "./fixtures";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  key: "r:r-1",
  agentId: "atlas",
  kind: "run",
  what: null,
  channelId: "c-vendas",
  threadId: null,
  where: { kind: "channel", name: "vendas" },
  missionId: null,
  plan: null,
  since: new Date(NOW - 5 * 60_000).toISOString(),
  waiting: false,
  forAgentId: null,
  messageId: null,
  ...over,
});

describe("the work-along line, the phone's Agora (ADR 0128 addendum)", () => {
  test("its words: whom it helps, what waits on you, what it is on", async () => {
    const t = await translator("pt-BR");
    expect(alongWords(t, item({ forAgentId: "ada" }), "Atlas", "Ada")).toBe("Atlas · ajudando a Ada");
    expect(alongWords(t, item({ waiting: true, forAgentId: "ada" }), "Atlas", "Ada")).toBe("Atlas · esperando você");
    expect(alongWords(t, item({ what: "Corrigir o link" }), "Atlas")).toBe("Atlas · Corrigir o link");
    expect(alongWords(t, item(), "Atlas")).toBe("Atlas está trabalhando");
    const en = await translator("en");
    expect(alongWords(en, item({ forAgentId: "ada" }), "Atlas", "Ada")).toBe("Atlas · helping Ada");
    // On a short line the names and a title give way, the words between them stay whole.
    const long = "Bartolomeu Constantino de Albuquerque e Vasconcelos";
    expect(markedPieces(alongWords(t, item({ forAgentId: "ada" }), long, "Ada", markInk))).toEqual([
      { text: long, bold: true },
      { text: " · ajudando a ", bold: false },
      { text: "Ada", bold: true },
    ]);
    // A short name stays whole beside a long one: "Ada · ajudando o Bartolomeu…".
    expect(markedPieces(alongWords(t, item({ forAgentId: "atlas" }), "Ada", long, markInk)).map(givesWay)).toEqual([
      false,
      false,
      true,
    ]);
    expect(markedPieces(alongWords(t, item({ what: "Corrigir o link" }), "Atlas", undefined, markInk))).toEqual([
      { text: "Atlas", bold: true },
      { text: " · ", bold: false },
      { text: "Corrigir o link", bold: true },
    ]);
  });

  test("a tap: one piece of work opens its place, at the reply that handed it; several open the task manager", () => {
    const handed = item({ threadId: "t-9", messageId: "m-9", forAgentId: "ada" });
    expect(alongHref(handed, 0)).toBe("/chat/c-vendas?thread=t-9&m=m-9");
    expect(alongHref(handed, 2)).toBe("/task-manager");
    // Its long press acts on a run; a mission has none.
    expect(alongRunId(handed)).toBe("r-1");
    expect(alongRunId(item({ key: "m:mission-1", kind: "mission" }))).toBeNull();
  });

  test("a long press: Ver passos for a run the task manager lists, Parar for who may; a run it hides opens its place", () => {
    expect(runMenuItems({ canStop: true })).toEqual(["steps", "stop"]);
    expect(runMenuItems({ canStop: false })).toEqual(["steps"]);
    // Two agents' work, for someone who reads only where it was handed off: no steps to show, never an empty sheet.
    expect(runMenuItems(undefined)).toEqual([]);
    const line = readFileSync(join(import.meta.dir, "../../src/features/work-along/WorkAlong.tsx"), "utf8");
    expect(line.replace(/\s+/g, " ")).toContain(
      "if (items.length === 0 || !task) { router.push(alongHref(lead, 0)); return; }",
    );
  });

  test("what waits on you leads, then the newest long work; a quick reply never shows", () => {
    const quick = item({ key: "r:quick", since: new Date(NOW - 10_000).toISOString() });
    expect(workAlong([quick], NOW)).toBeNull();
    const along = workAlong([item(), item({ key: "r:wait", agentId: "theo", waiting: true }), quick], NOW);
    expect(along?.lead.key).toBe("r:wait");
    expect(along?.others).toBe(1);
  });

  test("iOS 26 holds it in the tab bar's accessory; Android and older iOS in a 48-point strip on the bar's top", () => {
    expect(alongInAccessory("ios", "26.1")).toBe(true);
    expect(alongInAccessory("ios", "18.4")).toBe(false);
    expect(alongInAccessory("android", 35)).toBe(false);
    expect(ALONG_STRIP).toBe(48);
    expect(alongStripBottom("android", 24)).toBe(0);
    expect(alongStripBottom("ios", 34)).toBe(83);
    // The tab roots keep its room at their lists' end, so no row moves under it; the layout gives it only where no
    // accessory holds the line.
    const shell = readFileSync(join(import.meta.dir, "../../src/ui/LargeTitleScreen.tsx"), "utf8");
    expect(shell).toContain("bottom: safe.bottom + TAB_BAR + footRoom");
    expect(shell).toContain("paddingBottom: bottomInset + (IOS ? 0 : footRoom)");
    // Under the system's large title the system keeps the list clear of the tab bar; the strip's room is ours.
    expect(shell).toContain("contentContainerStyle={{ paddingBottom: bottomInset + (foot?.height ?? 0) }}");
    const layout = readFileSync(join(import.meta.dir, "../../app/(app)/(main)/(tabs)/_layout.tsx"), "utf8");
    expect(layout.replace(/\s+/g, " ")).toContain(
      "along && !ACCESSORY ? { node: <AlongStrip />, height: ALONG_STRIP } : null",
    );
    expect(layout).toContain("{along && ACCESSORY ? (");
  });

  test("the tab bar is drawn again only when a line comes or goes; the line reads its own words and clock", () => {
    const layout = readFileSync(join(import.meta.dir, "../../app/(app)/(main)/(tabs)/_layout.tsx"), "utf8");
    const line = readFileSync(join(import.meta.dir, "../../src/features/work-along/WorkAlong.tsx"), "utf8");
    // The layout knows only whether there is a line, from the line's own clock, so the line's ticks never reach it.
    expect(layout).toContain("const along = useHasWorkAlong();");
    expect(layout).not.toContain("useWorkAlong()");
    expect(line).toContain(
      "useSyncExternalStore(alongClock.subscribe, () => workAlong(pool, alongClock.now()) !== null)",
    );
    expect(line).not.toContain("useNow(");
    // Its look is made once: the bar's colors per theme, each tab's glyphs once for all.
    expect(layout).toContain("iconColor={look.iconColor}");
    expect(layout).toContain("src={ICONS[tab.name]}");
    // A tab change is the system's own: no haptic of ours, and no listener on every tab press.
    expect(layout).not.toContain("haptics");
    expect(layout).not.toContain("screenListeners");
  });

  test("its face and orbit move only while the screen it is on shows", () => {
    const line = readFileSync(join(import.meta.dir, "../../src/features/work-along/WorkAlong.tsx"), "utf8");
    expect(line).toContain("const focused = useIsFocused();");
    expect(line).toContain("<LivePause paused={!focused}>");
  });
});
