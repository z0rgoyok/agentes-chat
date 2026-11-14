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
