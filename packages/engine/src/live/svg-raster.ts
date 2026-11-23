import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { brandFontFiles } from "../pdf";
import { setSvgRasterizer } from "./svg";

/**
 * Turns on drawing SVG pictures as PNGs (ADR 0196 §8) with resvg's WebAssembly build and the brand fonts, for what
 * can't show an SVG: exports, a model looking at a picture, references sent to an image AI. False when it can't load:
 * those then leave SVG pictures out, as without it. The SVG is already sanitized and bounded when it gets here.
 */
export async function enableSvgRasterizer(): Promise<boolean> {
  try {
    const resvg = await import("@resvg/resvg-wasm");
    const require = createRequire(import.meta.url);
    await resvg.initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
    const fontBuffers = brandFontFiles();
    setSvgRasterizer(async (svg) => {
      const drawing = new resvg.Resvg(new TextDecoder().decode(svg), {
        font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Onest" },
      });
      try {
        return drawing.render().asPng();
      } finally {
        drawing.free();
      }
    });
    return true;
  } catch {
    return false;
  }
}
