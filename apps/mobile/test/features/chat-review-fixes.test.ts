import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@agenteschat/client";
import { INLINE_HEIGHT } from "../../src/features/blocks/logic";
import { keptHeightAfter } from "../../src/features/chat/kept-sizes";
import {
  type Inline,
  pinnedAsListed,
  runInConversation,
  tableColumnWidths,
  tableResolvesLate,
} from "../../src/features/chat/logic";
import { chatScreenSource } from "./chat-screen-source";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("a sheet that never shows can't leave the conversation's sheet host open", () => {
  test("every step presents as it mounts, so the system waits out a sheet still leaving", () => {
    const host = src("features/shared/SheetHost.tsx");
    expect(host).toContain("presentOnMount: true });");
    expect(host).not.toContain("presentOnMount: !first");
    // The keyboard leaves when a new sheet starts, after the listeners (the conversation reads it still up).
    const start = host.slice(host.indexOf("const start = "), host.indexOf("return {\n      open: start,"));
    const fresh = start.slice(start.indexOf("} else {"));
    expect(fresh).toContain("Keyboard.dismiss();");
    expect(start.indexOf("for (const l of listeners.current) l(true);")).toBeLessThan(
      start.indexOf("Keyboard.dismiss();"),
    );
  });

  test("open turning false still dismisses a sheet presented on mount; a failed present ends as a dismissal", () => {
    const sheet = src("ui/Sheet.tsx");
    const props = sheet.slice(sheet.indexOf("export function useSheetProps("));
    expect(props).not.toContain("if (presentOnMount) return;");
    expect(props).not.toContain("void ref.current?.present();");
    expect(props).toMatch(
      /void ref\.current\?\.present\(\)\.catch\(\(\) => \{\s*shown\.current = false;\s*if \(openRef\.current\) closeRef\.current\(\);\s*goneRef\.current\?\.\(\);/,
    );
    // An auto-present that lands after the owner closed the sheet goes away again.
    expect(props).toMatch(/onDidPresent: \(\) => \{\s*if \(!openRef\.current\) void ref\.current\?\.dismiss\(\);/);
  });
});

describe("answering an agent that waits: 'pensando…' comes once, not twice", () => {
  test("the server's answer drops the guess only when a steered run has its own row here", () => {
    const chat = chatScreenSource();
    const sent = chat.slice(chat.indexOf("onSent: (message, local) => {"), chat.indexOf("onFailed: (error,"));
    expect(sent).toContain(
      "if (live.runs.some((r) => !r.provisional && steered.includes(r.runId))) live.forget(message.id, false);",
    );
    expect(sent).not.toContain("steeredRunIds.length > 0");
  });
});

describe("a reply that fit is never judged again over the keyboard", () => {
  test("the keyboard coming up, and going to the end, drop the reply waiting to be read from the top", () => {
    const chat = chatScreenSource();
    expect(chat).toMatch(
      /KeyboardEvents\.addListener\("keyboardWillShow", \(\) => \{\s*toReadRef\.current = null;\s*\}\);/,
    );
    const toEnd = chat.slice(chat.indexOf("const toEnd = useCallback(() => {"));
    expect(toEnd.slice(0, toEnd.indexOf("}, [letGo]);"))).toContain("toReadRef.current = null;");
  });
});

describe("a table's columns never go back to the letters' guess, and follow cells that load later", () => {
  const cell = (text: string, kind: "text" | "bold" = "text"): Inline[] => [{ kind, text }];
  test("a table holding a pill, a channel or a mention keeps measuring; words alone measure once", () => {
    const header = [cell("Arquivo"), cell("Status")];
    expect(tableResolvesLate(header, [[cell("Relatório"), cell("ok", "bold")]])).toBe(false);
    const file: Inline[] = [{ kind: "link", text: "x", href: "https://example.test/f/1" }];
    expect(tableResolvesLate(header, [[file, cell("ok")]])).toBe(true);
    const id: Inline[] = [{ kind: "id", text: "0193", id: "0193" }];
    expect(tableResolvesLate(header, [[cell("a"), id]])).toBe(true);
    const channel: Inline[] = [{ kind: "channel", text: "#geral", name: "geral" }];
    expect(tableResolvesLate([channel, cell("b")], [])).toBe(true);
    expect(tableResolvesLate(header, [[[{ kind: "mention", text: "@ada" }], cell("c")]])).toBe(true);
  });

  test("new cells draw at the widths measured last, not at the guess", () => {
    const header = [cell("Valor")];
    const rows = [[cell("R$ 1.234.567.890,00")]];
    // The guess by letters is far from the 120 measured last, which is what new cells draw at until measured.
    expect(tableColumnWidths(header, rows, {})[0]).not.toBe(121);
    expect(tableColumnWidths(header, rows, { 0: 120 })[0]).toBe(121);
    const spans = src("features/chat/MessageSpans.tsx");
    expect(spans).toContain(
      "const widths = tableColumnWidths(header, rows, { ...measured.before, ...drawn }, fontScale);",
    );
    // The copy's own measures keep what was measured before (`...m`), and a copy per content says every column.
    expect(spans).toContain(
      "m.key !== columnsKey || m.columns[col] === w ? m : { ...m, columns: { ...m.columns, [col]: w } },",
    );
    expect(spans).toMatch(/\{unmeasured \|\| late \? \(\s*<View\s*key=\{columnsKey\}/);
  });
});

describe("words set from the composer leave nothing selected", () => {
  const composer = src("ui/Composer.tsx");
  const between = (from: string, to: string) => composer.slice(composer.indexOf(from), composer.indexOf(to));
  test("sending (and a pick) forget the selection: no formatting bar over the emptied field", () => {
    expect(composer).toMatch(
      /const unselect = \(\) => \{\s*if \(!selectingRef\.current\) return;\s*selectingRef\.current = false;\s*setSelecting\(false\);/,
    );
    expect(composer).toContain('const clear = () => put("", 0);');
    expect(between("const put = (next: string", "const clear = ")).toContain("unselect();");
  });

  test("words handed back (a draft to fix, a take that didn't go) move the caret and the '@' token with them", () => {
    const prefill = between("const handed = prefill.text;", "useEffect(() => {\n    if (focusAt)");
    expect(prefill).toContain("put(next);");
    expect(prefill).not.toContain("setText(next);");
    expect(composer).toContain("if (!sent && value) put(joinDrafts(value, textRef.current));");
  });
});

describe("a live block that gets shorter while cut takes its real height", () => {
  test("a reading under the cut can't be a clamped one: it lowers the height, and the cut goes", () => {
    // Details opened: 520 whole, cut at the card's height. Closed again, the parts read 300 under the cut.
    expect(keptHeightAfter(520, 300, true, INLINE_HEIGHT)).toBe(300);
    // A long text clamped by the cut reads the whole room: still the rule that only raises.
    expect(keptHeightAfter(520, INLINE_HEIGHT, true, INLINE_HEIGHT)).toBeNull();
    expect(keptHeightAfter(520, 600, true, INLINE_HEIGHT)).toBe(600);
    // Without a cap (a message's words) nothing changes.
    expect(keptHeightAfter(520, 300, true)).toBeNull();
  });

  test("no loop: once under the cut, the uncut reading is the same height", () => {
    let kept = 520;
    for (let i = 0; i < 4; i++) {
      const cut = kept > INLINE_HEIGHT;
      kept = keptHeightAfter(kept, 300, cut, INLINE_HEIGHT) ?? kept;
    }
    expect(kept).toBe(300);
  });

  test("its kept height is its own version's (and width's and text size's)", () => {
    const spec = src("features/blocks/SpecBlock.tsx");
    expect(spec).toContain("if (sized.key !== sizeKey) setSized({ key: sizeKey, height: keptSize(sizeKey) ?? 0 });");
    expect(spec).toContain("setSized((now) => (now.key === sizeKey ? { key: sizeKey, height: next } : now));");
  });
});

describe("the instant 'pensando…' is skipped only for a run that will take the message", () => {
  test("a run in the same conversation, as the server steers", () => {
    const timeline = { threadId: null as unknown as string, triggerMessageId: "root" };
    const mission = { threadId: "mission", triggerMessageId: "m9" };
    // Writing in the timeline: the timeline's run takes it, a mission thread's run doesn't.
    expect(runInConversation(timeline, null)).toBe(true);
    expect(runInConversation(mission, null)).toBe(false);
    // Writing in the mission's thread: its run takes it, the timeline's doesn't (unless it answers that root).
    expect(runInConversation(mission, "mission")).toBe(true);
    expect(runInConversation(timeline, "mission")).toBe(false);
    expect(runInConversation(timeline, "root")).toBe(true);
  });

  test("a run waiting for an approval never takes a new message", () => {
    const chat = chatScreenSource();
    expect(chat).toContain('const AT_WORK: ReadonlySet<string> = new Set(["thinking", "queued", "running"]);');
    expect(chat).toMatch(/AT_WORK\.has\(r\.status\) &&\s*runInConversation\(r, local\.threadId \?\? null\)/);
  });
});

describe("files sent while others go up stay under them", () => {
  test("a second batch waits behind the first as words do, and leaves the queue when its turn comes", () => {
    const chat = chatScreenSource();
    const files = chat.slice(chat.indexOf("const sendWithFiles = ("), chat.indexOf("const deliverFiles = async ("));
    expect(files).toMatch(
      /if \(filesAhead\.current\) waitingBehind\.current\.push\(clientId\);\s*behindFiles\(\(\) => \{\s*waitingBehind\.current = waitingBehind\.current\.filter\(\(id\) => id !== clientId\);\s*return deliverFiles\(local, how\);/,
    );
  });
});

describe("a message from an older page follows its pin", () => {
  const m = (id: string, pinned?: boolean) => ({ id, ...(pinned ? { pinned } : {}) }) as Message;
  test("pinned or unpinned in the pins list, the older row says so; the rest stay the same objects", () => {
    const older = [m("a"), m("b", true), m("c")];
    const next = pinnedAsListed(older, [{ messageId: "a" }]);
    expect(next.map((x) => Boolean(x.pinned))).toEqual([true, false, false]);
    expect(next[2]).toBe(older[2]);
    // Nothing to change, or the list not loaded: the very same list.
    expect(pinnedAsListed(older, [{ messageId: "b" }])).toBe(older);
    expect(pinnedAsListed(older, undefined)).toBe(older);
  });

  test("the screen builds its list from the older pages as pinned", () => {
    const chat = chatScreenSource();
    expect(chat).toContain("const olderPinned = useMemo(() => pinnedAsListed(older, pinsData), [older, pinsData]);");
    expect(chat).toContain("return mergeTimeline(gap ? olderPinned : [...olderPinned, ...(top.data ?? [])], []);");
    expect(chat.indexOf("const pinsData = usePins(orgId, channelId, member).data;")).toBeLessThan(
      chat.indexOf("const olderPinned = "),
    );
  });
});

describe("back on the conversation, the list follows the keyboard at once", () => {
  test("a popped screen releases the freeze at once when no keyboard is about; sheets keep the delay", () => {
    const chat = chatScreenSource();
    expect(chat).toMatch(
      /if \(now && !KeyboardController\.isVisible\(\)\) \{\s*freeze\.value = false;\s*return;\s*\}\s*setTimeout\(/,
    );
    expect(chat).toMatch(/left\.current = false;\s*holdPlace\(away\.current\);\s*uncover\(true\);/);
    // A sheet closing (announced before it has slid away) still waits.
    expect(chat).toMatch(/return;\s*\}\s*uncover\(\);\s*\/\/ Unless the app moved the list/);
  });
});

describe("a card a run posts on the way never keeps the run's work", () => {
  test("only the reply keeps the turn; the card test is the one that makes a card row", () => {
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain(
      "const postedCard = Boolean(meta?.actionCard || approvalId || question || secret || handoff);",
    );
    expect(row).toMatch(
      /ownWork && m\.agentRunId && !postedCard \? keptTurn\(m\.id, m\.agentRunId, Date\.now\(\)\) : null/,
    );
    expect(row).toContain("const cardRow = !body && !media && postedCard;");
    expect(row.indexOf("const postedCard = ")).toBeLessThan(row.indexOf("const [kept] = useState("));
  });
});
