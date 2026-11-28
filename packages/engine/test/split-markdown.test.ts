import { expect, test } from "bun:test";
import { splitMarkdown } from "../src/format";

test("text within the limit comes back whole", () => {
  expect(splitMarkdown("a\n\n\nb", 10)).toEqual(["a\n\n\nb"]);
});

test("cut between paragraphs, a code block that fits never cut", () => {
  const text = `${"a".repeat(30)}\n\n\`\`\`js\nx = 1\n\nshould stay\n\`\`\`\n\n${"b".repeat(30)}`;
  expect(splitMarkdown(text, 40)).toEqual(["a".repeat(30), "```js\nx = 1\n\nshould stay\n```", "b".repeat(30)]);
});

test("a code block longer than a part: cut between its lines, closed and opened again as it was", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
  const parts = splitMarkdown(`~~~~python\n${lines.join("\n")}\n~~~~`, 40);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(40);
    expect(part.startsWith("~~~~python\n")).toBe(true);
    expect(part.endsWith("\n~~~~")).toBe(true);
  }
  expect(parts.flatMap((p) => p.split("\n").slice(1, -1))).toEqual(lines);
});

test("a fence nobody closed is closed in each part", () => {
  const parts = splitMarkdown(`\`\`\`\n${"x\n".repeat(30)}`, 20);
  for (const part of parts) expect(part.endsWith("\n```")).toBe(true);
});

test("a line longer than a part: cut at a space, else anywhere but inside an emoji", () => {
  expect(splitMarkdown("one two three four", 10)).toEqual(["one two", "three four"]);
  const emoji = splitMarkdown(`${"x".repeat(9)}😀${"y".repeat(5)}`, 10);
  expect(emoji).toEqual(["x".repeat(9), `😀${"y".repeat(5)}`]);
});

test("a fence in a nested list item and inline code at a line's start", () => {
  const nested = `- one\n  - two\n\n      \`\`\`sh\n      a\n\n      b\n      \`\`\``;
  expect(splitMarkdown(`${"x".repeat(30)}\n\n${nested}`, 40)).toEqual([
    "x".repeat(30),
    "- one\n  - two",
    nested.slice(15),
  ]);
  expect(splitMarkdown(`\`\`\`a\`\`\` b\n\n${"c".repeat(20)}`, 20)).toEqual(["```a``` b", "c".repeat(20)]);
});
