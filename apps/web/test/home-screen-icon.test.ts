import { expect, test } from "bun:test";
import { join } from "node:path";

test("the page gives iOS a short home-screen name, not its long <title>", async () => {
  const html = await Bun.file(join(import.meta.dir, "..", "index.html")).text();
  expect(html).toMatch(/<link\s+rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"\s*\/>/);
  expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-title"\s+content="agentes\.chat"\s*\/>/);
});
