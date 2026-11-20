import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (file: string) => readFileSync(join(import.meta.dir, "../src", file), "utf8");

test("the closed island's face is round at the pill's end, the open list keeps the tile", () => {
  const island = source("features/island/NoticeIsland.tsx");
  const faces = [...island.matchAll(/<IslandFace\b([^>]*)\/>/g)].map((m) => m[1] ?? "");
  expect(faces).toEqual([" n={item.n} size={40} round ", " n={item.n} size={SMALL_FACE} round ", " n={n} size={34} "]);
  expect(island).toContain("const radius = round ? size / 2 : undefined;");
  expect(island).toContain("<Face who={who} size={size} radius={radius} />");
});

test("the island's shape is an empty backdrop that springs; its content lays out once, at its final size", () => {
  const island = source("features/island/NoticeIsland.tsx");
  // Settled with almost no overshoot well before the content fades in, so nothing shows past its edge.
  expect(island).toContain("const ISLAND_SPRING = { duration: 350, dampingRatio: 0.85 };");
  expect(island).not.toContain("motion.pop");
  // Only the empty backdrop's size and corner animate.
  expect(island).toContain("<Animated.View style={[styles.backdrop, backdrop]} />");
  expect(island).toContain(
    "const backdrop = useAnimatedStyle(() => ({ width: w.value, height: h.value, borderRadius: r.value }));",
  );
  // The content's box takes its final size from React, never an animated one.
  expect(island).toContain("<Animated.View style={[styles.content, { width, height, borderRadius: corner }, look]}>");
  // A chip's 36 points and its slop make a 44-point target.
  expect(island).toContain("minHeight: 36");
  expect(island).toContain("const CHIP_SLOP = 4;");
  expect(island).toContain("hitSlop={CHIP_SLOP}");
});

test("a face's corner reaches the tile it draws, through every layer to the agent and the person", () => {
  const face = source("features/shared/Face.tsx");
  expect(face).toContain("radius={radius}\n      />");
  expect(face).toContain("photo={photo} radius={radius} />");
  expect(face).toContain("radius={moment.radius}");
  expect(source("agent/AgentAvatar.tsx")).toContain("borderRadius: radius ?? size * 0.3");
  expect(source("agent/AgentAvatar.tsx")).toContain("a.radius === b.radius");
  const person = source("agent/PersonAvatar.tsx");
  expect(person).toContain("radius = size * 0.3");
  expect(person.match(/borderRadius: radius\b/g)?.length).toBe(2);
});
