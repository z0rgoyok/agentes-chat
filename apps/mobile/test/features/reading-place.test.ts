import { describe, expect, test } from "bun:test";
import {
  HAND_MS,
  handPlace,
  placeKey,
  placeMessage,
  readingPlace,
  takeHandedPlace,
} from "../../src/features/chat/reading-place";
import { chatScreenPiece, chatScreenSource } from "./chat-screen-source";

/*
 * Opening or closing an iPhone Duo moves the conversation between the split's pane and a pushed screen (ADR 0212):
 * the message being read goes with it, and only then; every other opening keeps its own rules.
 */

const rows = [
  { kind: "day", key: "day:1" },
  { kind: "message", key: "m:a", message: { id: "a" } },
  { kind: "marker", key: "marker:1" },
  { kind: "message", key: "m:local", message: { id: "local-1", local: "pending" } },
  { kind: "message", key: "m:b", message: { id: "b" } },
];

describe("the place a conversation is read at", () => {
  test("the message at the top of the view, the first one under a day's line or a marker; null at the end", () => {
    expect(placeMessage({ end: false, key: "m:a" }, rows)).toBe("a");
    expect(placeMessage({ end: false, key: "day:1" }, rows)).toBe("a");
    // A message still sending has no id the server knows: the next one stands for the place.
    expect(placeMessage({ end: false, key: "marker:1" }, rows)).toBe("b");
    expect(placeMessage({ end: true }, rows)).toBeNull();
    expect(placeMessage({ end: false, key: null }, rows)).toBeNull();
    expect(placeMessage({ end: false, key: "gone" }, rows)).toBeNull();
    expect(placeMessage(null, rows)).toBeNull();
  });

  test("a place handed over is taken once, by the next screen of that conversation, while it is fresh", () => {
    const key = placeKey("c-place", null);
    expect(key).toBe("c-place:");
    expect(placeKey("c-place", "t1")).toBe("c-place:t1");
    handPlace(key, "m1", 1000);
    // Another conversation's screen leaves it where it is.
    expect(takeHandedPlace(placeKey("c-other", null), 1000)).toBeNull();
    expect(takeHandedPlace(key, 1000 + HAND_MS)).toBe("m1");
    expect(takeHandedPlace(key, 1000 + HAND_MS)).toBeNull();
    // One left too long is dropped.
    handPlace(key, "m2", 1000);
    expect(takeHandedPlace(key, 1001 + HAND_MS)).toBeNull();
    // At the end there is nothing to hand: it opens there anyway.
    handPlace(key, "m3", 1000);
    handPlace(key, null, 1000);
    expect(takeHandedPlace(key, 1000)).toBeNull();
  });

  test("with no screen of that conversation mounted, no place to read", () => {
    expect(readingPlace(placeKey("c-none", null), 0)).toBeNull();
  });
});

describe("the conversation screen hands its place over (ADR 0212)", () => {
  test("it opens where the other display left it when no message was asked for, as a pin opens, without the light", () => {
    const chat = chatScreenSource();
    expect(chat).toContain(
      "const [handed] = useState(() => (focusId ? null : takeHandedPlace(placeKey(channelId, threadId ?? null))));",
    );
    expect(chat).toContain("focusId={focusId ?? handed}");
    expect(chat).toContain("quietFocus={!focusId && handed !== null}");
    const actions = chatScreenPiece("useConversationActions.tsx");
    expect(actions).toContain("const quietSeek = useRef(quietFocus ? focusId : null);");
    // At once, at the top of the view as it was read, and never lit; given up without a word when it can't be reached.
    expect(actions).toMatch(
      /if \(quietSeek\.current === seek\) \{\s*quietSeek\.current = null;\s*void listRef\.current\?\.scrollToIndex\(\{ index, animated: false, \.\.\.aimAt\(index, 0, "start"\) \}\);\s*return;/,
    );
    expect(actions).toMatch(
      /setSeek\(null\);\s*if \(quietSeek\.current === seek\) \{\s*quietSeek\.current = null;\s*return;\s*\}/,
    );
  });

  test("each screen of a conversation says where it is read; a pane keeps it a moment as it leaves", () => {
    const chat = chatScreenSource();
    expect(chat).toContain(
      "useReadingPlace(placeKey(channelId, threadId), () => placeMessage(placeNow(), rowsRef.current), pane !== null);",
    );
    expect(chatScreenPiece("useKeepPlace.ts")).toMatch(
      /return \{\s*freeze,\s*leavePlace,[^}]*placeNow,\s*stickers,\s*\};/,
    );
  });
});
