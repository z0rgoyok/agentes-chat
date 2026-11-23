import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatScreenSource } from "./chat-screen-source";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("the composer's box is solid under its first line: the fade is a short band at its top", () => {
  const wall = src("features/chat/ChatWallpaper.tsx");
  expect(wall).toContain("export const DOCK_FADE = 16;");
  // Over a background: clear to solid in the box's first points, never down a third of it.
  expect(wall).toContain('const UNDER_ALPHA = ["rgba(0,0,0,0)", "rgba(0,0,0,1)", "rgba(0,0,0,1)"];');
  expect(wall).toContain("positions={[0, Math.min(1, DOCK_FADE / tall), 1]}");
  expect(wall).not.toContain("positions={[0, 0.3, 1]}");
  // On the page's own color: the band, then the page.
  const chat = chatScreenSource();
  expect(chat).toContain("<LinearGradient colors={[withOpacity(c.bg, 0), c.bg]} style={styles.dockFade} />");
  expect(chat).toContain("dockFade: { height: DOCK_FADE },");
  expect(chat).not.toContain("locations={[0, 0.3, 1]}");
});

test("the top is solid through the bar and fades only under it", () => {
  const chat = chatScreenSource();
  expect(chat).toContain(
    "const topFadeSolid = headerHeight > 0 ? Math.min(1, headerHeight / (headerHeight + 28)) : 0;",
  );
  expect(chat).toContain("colors={[c.bg, c.bg, withOpacity(c.bg, 0)]}");
  expect(chat).toContain("locations={[0, topFadeSolid, 1]}");
  const wall = src("features/chat/ChatWallpaper.tsx");
  expect(wall).toContain('const BAND_ALPHA = ["rgba(0,0,0,1)", "rgba(0,0,0,1)", "rgba(0,0,0,0)"];');
  expect(wall).toContain("positions={[0, from, 1]}");
});
