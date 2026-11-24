import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { insertRef, refQuery } from "../../src/features/chat/mentions";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
/** The text from `from` up to `to` (or the end). */
const between = (text: string, from: string, to?: string) => {
  const at = text.indexOf(from);
  expect(at).toBeGreaterThanOrEqual(0);
  return text.slice(at, to ? text.indexOf(to, at + from.length) : undefined);
};

describe("typing in the composer", () => {
  const composer = src("ui/Composer.tsx");
  const box = between(composer, "export function Composer(", "const PlusButton = memo(");

  test("a key redraws the field once: the caret and the selection are kept, not drawn", () => {
    const selectionChange = between(box, "onSelectionChange={(e) => {", "multiline");
    // No state per caret move: only a change in what shows (the picker, words selected) or the field's own selection.
    expect(selectionChange).not.toMatch(/setCaret|setRange/);
    expect(selectionChange).toContain("caret.current = end;");
    expect(selectionChange).toContain("if (end > start !== selectingRef.current) {");
    expect(box).toContain("if (sameToken(next, tokenRef.current)) return;");
  });

  test("the send button and the + are pieces of their own, handed what stays the same between keys", () => {
    expect(composer).toContain("const SendButton = memo(function SendButton(");
    expect(composer).toContain("const PlusButton = memo(function PlusButton(");
    // Callbacks that never change: a send button drawn again set its gestures up on the native side each time.
    expect(box).toContain("const onButton = useLatest(press);");
    expect(box).toContain("const onHold = useLatest(holdSend);");
    expect(box).toMatch(
      /<SendButton[\s\S]*?onPress=\{onButton\}[\s\S]*?holdHint=\{holdHint\}[\s\S]*?onHold=\{onHold\}/,
    );
    // The hold is a hint (a string) or nothing, never an object made in each draw.
    expect(box).not.toMatch(/const hold = working && has/);
  });

  test("the picker and the formatting bar are made again only when what they show changes, outside the box", () => {
    expect(box).toContain("const floating = formatBar ?? picker;");
    expect(box).toMatch(/const picker = useMemo\([\s\S]*?\[shownToken, mention, pick\]/);
    // The formatting bar floats with the picker: words selected no longer push the field up under the finger.
    expect(between(box, "return (", "<View style={styles.row}>")).not.toContain("formatting ?");
  });

  test("the send button's 36 takes the field's 48 to the finger, held or tapped", () => {
    const button = between(composer, "const SendButton = memo(", "const body = systemText");
    expect(button.split("hitSlop: INSET,").length - 1).toBe(2);
    expect(button.split("hitSlop={INSET}").length - 1).toBe(2);
  });

  test("no line comes and goes under the field: the hold is taught once, in a toast", () => {
    expect(composer).not.toContain("styles.holdHint");
    expect(composer).not.toMatch(/holdHint: \{/);
    expect(box).toMatch(
      /if \(joins && !wasTaught\(\)\) \{\s*markTaught\(\);\s*toast\(\{ title: t\("mobile\.composer\.holdToStop"\), icon: "send" \}\);/,
    );
  });

  test("no suggestion pills in the composer, and no animations built while it draws", () => {
    expect(composer).not.toMatch(/\bsuggestions\b/);
    expect(composer).not.toContain("PILLS_ROOM");
    expect(composer).not.toMatch(/(entering|exiting)=\{[^}]*\.duration\(/);
    for (const picker of ["features/chat/MentionPicker.tsx", "features/chat/ChannelPicker.tsx"])
      expect({ picker, inRender: /(entering|exiting)=\{[^}]*\.duration\(/.test(src(picker)) }).toEqual({
        picker,
        inRender: false,
      });
  });

  test("sending empties the field with its caret at the start, and keeps the focus", () => {
    // As words set from code: with no selection set, iOS kept the height of the lines the sent words had.
    expect(box).toContain('const clear = () => put("", 0);');
    // And an empty field is one line high on iOS, whatever height the native side last measured for the words that
    // went (a long message left a field five lines tall).
    expect(box).toContain('const emptyCap = Platform.OS === "ios" ? { maxHeight: oneLineIos(fontScale) } : null;');
    expect(box).toContain("style={[inputText, styles.inputFill, { color: colors.ink }, text ? null : emptyCap]}");
    const put = between(box, "const put = (next: string", "const clear = ");
    expect(put).toContain("setText(next);");
    expect(put).toContain("setSelection({ start: at, end: at });");
    expect(put).not.toContain("blur");
  });
});

describe("the @ and # being typed", () => {
  test("found by the same rules in a long draft, looking only at the words before the caret", () => {
    const long = `${"palavra ".repeat(20_000)}oi @ad`;
    expect(refQuery(long, long.length)).toEqual({ start: long.length - 3, query: "ad" });
    const channel = `${"x".repeat(5_000)} veja #en`;
    expect(refQuery(channel, channel.length)).toEqual({ start: channel.length - 3, query: "en", sigil: "#" });
    // A word glued to text far back is no token, and the window's own start is never read as the text's start.
    const glued = `${"y".repeat(500)}@${"a".repeat(30)}`;
    expect(refQuery(glued, glued.length)).toBeNull();
    const far = `@${"b".repeat(200)}`;
    expect(refQuery(far, far.length)).toBeNull();
    // A pick at the far end puts the handle where the token was.
    const token = refQuery(long, long.length);
    expect(token && insertRef(long, token, "ada").text.endsWith("oi @ada ")).toBe(true);
  });

  test("short texts read as before", () => {
    expect(refQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(refQuery("oi @ad e", 6)).toEqual({ start: 3, query: "ad" });
    expect(refQuery("#eng", 4)).toEqual({ start: 0, query: "eng", sigil: "#" });
    expect(refQuery("a#b", 3)).toBeNull();
  });
});

test("the microphone takes a finger's 44 on iOS too: the view carries the gestures' slop", () => {
  const voice = src("features/voice/useVoiceComposer.tsx");
  const mic = between(voice, "const mic =", "const wave =");
  expect(mic).toContain("hitSlop={MIC_SLOP}");
});

test("the words leave the field and land in the conversation in the same draw", () => {
  // The cache tells its readers a frame later; the screen that sends draws again with the send itself.
  const queries = readFileSync(new URL("../../../../packages/client/src/api/queries.ts", import.meta.url), "utf8");
  const hook = between(queries, "export function usePostMessage(", "export interface PostMessageOptions");
  expect(hook).toContain("const [, drawn] = useReducer((n: number) => n + 1, 0);");
  expect(hook).toMatch(/onOptimistic: \(local\) => \{\s*drawn\(\);\s*onOptimistic\?\.\(local\);/);
  // The optimistic copy is in the cache before the sender draws again: `onOptimistic` runs after it is written.
  const mutate = between(queries, "onMutate: ({ body, clientId, threadId, meta }) => {", "onSuccess:");
  expect(mutate.indexOf("qc.setQueryData<Message[]>(key,")).toBeLessThan(
    mutate.indexOf("options.onOptimistic?.(local);"),
  );
});

test("send past the length limit answers the tap: the line above says why", () => {
  const composer = src("ui/Composer.tsx");
  expect(composer).toMatch(/if \(tooLong\) \{\s*haptics\.warning\(\);\s*return;\s*\}/);
});
