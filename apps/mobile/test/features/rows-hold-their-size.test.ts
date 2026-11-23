import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  forgetKeptSizes,
  keepColumns,
  keepSize,
  keptColumns,
  keptSize,
  MAX_KEPT,
} from "../../src/features/chat/kept-sizes";
import { type Inline, tableKey } from "../../src/features/chat/logic";
import { OPEN_DRAW_DISTANCE, REACH_LAST, reachOf } from "../../src/features/chat/screen/reach";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

afterEach(forgetKeptSizes);

describe("sizes kept across the list's unmounts", () => {
  test("a size and a table's columns come back as kept, each only as its own kind", () => {
    keepSize("words:m1:390", 812);
    keepColumns("table:t1:390", { 0: 120, 1: 64 });
    expect(keptSize("words:m1:390")).toBe(812);
    expect(keptColumns("table:t1:390")).toEqual({ 0: 120, 1: 64 });
    expect(keptColumns("words:m1:390")).toBeUndefined();
    expect(keptSize("table:t1:390")).toBeUndefined();
    expect(keptSize("words:m2:390")).toBeUndefined();
  });

  test("a table's columns are copied: the row's own state changing later never changes what was kept", () => {
    const drawn: Record<number, number> = { 0: 90 };
    keepColumns("table:t2:390", drawn);
    drawn[0] = 200;
    expect(keptColumns("table:t2:390")).toEqual({ 0: 90 });
  });

  test("bounded: past the cap the size kept longest ago goes, and keeping one again makes it the newest", () => {
    for (let i = 0; i < MAX_KEPT; i++) keepSize(`k${i}`, i + 1);
    // Measured again (its row came back): it is now the newest.
    keepSize("k0", 7);
    keepSize("one-more", 1);
    expect(keptSize("k0")).toBe(7);
    expect(keptSize("k1")).toBeUndefined();
    expect(keptSize("k2")).toBe(3);
    expect(keptSize("one-more")).toBe(1);
  });
});

describe("a table's key", () => {
  const cell = (text: string, kind: "text" | "bold" | "code" = "text"): Inline[] => [{ kind, text }];

  test("the same cells give the same key; other words, another kind or other cell edges give another", () => {
    const header = [cell("Plano"), cell("Preço")];
    const rows = [[cell("Pro"), cell("R$ 20")]];
    const key = tableKey(header, rows);
    expect(tableKey([cell("Plano"), cell("Preço")], [[cell("Pro"), cell("R$ 20")]])).toBe(key);
    expect(tableKey(header, [[cell("Pro"), cell("R$ 30")]])).not.toBe(key);
    expect(tableKey(header, [[cell("Pro", "bold"), cell("R$ 20")]])).not.toBe(key);
    expect(tableKey([cell("Pla"), cell("noPreço")], rows)).not.toBe(key);
    expect(key.startsWith("2x1:")).toBe(true);
  });
});

