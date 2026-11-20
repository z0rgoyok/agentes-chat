import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  armedAfter,
  keyboardAtRest,
  nextPull,
  PEEK_AT,
  PEEK_REARM,
  PEEK_RISE,
  PEEK_SIZE,
  pastEnd,
  peekAgentOf,
  peekPose,
} from "../../src/features/chat/peek";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
/** The text from `from` up to `to` (or the end). */
const between = (text: string, from: string, to?: string) => {
  const at = text.indexOf(from);
  expect(at).toBeGreaterThanOrEqual(0);
  return text.slice(at, to ? text.indexOf(to, at + from.length) : undefined);
};

describe("how far the conversation is pulled past its end", () => {
  // A conversation taller than the list: 2000 of content in an 800 list over a 120 dock, so it ends at 1320.
  test("0 anywhere above the end, and at the end itself", () => {
    expect(pastEnd(0, 2000, 800, 0, 120)).toBe(0);
    expect(pastEnd(1000, 2000, 800, 0, 120)).toBe(0);
    expect(pastEnd(1320, 2000, 800, 0, 120)).toBe(0);
  });

  test("the points the bounce shows under the last message", () => {
    expect(pastEnd(1376, 2000, 800, 0, 120)).toBe(56);
  });

  test("the keyboard's room is part of the end: the same offset with the keyboard up is not past it", () => {
    // 336 of keyboard over the dock: the end moves down by as much.
    expect(pastEnd(1376, 2000, 800, 0, 120 + 336)).toBe(0);
    expect(pastEnd(1656 + 20, 2000, 800, 0, 120 + 336)).toBe(20);
  });

  test("a conversation shorter than the list ends at its top: any pull up is past it", () => {
    expect(pastEnd(0, 300, 800, 0, 120)).toBe(0);
    expect(pastEnd(30, 300, 800, 0, 120)).toBe(30);
  });
});

describe("what the face follows", () => {
  test("the pull itself while the finger is on the list", () => {
    expect(nextPull(0, 30, true, true)).toBe(30);
    expect(nextPull(30, 70, true, true)).toBe(70);
    expect(nextPull(70, 20, true, true)).toBe(20);
  });

  test("let go, only less of it: the bounce takes it down, a fling bouncing at the end never raises it", () => {
    expect(nextPull(70, 50, false, true)).toBe(50);
    expect(nextPull(50, 0, false, true)).toBe(0);
    expect(nextPull(0, 40, false, true)).toBe(0);
  });

  test("nothing while the keyboard moves with the finger", () => {
    expect(nextPull(30, 60, true, false)).toBe(0);
    expect(keyboardAtRest(0)).toBe(true);
    expect(keyboardAtRest(1)).toBe(true);
    expect(keyboardAtRest(0.5)).toBe(false);
    expect(keyboardAtRest(0.97)).toBe(false);
  });
});

describe("the tap", () => {
  test("once as the pull reaches the line, ready again only back under the lower mark", () => {
    expect(PEEK_AT).toBe(56);
    expect(PEEK_REARM).toBeLessThan(PEEK_AT);
    let armed = false;
    let taps = 0;
    for (const pull of [0, 20, 55, 56, 70, 50, 57, 41, 40, 39, 60, 0]) {
      const next = armedAfter(armed, pull);
      if (next && !armed) taps++;
      armed = next;
    }
    // 56 taps; the wobble down to 40 and up to 70 doesn't; 39 makes it ready again and 60 taps once more.
    expect(taps).toBe(2);
  });
});

describe("where the face stands", () => {
  test("out of sight under the dock's edge at rest, all the way up as the tap comes, and no further", () => {
    expect(peekPose(0, false)).toEqual({ y: PEEK_SIZE, opacity: 0 });
    expect(peekPose(PEEK_AT / 2, false)).toEqual({ y: PEEK_SIZE - PEEK_RISE / 2, opacity: 1 });
    expect(peekPose(PEEK_AT, false)).toEqual({ y: PEEK_SIZE - PEEK_RISE, opacity: 1 });
    expect(peekPose(PEEK_AT * 3, false)).toEqual({ y: PEEK_SIZE - PEEK_RISE, opacity: 1 });
    expect(PEEK_RISE).toBeLessThan(PEEK_SIZE);
  });

  test("it rises slower than the room the pull opens under the last message: it never reaches a message", () => {
    for (const pull of [1, 10, 30, 56, 120]) expect(PEEK_SIZE - peekPose(pull, false).y).toBeLessThanOrEqual(pull);
  });

  test("reduced motion: it never moves, it only fades in where it arrives", () => {
    expect(peekPose(0, true)).toEqual({ y: PEEK_SIZE - PEEK_RISE, opacity: 0 });
    expect(peekPose(PEEK_AT / 2, true)).toEqual({ y: PEEK_SIZE - PEEK_RISE, opacity: 0.5 });
    expect(peekPose(PEEK_AT * 2, true)).toEqual({ y: PEEK_SIZE - PEEK_RISE, opacity: 1 });
  });
});

