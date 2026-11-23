import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openingDockHeight, rememberDockHeight } from "../../src/features/chat/dock-height";
import { chatScreenSource } from "./chat-screen-source";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");
const chat = chatScreenSource();

test("a conversation opens with the dock's room known before the list places its end", () => {
  // The height laid out last, or a one-line composer over the home indicator before any.
  expect(openingDockHeight(89)).toBe(89);
  rememberDockHeight(0);
  expect(openingDockHeight(89)).toBe(89);
  rememberDockHeight(121);
  expect(openingDockHeight(89)).toBe(121);
  expect(chat).toContain(
    "const boxHeight = useSharedValue(openingDockHeight(Math.max(insets.bottom, 10) + DOCK_LINE));",
  );
  expect(chat).toMatch(/boxHeight\.set\(height\);\s*rememberDockHeight\(height\);/);
  // The list's end starts there too, and the list is told as it mounts (the keyboard list's own report is a round trip
  // from the UI thread that landed after the list said it was placed: Legend List #586).
  expect(src("features/chat/list-end.ts")).toContain("const end = useSharedValue(box.get());");
  expect(chat).toMatch(/listRef\.current = list;\s*list\?\.reportContentInset\(\{ bottom: listEnd\.get\(\) \}\);/);
  expect(chat).toContain("ref={attachList}");
});

test("opening at its latest message, the list shows only once it sits at its end", () => {
  // Three times over two frames, then the fade (v0's and Expensify's lists; Legend List #600).
  expect(chat).toMatch(
    /if \(!opensAtEnd\.current\) \{\s*show\(\);\s*return;\s*\}[\s\S]{0,400}void listRef\.current\?\.scrollToEnd\(\{ animated: false \}\);\s*requestAnimationFrame\(\(\) => \{\s*void listRef\.current\?\.scrollToEnd\(\{ animated: false \}\);\s*requestAnimationFrame\(\(\) => \{\s*void listRef\.current\?\.scrollToEnd\(\{ animated: false \}\);\s*show\(\);/,
  );
  // Once: the fallback timer and the list's own word don't place it twice.
  expect(chat).toMatch(/if \(revealing\.current\) return;\s*revealing\.current = true;/);
  expect(chat).toContain("opensAtEnd.current = openFrom === null && !focusId;");
});

test("a message sent slides up into view in one motion and is there at once, whole", () => {
  // Going to the end glides the list's own follow of its end for a moment, instead of a jump and a second scroll.
  expect(chat).toContain("const GLIDE = { animated: true } as const;");
  expect(chat).toMatch(/setAtEnd\(true\);\s*setGlide\(\(n\) => n \+ 1\);/);
  // Every follow of the end glides: a reply's next line too, never a jump.
  expect(chat).toContain("maintainScrollAtEnd={readHold || gap ? false : GLIDE}");
  // The dock growing or shrinking moves the list's end with a short ease, not at once.
  expect(src("features/chat/list-end.ts")).toContain(
    "end.set(previous === null ? next : withTiming(next, END_FOLLOW));",
  );
  // Meanwhile the keyboard list's instant shift for the growing dock is held, and a cover keeps its own hold.
  expect(chat).toMatch(
    /if \(glide === 0\) return;\s*if \(!covered\.current\) freeze\.value = true;\s*const timer = setTimeout\(\(\) => \{\s*setGlide\(0\);\s*if \(!covered\.current\) freeze\.value = false;\s*\}, GLIDE_MS\);/,
  );
  // My own words never fade in; someone else's still rise in.
  expect(chat).toContain("entering={fresh && m.author.id !== meId ? ENTER : undefined}");
});
