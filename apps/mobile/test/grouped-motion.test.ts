import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const grouped = readFileSync(join(import.meta.dir, "../src/ui/Grouped.tsx"), "utf8");

test("a grouped list never slides: a part that opens or closes changes the form at once, a new row fades in place", () => {
  // Each view on its own layout transition jerked the whole form whenever a part of it opened (a card growing, the
  // groups under it gliding), and a row leaving faded over what had already taken its place.
  expect(grouped).not.toContain("LinearTransition");
  expect(grouped).not.toContain("exiting=");
  expect(grouped).toContain("const ROW_IN = FadeIn.duration(motion.fast);");
  expect(grouped).toContain("<Animated.View key={child.key ?? i} entering={reducedMotion ? undefined : ROW_IN}>");
});

test("a pushed bar says whether its large title is on, and holds a word beside its buttons", () => {
  const parts = readFileSync(join(import.meta.dir, "../src/features/shared/parts.tsx"), "utf8");
  // Options merge: a set without it kept the large title an earlier render turned on (an empty band, a search that
  // never folded the title away).
  expect(parts).toContain("...(IOS ? { headerLargeTitleEnabled: largeTitle } : null),");
  expect(parts).toContain(
    "...(hasActions ? withWord(actionOptions, word, wordOff, wordOpens, () => press.current?.()) : null),",
  );
});
