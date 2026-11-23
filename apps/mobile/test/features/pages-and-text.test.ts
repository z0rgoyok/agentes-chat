import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileInfo, textChunks } from "../../src/features/files/logic";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("a page opens as a page: an HTML file or an agent's page, never its source", () => {
  const file = (name: string, contentType: string) =>
    fileInfo({ kind: "file", title: name, content: { kind: "file", name, contentType, size: 1 } } as never);
  expect(file("painel.html", "text/html").view).toBe("html");
  expect(file("painel.htm", "application/octet-stream").view).toBe("html");
  expect(file("notes.txt", "text/plain").view).toBe("text");
  expect(fileInfo({ kind: "html", title: "Painel", content: { kind: "html", html: "<p>x</p>" } } as never).view).toBe(
    "html",
  );
  const viewer = src("features/files/DocumentViewer.tsx");
  expect(viewer).toMatch(/info\.view === "html" \? \(\s*<HtmlPage detail=\{detail\} \/>/);
  // Apart from the app, as every page an agent writes: the blocks' isolated web view, the network cut off.
  expect(viewer).toContain("isolatedPage(html, PAGE_HEAD)");
  expect(viewer).toContain("{...ISOLATED_WEB_VIEW}");
  expect(src("features/blocks/LiveBlock.tsx")).toContain("{...ISOLATED_WEB_VIEW}");
  // A page that touches the storage it has none of here keeps drawing: stand-ins run before its own head.
  expect(viewer).toMatch(/const PAGE_HEAD = `<meta name="viewport"[^`]*\$\{STORAGE_STANDINS\}`;/);
  const blocks = src("features/blocks/logic.ts");
  for (const what of ['["localStorage","sessionStorage"]', 'Object.defineProperty(document,"cookie"'])
    expect(blocks).toContain(what);
});

test("a long text shows in pieces the phone can draw, nothing lost", () => {
  const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const pieces = textChunks(text);
  expect(pieces.length).toBeGreaterThan(5);
  expect(pieces.join("\n")).toBe(text);
  expect(textChunks("")).toEqual([""]);
  expect(textChunks("a\nb")).toEqual(["a\nb"]);
});

test("a line longer than a piece (minified, data on one line) is cut into pieces too, never inside one character", () => {
  const long = "x".repeat(20_000);
  const pieces = textChunks(`${long}\nend`);
  expect(pieces.every((p) => p.length <= 6000)).toBe(true);
  expect(pieces).toEqual(["x".repeat(6000), "x".repeat(6000), "x".repeat(6000), `${"x".repeat(2000)}\nend`]);
  // Cut inside a line only between pieces: what is drawn is the text, nothing lost.
  expect(pieces.join("").replace("\nend", "end")).toBe(`${long}end`);
  // An emoji where the cut falls stays whole, in the next piece.
  const emoji = textChunks(`${"a".repeat(5999)}😀bc`);
  expect(emoji).toEqual(["a".repeat(5999), "😀bc"]);
});
