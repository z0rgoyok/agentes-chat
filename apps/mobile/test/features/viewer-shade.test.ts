import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const viewer = readFileSync(join(import.meta.dir, "../../src/features/files/ImageViewer.tsx"), "utf8");

test("the picture viewer's bars sit on a shade that fades into the picture", () => {
  // Behind the name and ×, and behind the actions: drawn first, so the words and buttons are over it.
  expect(viewer).toContain(
    '<LinearGradient pointerEvents="none" colors={SHADE_DOWN} locations={SHADE_STOPS} style={styles.shadeTop} />',
  );
  expect(viewer).toContain(
    '<LinearGradient pointerEvents="none" colors={SHADE_UP} locations={SHADE_STOPS} style={styles.shadeBottom} />',
  );
  // Past each bar into the picture, never a hard band.
  expect(viewer).toContain("bottom: -SHADE_PAST");
  expect(viewer).toContain("top: -SHADE_PAST");
});
