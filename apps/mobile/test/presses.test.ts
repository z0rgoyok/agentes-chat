import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../src", path), "utf8");

test("a row's remove × is a finger's 44 that lights under the finger, and the row keeps its height", () => {
  const grouped = src("ui/Grouped.tsx");
  const remove = grouped.slice(grouped.indexOf("{remove ? ("), grouped.indexOf("{buttons?.length ? ("));
  expect(remove).toContain("unstable_pressDelay={PRESS_DELAY}");
  expect(remove).toContain("[styles.button, styles.remove, pressed ? { backgroundColor: c.sunken } : null]");
  expect(remove).not.toContain("hitSlop");
  expect(grouped).toContain(
    'button: { width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, alignItems: "center", justifyContent: "center" },',
  );
  // Pulled back by the circle's overhang (14 around a 16 glyph) and the row's 12 gap: the glyph stays put.
  expect(grouped).toContain("remove: { margin: -(TOUCH - REMOVE_GLYPH) / 2, marginLeft: -12 },");
  expect(16 + 2 * ((44 - 16) / 2)).toBe(44);
});

test("a plate button answers a press once: the kit's scale, not the glass's own answer too", () => {
  expect(src("ui/IconButton.tsx")).toMatch(/<Glass\s+liquid\s+interactive=\{false\}/);
  const glass = src("ui/Glass.tsx");
  expect(glass).toContain("isInteractive={interactive}");
  // Other glass (the docks) keeps the system's answer to a touch.
  expect(glass).toContain("interactive = true,");
});
