import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { highlightedCode } from "@/components/CodeBlock";
import { PARSED_CHARS, parsedMarkdown } from "@/lib/markdown";

test("a text drawn again is parsed and highlighted once: the same blocks come back", () => {
  const text = "# Plano\n\n- um\n- dois\n\n```ts\nconst a = 1;\n```";
  expect(parsedMarkdown(text, true)).toBe(parsedMarkdown(text, true));
  // A message's line breaks and a document's are different readings.
  expect(parsedMarkdown(text, false)).not.toBe(parsedMarkdown(text, true));
  expect(highlightedCode("const a = 1;", "ts")).toBe(highlightedCode("const a = 1;", "ts"));
  expect(highlightedCode("const a = 1;", "ts")).not.toBe(highlightedCode("const a = 1;", "js"));
});

test("a page edited key by key in a preview doesn't keep every version: the cache holds characters, not texts", () => {
  const note = "uma nota curta";
  const first = parsedMarkdown(note, true);
  // An editor's preview: the whole page parsed again at each key, more than the cache holds in all.
  const page = "uma linha da página\n".repeat(Math.ceil(PARSED_CHARS / 3 / 20));
  for (const key of ["a", "b", "c", "d"]) parsedMarkdown(page + key, false);
  expect(parsedMarkdown(note, true)).not.toBe(first);
});
