import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe('the composer\'s "+"', () => {
  test("offers what goes with a message and two things to start; starting a mission isn't one of them", () => {
    const sheets = src("features/chat/sheets.tsx");
    expect(sheets).toContain(
      'export type PlusPick = "camera" | "photos" | "file" | "paste" | "media" | "summary" | "remind";',
    );
    expect(sheets).not.toContain("mobile.plus.mission");
    expect(src("features/i18n/keys.en.ts")).not.toContain("missionHint");
  });

  test("every sheet ends 24 over its bottom edge: the home indicator's room is the sheet's own", () => {
    const sheet = src("ui/Sheet.tsx");
    const body = sheet.slice(sheet.indexOf("export function useSheetBody("), sheet.indexOf("const styles"));
    expect(body).toContain("paddingBottom: 24,");
    expect(body).not.toContain("insets");
  });

  test("GIFs and stickers sit beside the mic in the empty field too, where they can be sent", () => {
    const chat = chatScreenSource();
    expect(chat).toContain("const mediaFromField = useLatest(openMedia);");
    expect(chat).toContain('(canSendMedia ? { label: t("media.picker.send"), onPress: mediaFromField } : null)');
    expect(chat).toContain("media={composerMedia}");
    // The field draws it only while empty, beside the mic.
    expect(src("ui/Composer.tsx")).toContain("const mediaButton = media && !has ? media : null;");
  });
});

describe("a voice message's play button", () => {
  test("36 round with a filled glyph, a finger's 44 to hit", () => {
    const voice = src("features/voice/VoiceMessage.tsx");
    expect(voice).toContain("const PLAY = 36;");
    expect(voice).toContain("hitSlop={(TOUCH - PLAY) / 2}");
    expect(voice).toContain(
      '<Icon name={playing ? "pause" : "play"} size={17} filled color={canPlay ? c.bg : c.muted} />',
    );
    expect(voice).toContain("play: { width: PLAY, height: PLAY, borderRadius: PLAY / 2 },");
    // The words under the wave start past it.
    expect(voice).toContain("words: { paddingLeft: PLAY + 10, paddingBottom: 2, gap: 2 },");
  });
});

describe("the long work's line in a message", () => {
  test('a quiet line under the bubble: its words open the work, a thin rule and "Parar", neutral until pressed', () => {
    const line = src("features/chat/WorkLine.tsx");
    expect(line).not.toContain("BarAction");
    expect(line).toContain("const go = actions.filter((a) => !a.danger).sort((a, b) => a.rank - b.rank)[0];");
    expect(line).toContain("color: halt.disabled ? c.faint : pressed ? c.danger : c.ink");
    // No brand blue on an action.
    expect(line).not.toContain("c.agent }]}");
    // On a task's screen it stays the screen's card.
    expect(line).toContain('<View style={[styles.card, surface]} accessibilityRole="summary">');
  });
});
