import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * `PressScale`'s `style` is the button from the outside (its size, fill, corners); its children are laid out in an
 * inner view that takes `contentStyle`. Alignment, direction or gap put in `style` arranges that inner view, not what
 * is in it: an icon pinned to the left of its label, a glyph at the top of its circle. Every one of them goes in
 * `contentStyle`.
 */
const SRC = join(import.meta.dir, "../src");
const LAYOUT = ["alignItems", "justifyContent", "flexDirection", "gap"];
/** Kept on purpose: the same style draws the card without a press, where its gap spaces the content itself. */
const ALLOWED = new Set(["features/dashboards/WidgetView.tsx:card"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

/** Comments out, so an apostrophe in one never reads as a string. */
const uncommented = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/^(\s*)\/\/.*$/gm, "$1");

/** From `<PressScale` at `i`, the opening tag up to its `>` outside any braces or strings. */
function openingTag(s: string, i: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j] as string;
    if (quote) {
      if (ch === quote && s[j - 1] !== "\\") quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0 && s[j - 1] !== "=") return s.slice(i, j + 1);
  }
  return s.slice(i);
}

/** An attribute's `{…}` contents, braces balanced. */
function attribute(tag: string, name: string): string | null {
  const at = tag.search(new RegExp(`\\b${name}=\\{`));
  if (at < 0) return null;
  let k = tag.indexOf("{", at) + 1;
  const start = k;
  for (let depth = 1; k < tag.length && depth > 0; k++) {
    if (tag[k] === "{") depth++;
    else if (tag[k] === "}") depth--;
  }
  return tag.slice(start, k - 1);
}

/** A style sheet entry's body, by its name. */
function styleBody(s: string, name: string): string {
  const m = new RegExp(`^ {2,4}${name}: \\{`, "m").exec(s);
  if (!m) return "";
  let k = m.index + m[0].length;
  const start = k;
  for (let depth = 1; k < s.length && depth > 0; k++) {
    if (s[k] === "{") depth++;
    else if (s[k] === "}") depth--;
  }
  return s.slice(start, k - 1);
}

test("no PressScale lays its content out from `style`: alignment, direction and gap go in `contentStyle`", () => {
  const wrong: string[] = [];
  for (const path of files(SRC)) {
    const s = uncommented(readFileSync(path, "utf8"));
    if (!s.includes("<PressScale")) continue;
    const file = relative(SRC, path);
    for (const m of s.matchAll(/<PressScale\b/g)) {
      const style = attribute(openingTag(s, m.index ?? 0), "style");
      if (!style) continue;
      const bodies = [
        ...[...style.matchAll(/styles\.(\w+)/g)].map((x) => [x[1] as string, styleBody(s, x[1] as string)] as const),
        ...[...style.matchAll(/\{([^{}]*)\}/g)].map((x) => ["inline", x[1] as string] as const),
      ];
      for (const [name, body] of bodies) {
        const keys = LAYOUT.filter((k) => new RegExp(`\\b${k}\\s*:`).test(body));
        if (keys.length > 0 && !ALLOWED.has(`${file}:${name}`)) wrong.push(`${file} ${name}: ${keys.join(", ")}`);
      }
    }
  }
  expect(wrong).toEqual([]);
});