describe("rows that measure themselves come back at their size", () => {
  test("a long message is cut from its first frame when it comes back, and never draws whole before its first measure", () => {
    const clip = src("features/chat/ClippedMessage.tsx");
    // Kept by what it shows: an agent's message to another shows its start here and whole on its thread's screen.
    expect(clip).toMatch(
      /const sizeKey = `words:\$\{id\}:\$\{open \|\| lead == null \? "whole" : "lead"\}:\$\{useLayoutKey\(\)\}`;/,
    );
    expect(clip).toContain("const [height, setHeight] = useState(() => keptSize(sizeKey) ?? 0);");
    expect(clip).toContain("const unmeasured = height === 0 && !open && lead == null;");
    expect(clip).toContain('unmeasured: { maxHeight: LONG_MESSAGE.over + PAST_RULE, overflow: "hidden" },');
    // Words under the fold before and after a measure look the same at either height: only a fold draws again.
    expect(clip).toMatch(
      /keepSize\(sizeKey, next\);[\s\S]*?if \(cut === null && clippedHeight\(next\) === null\) return;\s*setHeight\(next\);/,
    );
  });

  test("a table lays out at its measured columns when it comes back", () => {
    const spans = src("features/chat/MessageSpans.tsx");
    expect(spans).toMatch(/const columnsKey = `table:\$\{content\}:\$\{useLayoutKey\(\)\}`;/);
    expect(spans).toMatch(
      /const \[measured, setMeasured\] = useState\(\(\) => \(\{\s*key: columnsKey,\s*columns: \{ \.\.\.keptColumns\(columnsKey\) \},/,
    );
    // New cells, another width or text size: measured anew, drawn meanwhile at the widths measured last.
    expect(spans).toMatch(
      /if \(measured\.key !== columnsKey\)\s*setMeasured\(\{\s*key: columnsKey,\s*columns: \{ \.\.\.keptColumns\(columnsKey\) \},\s*before: \{ \.\.\.measured\.before, \.\.\.measured\.columns \},/,
    );
    expect(spans).toContain("if (Object.keys(drawn).length > 0) keepColumns(columnsKey, drawn);");
    // Its unseen copy only while a column has no width yet (or a pill in it loads later): coming back, each cell is
    // drawn once.
    expect(spans).toContain("const unmeasured = header.some((_, col) => drawn[col] === undefined);");
    expect(spans).toContain("{unmeasured || late ? (");
  });

  test("a block is cut from its first frame when it comes back, and no taller than its card before its first measure", () => {
    const spec = src("features/blocks/SpecBlock.tsx");
    expect(spec).toContain(
      "const [sized, setSized] = useState(() => ({ key: sizeKey, height: keptSize(sizeKey) ?? 0 }));",
    );
    expect(spec).toContain('unmeasured: { maxHeight: INLINE_HEIGHT + PAST_RULE, overflow: "hidden" },');
    expect(spec).toMatch(/keepSize\(sizeKey, next\);\s*setSized\(/);
  });

  test("pictures and GIFs take the room kept for their side, sent and still sending alike", () => {
    const files = src("features/files/MessageFiles.tsx");
    expect(files.match(/useKeptWidth\(`files:\$\{align\}`\)/g)?.length).toBe(2);
    expect(files).not.toContain("setWidth(e.nativeEvent.layout.width)");
    const media = src("features/chat/ChatMedia.tsx");
    expect(media).toMatch(/useKeptWidth\(`gif:\$\{align\}`\)/);
    expect(media).not.toContain("setRoom(");
    // The key holds what the size depends on besides the content.
    const look = src("features/chat/look.ts");
    expect(look).toMatch(
      /return `\$\{Math\.round\(width\)\}:\$\{fontScale\}:\$\{style\}:\$\{faces \? 1 : 0\}:\$\{text\?\.fontSize \?\? 0\}`;/,
    );
  });

  test("the conversation draws a screen past each edge once placed, so rows mount and measure out of sight", () => {
    const chat = chatScreenSource();
    const reach = src("features/chat/screen/reach.ts");
    // While it opens at its end, a short reach: the list takes its whole reach at once there, two screens of rows.
    expect(chat).toContain("drawDistance={reachOf(reachStep, windowHeight)}");
    expect(reach).toContain("export const OPEN_DRAW_DISTANCE = 250;");
    // Then a screen's height, a step per idle moment once it is placed and the push has ended; a drag takes it there
    // at once, so a fling never outruns the rows.
    expect(chat).toMatch(/if \(!placed \|\| !settled \|\| reachStep >= REACH_LAST\) return;\s*return whenIdle\(/);
    expect(chat).toMatch(/dragging\.current = true;\s*setReachStep\(REACH_LAST\);/);
  });

  test("the list's reach grows from the opening one to a screen's height, ending where it always did", () => {
    expect(reachOf(0, 844)).toBe(OPEN_DRAW_DISTANCE);
    expect(reachOf(1, 844)).toBe(422);
    expect(reachOf(REACH_LAST, 844)).toBe(844);
    expect(reachOf(REACH_LAST, 812.6)).toBe(Math.round(812.6));
    // Half a short window is never less than the opening reach.
    expect(reachOf(1, 390)).toBe(OPEN_DRAW_DISTANCE);
  });
});
