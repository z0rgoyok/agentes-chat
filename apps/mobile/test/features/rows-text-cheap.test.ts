import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCKS_KEPT, blocksOf, parseBlocks } from "../../src/features/chat/logic";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("a text's pieces", () => {
  const spans = src("features/chat/MessageSpans.tsx");

  test("only a mention reads the directory, the reader's handle and the language", () => {
    const [spansAt, mentionAt] = [spans.indexOf("export function Spans("), spans.indexOf("function MentionText(")];
    expect(spansAt).toBeGreaterThan(-1);
    expect(mentionAt).toBeGreaterThan(spansAt);
    const plain = spans.slice(spansAt, mentionAt);
    for (const hook of ["useRowDirectory()", "useRowMyHandle()", "useTranslation()", "useTheme()"])
      expect({ hook, inEveryText: plain.includes(hook) }).toEqual({ hook, inEveryText: false });
    expect(plain).toContain("return <MentionText key={key} text={s.text} everyone={everyone} ink={ink} />;");
    const mention = spans.slice(mentionAt, spans.indexOf("type TableBlock"));
    // In a conversation, the directory and my handle are the ones its rows share (`row-data.tsx`).
    for (const hook of ["useRowDirectory()", "useRowMyHandle()", "useTranslation()", "useTheme()"])
      expect({ hook, inMention: mention.includes(hook) }).toEqual({ hook, inMention: true });
  });

  test("a text's blocks are kept for the texts read lately: the same text parses once", () => {
    const body = `Olá **mundo** ${Date.now()}\n\n- um\n- dois`;
    const first = blocksOf(body);
    expect(blocksOf(body)).toBe(first);
    expect(first).toEqual(parseBlocks(body));
    expect(src("features/chat/MessageText.tsx")).toContain("const blocks = useMemo(() => blocksOf(body), [body]);");
  });

  test("bounded: past the cap the text read longest ago is parsed again", () => {
    const oldest = blocksOf(`velho ${Date.now()}`);
    const again = `velho-de-novo ${Date.now()}`;
    const kept = blocksOf(again);
    for (let i = 0; i < BLOCKS_KEPT; i++) blocksOf(`texto ${i} ${Date.now()}`);
    expect(blocksOf(again)).not.toBe(kept);
    expect(oldest.length).toBe(1);
  });
});
