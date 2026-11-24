/**
 * The web app's weight before its first screen, against a budget: CI fails when a change makes the first load heavier
 * than it allows (a page's code pulled into the start, a big library imported where a lazy one was). Sizes are gzip,
 * as a browser downloads them. `bun scripts/bundle-budget.ts [dist]`; raise a number here only on purpose.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** KiB, gzip. */
export const BUDGET = {
  /** The entry and every chunk index.html preloads with it: what runs before anything shows. */
  startJs: 780,
  /** The stylesheets index.html loads. */
  startCss: 116,
  /** Any one script of the app, a page's or a library's (not the diagram frame's own files). */
  chunk: 225,
  /** One language's words (loaded with the app, the person's language only). */
  locale: 355,
} as const;

const kib = (bytes: number) => Math.round(bytes / 1024);
const gzip = (file: string) => Bun.gzipSync(readFileSync(file)).byteLength;

export function weigh(dist: string) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const scripts = [
    ...html.matchAll(/<(?:script[^>]+src|link[^>]+rel="modulepreload"[^>]+href)="\/(assets\/[^"]+\.js)"/g),
  ];
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/(assets\/[^"]+\.css)"/g)];
  const all = readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js"));
  const sizes = new Map(all.map((f) => [f, gzip(join(dist, "assets", f))]));
  const locale = /^(en|pt-BR|es|fr|de|it|nl|ja|ko|zh-Hans|id|tr|pl|ru)-[\w-]+\.js$/;
  const biggest = (filter: (f: string) => boolean) =>
    [...sizes].filter(([f]) => filter(f)).reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0] as [string, number]);
  return {
    startJs: kib(scripts.reduce((s, m) => s + (sizes.get((m[1] ?? "").slice(7)) ?? 0), 0)),
    startCss: kib(styles.reduce((s, m) => s + gzip(join(dist, m[1] ?? "")), 0)),
    // Mermaid's two files run only in the diagram's sandboxed frame (apps/web/src/lib/mermaid.ts).
    chunk: biggest((f) => !locale.test(f) && !/^mermaid(\.min|-frame)-/.test(f)),
    locale: biggest((f) => locale.test(f)),
  };
}

if (import.meta.main) {
  const w = weigh(process.argv[2] ?? "apps/web/dist");
  const rows: [string, number, number, string][] = [
    ["start JS", w.startJs, BUDGET.startJs, ""],
    ["start CSS", w.startCss, BUDGET.startCss, ""],
    ["biggest chunk", kib(w.chunk[1]), BUDGET.chunk, w.chunk[0]],
    ["biggest locale", kib(w.locale[1]), BUDGET.locale, w.locale[0]],
  ];
  let over = false;
  for (const [name, size, budget, file] of rows) {
    const bad = size > budget;
    over ||= bad;
    console.log(`${bad ? "OVER" : "ok  "} ${name}: ${size} KiB gzip (budget ${budget})${file ? ` ${file}` : ""}`);
  }
  if (over) {
    console.error("The web app's first load is over its budget (scripts/bundle-budget.ts).");
    process.exit(1);
  }
}