describe("who peeks", () => {
  const said = (type: string, id: string | null) => ({ author: { type, id } });
  test("a DM's agent, even before it said anything", () => {
    expect(peekAgentOf("a1", [])).toBe("a1");
    expect(peekAgentOf("a1", [said("agent", "a2")])).toBe("a1");
  });
  test("elsewhere the agent who spoke last; nobody where only people talk", () => {
    expect(peekAgentOf(null, [said("agent", "a1"), said("agent", "a2"), said("person", "p1")])).toBe("a2");
    expect(peekAgentOf(null, [said("person", "p1"), said("person", "p2")])).toBeNull();
    expect(peekAgentOf(null, [])).toBeNull();
  });
});

describe("the peek's wiring", () => {
  const peek = src("features/chat/ChatPeek.tsx");
  const chat = chatScreenSource();
  const math = src("features/chat/peek.ts");

  test("the pull is read on the UI thread from the list's own scroll events, never in React state", () => {
    const hook = between(peek, "export function usePullPastEnd(", "export const ChatPeek = memo(function ChatPeek({");
    expect(peek).toContain('const PULL_EVENTS = ["onScroll", "onScrollBeginDrag", "onScrollEndDrag"];');
    expect(hook).toContain("const handler = useEvent<NativeSyntheticEvent<NativeScrollEvent>>((e) => {");
    expect(hook).toContain("e.contentInset.bottom,");
    expect(hook).toContain("events.registerForEvents(tag);");
    expect(hook).toContain("return () => events.unregisterFromEvents(tag);");
    expect(hook).not.toContain("useState");
    expect(hook).not.toContain("scheduleOnRN");
    // Every number function is a worklet.
    expect(math.match(/"worklet";/g)?.length).toBe(5);
  });

  test("the list lends its scroll view through the keyboard list's ref; its insets and follow stay as they were", () => {
    const list = between(chat, "<ConversationList", "/>");
    expect(list).toContain("refScrollView={listScroll}");
    expect(list).toContain("contentInsetEndAdjustment={listEnd}");
    expect(list).toContain('keyboardLiftBehavior="whenAtEnd"');
    expect(list).toContain("maintainScrollAtEnd={readHold || gap ? false : GLIDE}");
    expect(chat).toContain("const listScroll = useAnimatedRef<Animated.ScrollView>();");
    // Listened to once the push has ended, as the face mounts.
    expect(chat).toContain("const pull = usePullPastEnd(listScroll, peekAgentId !== null && settled);");
    expect(chat).toContain("{peekAgentId && showList && settled ? <ChatPeek");
    // iOS only: Android's list never reports a pull past its end.
    expect(chat).toContain('const PEEK = Platform.OS === "ios";');
    expect(chat).toContain("PEEK ? peekAgentOf(dmAgentId, shownMessages) : null");
  });

  test("the face is the first thing in the dock (under all of it), a still frame looking up, taking no touch", () => {
    const dock = between(chat, "<KeyboardStickyView offset={{ opened: lift }}", "ref={composerRef}");
    const face = dock.indexOf("<ChatPeek agentId={peekAgentId} pull={pull} dock={boxHeight} />");
    expect(face).toBeGreaterThan(0);
    expect(dock.indexOf("<ToLatest")).toBeGreaterThan(face);
    expect(dock.indexOf("<ComposerFloat")).toBeGreaterThan(face);
    expect(peek).toContain('<AgentFace agentId={agentId} size={PEEK_SIZE} live={false} framed={false} gaze="up" />');
    expect(peek).toContain('pointerEvents="none"');
    expect(peek).toContain('importantForAccessibility="no-hide-descendants"');
    expect(peek).toContain('overflow: "hidden",');
  });

  test("transform and opacity only, straight from the pull; one tap at the crossing, from a reaction", () => {
    const view = between(peek, "export const ChatPeek = memo(function ChatPeek({", "const styles =");
    expect(view).not.toMatch(/withSpring|withTiming|entering=|layout=/);
    expect(view).toContain("const pose = peekPose(pull.get(), reduced);");
    expect(view).toContain("return { opacity: pose.opacity, transform: [{ translateY: pose.y }] };");
    expect(view).toContain("const edge = useAnimatedStyle(() => ({ transform: [{ translateY: -dock.get() }] }));");
    const reaction = between(view, "useAnimatedReaction(", "const edge =");
    expect(reaction).toContain("const next = armedAfter(was, now);");
    expect(reaction).toContain("if (next) scheduleOnRN(tap);");
    expect(peek).toContain("const tap = () => haptics.light();");
  });
});
