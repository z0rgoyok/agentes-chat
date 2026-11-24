import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
/** The text from `from` up to `to`. */
const between = (text: string, from: string, to: string) => {
  const at = text.indexOf(from);
  expect(at).toBeGreaterThanOrEqual(0);
  return text.slice(at, text.indexOf(to, at + from.length));
};

test("the '+' asks whether a picture is copied before it opens, so its tiles never move under the thumb", () => {
  const open = between(chatScreenSource(), "const openPlus = async () => {", "const onPlus");
  expect(open.indexOf("await Clipboard.hasImageAsync()")).toBeLessThan(open.indexOf("sheet.open("));
  expect(open).toContain("paste={paste}");
  // Only whether there is one: reading the picture is what makes iOS ask, and that waits for the tap on Paste.
  expect(open).not.toContain("getImageAsync");
});

test("Paste reads the copied picture once the sheet is gone and puts it above the field like a picked photo", () => {
  const chat = chatScreenSource();
  const plus = chat.slice(chat.indexOf("await new Promise<void>((done) => sheet.close(done));"));
  const paste = between(plus, 'case "paste": {', 'case "file": {');
  expect(paste).toContain('await Clipboard.getImageAsync({ format: "png" })');
  expect(paste).toContain('toast({ title: t("mobile.plus.pasteGone"), icon: "paste" });');
  expect(paste).toContain('file.write(image.data.slice(image.data.indexOf(",") + 1), { encoding: "base64" });');
  expect(paste).toContain("addPending([");
});

test("the Paste tile shows only while a picture is copied, after File", () => {
  const sheets = src("features/chat/sheets.tsx");
  expect(sheets).toContain(
    '...(paste ? [{ key: "paste" as const, icon: "paste" as const, label: t("mobile.plus.paste") }] : []),',
  );
  expect(sheets.indexOf('label: t("mobile.plus.file")')).toBeLessThan(sheets.indexOf('label: t("mobile.plus.paste")'));
});
