import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatScreenSource } from "./chat-screen-source";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("one capsule holds the composer: the '+' at its start, the quiet buttons on the neutral fill, send in ink", () => {
  const composer = src("ui/Composer.tsx");
  // The "+" inside the field, after the attachments' row (which takes a line of its own), before the words.
  const field = composer.slice(composer.indexOf("styles.field,"), composer.indexOf("<View style={styles.inputBox}>"));
  expect(field).toContain('{onPlus ? <PlusButton label={t("mobile.a11y.attach")} onPress={onPlus} /> : null}');
  expect(field.indexOf("styles.attachRow")).toBeLessThan(field.indexOf("<PlusButton"));
  expect(field).toContain("paddingLeft: onPlus ? INSET : 14,");
  // Nothing beside the capsule in its row.
  const row = composer.slice(composer.indexOf("<View style={styles.row}>"), composer.indexOf("styles.field,"));
  expect(row).not.toContain("PlusButton");
  // The quiet buttons: the send button's size, the neutral fill, their slop reaching the capsule's edges.
  expect(composer).toContain("plus: { width: SEND, height: SEND, borderRadius: SEND / 2 },");
  expect(composer).toContain("style={[styles.plus, { backgroundColor: colors.chip }]}");
  expect(composer).toContain("style={[styles.media, { backgroundColor: colors.chip }]}");
  expect(src("features/voice/useVoiceComposer.tsx")).toContain(
    'style={[styles.button, { backgroundColor: phase === "hold" ? c.ink : c.chip }, micStyle]}',
  );
  // A raised capsule whose edge reads on any ground (the system's separator), as a take's bar; no glass.
  expect(composer.match(/boxShadow: FIELD_SHADOW\(colors\.separator\)/g)).toHaveLength(2);
  expect(composer).not.toContain("<Glass");
});

test("the capsule sits 16 from the screen's sides, and what lines up with it follows", () => {
  const chat = chatScreenSource();
  expect(chat).toContain("const DOCK_SIDE = 16;");
  expect(chat).toContain("composer: { paddingHorizontal: DOCK_SIDE, paddingTop: 6 },");
  expect(chat).toContain("float: { paddingHorizontal: DOCK_SIDE },");
  // The way back to the latest messages, centered over the capsule's last button.
  expect(chat).toContain('jumpAt: { alignSelf: "flex-end", marginRight: DOCK_SIDE + 4, marginBottom: 10 },');
});
