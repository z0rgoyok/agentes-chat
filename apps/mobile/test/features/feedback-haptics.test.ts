import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("a toast is felt as it comes in, by its tone", () => {
  const toast = src("ui/Toast.tsx");
  expect(toast).toContain("toastHaptic(item.tone ?? toastToneOf(item.icon));");
  expect(toast).toMatch(
    /if \(tone === "danger"\) haptics\.error\(\);\s*else if \(tone === "warning"\) haptics\.warning\(\);\s*else if \(tone === "success"\) haptics\.success\(\);\s*else haptics\.light\(\);/,
  );
});

test("an in-app notice arriving is a firm tap", () => {
  const island = src("features/island/NoticeIsland.tsx");
  expect(island).toContain("if (snap.items.length) haptics.medium();");
});

test("the send tap answers in its own frame; the send follows on the next", () => {
  const composer = src("ui/Composer.tsx");
  const send = composer.slice(
    composer.indexOf("  const send = (how: SendHow) => {"),
    composer.indexOf("  const wasTaught = "),
  );
  // Emptied first, then the send scheduled: the conversation's redraw never holds the field and the button back.
  expect(send).toMatch(
    /clear\(\);\s*const joining = working \? how : "join";\s*requestAnimationFrame\(\(\) => onSend\(value, joining\)\);/,
  );
  // The press gives the haptic before it sends (a hold gives its own firm one).
  expect(composer).toMatch(/if \(has\) \{\s*haptics\.light\(\);/);
});
