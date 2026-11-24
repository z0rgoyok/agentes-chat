import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { weigh } from "./bundle-budget";

test("the first load counts the entry, what index.html preloads and its stylesheets; the rest by its biggest file", () => {
  const dist = mkdtempSync(join(tmpdir(), "budget-"));
  mkdirSync(join(dist, "assets"));
  // Random bytes don't shrink: their gzip size is about their own.
  const file = (name: string, kib: number) =>
    writeFileSync(join(dist, "assets", name), crypto.getRandomValues(new Uint8Array(kib * 1024)));
  file("main-a.js", 30);
  file("queries-b.js", 20);
  file("SettingsPage-c.js", 50);
  file("mermaid.min-d.js", 90);
  file("pt-BR-e.js", 40);
  writeFileSync(join(dist, "assets", "main-f.css"), crypto.getRandomValues(new Uint8Array(10 * 1024)));
  writeFileSync(
    join(dist, "index.html"),
    `<script type="module" crossorigin src="/assets/main-a.js"></script>
     <link rel="modulepreload" crossorigin href="/assets/queries-b.js">
     <link rel="stylesheet" crossorigin href="/assets/main-f.css">`,
  );
  const w = weigh(dist);
  expect(w.startJs).toBe(50);
  expect(w.startCss).toBe(10);
  expect(w.chunk[0]).toBe("SettingsPage-c.js");
  expect(w.locale[0]).toBe("pt-BR-e.js");
});
