import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressDist } from "../scripts/compress-dist";

test("each script and stylesheet of the build gets its Brotli and gzip copies; pages and tiny files stay plain", () => {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  mkdirSync(join(dist, "assets"));
  const script = "export const words = 'agentes'; ".repeat(200);
  writeFileSync(join(dist, "assets", "main-a.js"), script);
  writeFileSync(join(dist, "assets", "main-b.css"), ".a{color:red}".repeat(200));
  writeFileSync(join(dist, "assets", "tiny-c.js"), "export {};");
  writeFileSync(join(dist, "index.html"), `<!doctype html>${"<div></div>".repeat(200)}`);
  expect(compressDist(dist)).toBe(2);
  expect(brotliDecompressSync(readFileSync(join(dist, "assets", "main-a.js.br"))).toString()).toBe(script);
  expect(gunzipSync(readFileSync(join(dist, "assets", "main-a.js.gz"))).toString()).toBe(script);
  expect(existsSync(join(dist, "assets", "main-b.css.br"))).toBe(true);
  expect(existsSync(join(dist, "assets", "tiny-c.js.br"))).toBe(false);
  expect(existsSync(join(dist, "index.html.br"))).toBe(false);
});
