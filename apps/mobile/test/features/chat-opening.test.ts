import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_AHEAD_SCREENS } from "@agenteschat/client";
import { whenIdle } from "../../src/features/chat/screen/reach";
import { chatScreenPiece, chatScreenSource } from "./chat-screen-source";

const chatFile = readFileSync(join(import.meta.dir, "../../src/features/chat/ChatScreen.tsx"), "utf8");

describe("a conversation opening", () => {
  test("it settles when its push ends, at once with no slide (a peek, a conversation swapped in place), 900 ms at most", () => {
    const opening = chatScreenPiece("opening.ts");
    expect(opening).toContain('navigation?.addListener("transitionEnd", end)');
    expect(opening).toContain("const SETTLE_MAX_MS = 900;");
    expect(opening).toContain("useState(() => now || (navigation !== undefined && landed.has(navigation)))");
    // Once settled it stays: a peek that ends keeps what mounted.
    expect(opening).toContain("return settled || now;");
    expect(chatFile).toContain("const settled = useSettled(peeking);");
  });

  test("what its first frame doesn't show waits for it: the read mark, the channel's greeting, the peeking face", () => {
    const chat = chatScreenSource();
    expect(chat).toMatch(/\{settled \? \(\s*<ReadMark/);
    expect(chat).toContain("{channel && !dm && !isThread && member && showList && settled ? (");
    expect(chat).toContain("{peekAgentId && showList && settled ? <ChatPeek");
    expect(chat).toContain("const pull = usePullPastEnd(listScroll, peekAgentId !== null && settled);");
  });

  test("nothing that sizes the rows, the list, the header or the dock waits for it", () => {
    const chat = chatScreenSource();
    for (const piece of [
      "ConversationList",
      "ChatList",
      "ChatDock",
      "ChatHeader",
      "ChatComposer",
      "Connection",
      "NoAiBanner",
      "UnavailableLines",
      "LineAskBar",
      "WaitingHereBar",
      "AskProbes",
      "PinnedLines",
      "MissionCardView",
    ])
      expect({ piece, held: new RegExp(`settled \\? \\(?\\s*<${piece}\\b`).test(chat) }).toEqual({
        piece,
        held: false,
      });
    // The reveal is as it was: it never waits for the push.
    const place = chatScreenPiece("ChatList.tsx");
    const reveal = place.slice(
      place.indexOf("const revealList = useCallback("),
      place.indexOf("const readFrom = useRef"),
    );
    expect(reveal).not.toContain("settled");
  });

  test("an idle step runs once after its gap, and never once cancelled", async () => {
    let runs = 0;
    await new Promise<void>((done) =>
      whenIdle(() => {
        runs++;
        done();
      }),
    );
    expect(runs).toBe(1);
    let late = false;
    const cancel = whenIdle(() => {
      late = true;
    });
    cancel();
    await Bun.sleep(120);
    expect(late).toBe(false);
  });
});

describe("the conversation's pieces", () => {
  test("the routes still open `ChatScreen` from its file, with the same props", () => {
    expect(chatFile).toMatch(
      /export function ChatScreen\(\{\s*channelId,\s*threadId,\s*handoffId,\s*focusId,\s*\}: \{\s*channelId: string;\s*threadId\?: string \| null;\s*handoffId\?: string \| null;/,
    );
  });

  test("the list's ref, its placement and the place keeping run on the conversation itself, in their order", () => {
    // The list's ref and its inset report, its `onReady`, the sheets' subscription and the focus effect are effects of
    // one component: split apart, their order against each other would change.
    const keep = chatFile.indexOf("useKeepPlace({ sheet, follow })");
    const attach = chatFile.indexOf("const attachList = useCallback(");
    const placement = chatFile.indexOf("useListPlacement({");
    expect(keep).toBeGreaterThan(0);
    expect(attach).toBeGreaterThan(keep);
    expect(placement).toBeGreaterThan(attach);
    expect(chatFile).toContain("list?.reportContentInset({ bottom: listEnd.get() });");
    const keeping = chatScreenPiece("useKeepPlace.ts");
    expect(keeping.indexOf("return sheet.subscribe((open) => {")).toBeLessThan(keeping.indexOf("useFocusEffect("));
    expect(chatScreenPiece("ChatList.tsx")).toContain("const onListReady = useCallback(() => {");
  });

  test("what only the bar shows redraws the bar alone", () => {
    const header = chatScreenPiece("ChatHeader.tsx");
    expect(header).toContain("const [computerWords, setComputerWords] = useState<string | null>(null);");
    expect(header).toContain("const [leadWidth, setLeadWidth] = useState(0);");
    expect(header).toContain("useAgentsQueue(queueAgents)");
    expect(header).toContain("useDmAgentTasks(member && !isThread ? dmAgentId : null)");
    expect(chatFile).not.toContain("setComputerWords");
    expect(chatFile).not.toContain("useAgentsQueue");
  });

  test("older and newer pages load three screens before the list's edge, as on the web, so a quick scroll never waits there", () => {
    const list = chatScreenPiece("ChatList.tsx");
    expect(PAGE_AHEAD_SCREENS).toBe(3);
    expect(list).toContain("onStartReachedThreshold={PAGE_AHEAD_SCREENS}");
    expect(list).toContain("onEndReachedThreshold={PAGE_AHEAD_SCREENS}");
  });

  test("the list's reach, growing, redraws the list alone", () => {
    const list = chatScreenPiece("ChatList.tsx");
    expect(list).toContain("const [reachStep, setReachStep] = useState(0);");
    expect(chatFile).not.toContain("reachStep");
  });
});
