import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUBBLES_EDGE,
  BUBBLES_END,
  buildRows,
  type ChatRow,
  PAUSE_MS,
  ROW_BODY_INSET,
} from "../../src/features/chat/logic";
import { chatScreenSource } from "./chat-screen-source";
import { message } from "./fixtures";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
const at = (hh: number, mm: number, day = 18) => new Date(2026, 10, day, hh, mm).toISOString();
/** The rows as short words: "day" or "day+time" lines, and messages by id. */
const shape = (rows: ChatRow[]) => rows.map((r) => (r.kind === "day" ? (r.at ? "time" : "day") : r.message.id));

describe("a conversation of bubbles breathes", () => {
  test("bubbles stand 16 from both edges; someone else's stop 60 from the right", () => {
    expect(BUBBLES_EDGE).toBe(16);
    expect(BUBBLES_END).toBe(60);
    expect(ROW_BODY_INSET.bubbles.right).toBe(BUBBLES_END);
    const look = src("features/chat/look.ts");
    expect(look).toContain("bubblesRow: { paddingLeft: BUBBLES_INSET, paddingRight: BUBBLES_END, gap: 8 },");
    // One line is 40 tall: 24 and 8 above and under, 14 at the sides.
    expect(look).toMatch(
      /bubble: \{\s+alignSelf: "flex-start",\s+maxWidth: "100%",\s+paddingVertical: 8,\s+paddingHorizontal: 14,/,
    );
  });

  test("a time line says when it picks up again: each day's first message and each after a pause", () => {
    const rows = buildRows(
      [
        message({ id: "a", createdAt: at(15, 29) }),
        message({ id: "b", createdAt: at(15, 30), author: { type: "agent", id: "ada" } }),
        // Under the pause: no line.
        message({ id: "c", createdAt: at(15, 40) }),
        // A pause: its line.
        message({ id: "d", createdAt: at(15, 55) }),
        // A new day: one line, with the time.
        message({ id: "e", createdAt: at(9, 2, 19) }),
      ],
      undefined,
      true,
    );
    expect(shape(rows)).toEqual(["time", "a", "b", "c", "time", "d", "time", "e"]);
    // The pause's line keeps its key as messages come (its message's), and nothing groups across it.
    const pause = rows[4];
    expect(pause?.kind === "day" && pause.key).toBe("at-d");
    const d = rows[5];
    expect(d?.kind === "message" && d.grouped).toBe(false);
    expect(PAUSE_MS).toBe(15 * 60_000);
  });

  test("outside bubbles (every message shows its time) only the day's line, as before", () => {
    const rows = buildRows([message({ id: "a", createdAt: at(15, 0) }), message({ id: "b", createdAt: at(17, 0) })]);
    expect(shape(rows)).toEqual(["day", "a", "b"]);
  });

  test("the time line is the day and the time, quieter than a day's, only where messages hold no time", () => {
    const chat = chatScreenSource();
    expect(chat).toContain("const timeLines = timesOnPull(rowLook.style);");
    expect(src("features/chat/look.ts")).toContain(
      'export const timesOnPull = (style: ChatStyle) => style === "bubbles" || style === "compact";',
    );
    expect(chat).toContain("buildRows(list, hidden, timeLines)");
    expect(chat).toContain(
      'dayLine(t("mobile.chat.dayAt", { day: when.day(item.iso), time: when.time(item.iso) }), true)',
    );
    expect(chat).toContain('dayAt: { fontWeight: "400" },');
    expect(chat).toContain("const TIME_LINE_AIR = 6;");
  });

  test("air under the last message, and a capsule that floats narrower at rest and opens with the keyboard", () => {
    const chat = chatScreenSource();
    expect(chat).toContain("listPad: { paddingTop: 8, paddingBottom: LIST_END_AIR },");
    expect(chat).toContain("const LIST_END_AIR = 22;");
    // 16 more on each side with no keyboard, 0 with it open: on its progress, frame by frame.
    expect(chat).toContain("const DOCK_REST = 16;");
    expect(chat).toContain("const restSide = useDerivedValue(() => DOCK_REST * (1 - keyboardAt.progress.get()));");
    expect(chat).toContain("<Animated.View style={capsuleRest}>");
    // The picker over it and the way back to the latest messages (over its last button) move with it.
    expect(chat).toContain("<Animated.View style={[styles.float, floatRest]}");
    expect(chat).toContain("<Animated.View style={[styles.jumpAt, jumpRest]}");
    expect(chat).toContain(
      "const jumpRest = useAnimatedStyle(() => ({ marginRight: DOCK_SIDE + 4 + restSide.get() }));",
    );
  });
});
