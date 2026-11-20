import { afterAll, expect, test } from "bun:test";
import { enableSvgRasterizer, rasterPicture, sanitizeSvg, setSvgRasterizer } from "../src/live";

/** SVG pictures become PNGs for exports and models once resvg is on (ADR 0196 §8). */
afterAll(() => setSvgRasterizer(null));

test("a sanitized SVG draws as a PNG with the brand fonts", async () => {
  expect(await enableSvgRasterizer()).toBe(true);
  const svg = sanitizeSvg(
    new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="40" rx="6" fill="#222"/><text x="8" y="58" font-size="12">PC</text></svg>',
    ),
  );
  const png = await rasterPicture({ bytes: svg.bytes, contentType: "image/svg+xml" });
  expect(png?.contentType).toBe("image/png");
  expect([...(png?.bytes.slice(0, 4) ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});
