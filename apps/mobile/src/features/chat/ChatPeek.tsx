import { memo, useEffect } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, StyleSheet } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  type AnimatedRef,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useEvent,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { haptics, useReducedMotion } from "@/ui";
import { AgentFace } from "../shared/Face";
import { MSG_AVATAR, MSG_INSET } from "./logic";
import { armedAfter, keyboardAtRest, nextPull, PEEK_SIZE, pastEnd, peekPose } from "./peek";

/** Every frame of a scroll, and the finger taking and leaving the list. */
const PULL_EVENTS = ["onScroll", "onScrollBeginDrag", "onScrollEndDrag"];

/**
 * What `useEvent` hands back at run time: the handler an animated component registers on its own view. Here it goes on
 * the list's scroll view, which the keyboard's list renders and only lends through a ref, the way Reanimated's own
 * `useScrollOffset` and the keyboard library's scroll state register theirs. Without it (another version), no peek.
 */
interface ViewEvents {
  workletEventHandler?: {
    registerForEvents(tag: number): void;
    unregisterFromEvents(tag: number): void;
  };
}

/** The tap as the face arrives: once per pull, from the UI thread. */
const tap = () => haptics.light();

/**
 * How far the conversation is pulled past its last message (points), read on the UI thread from the list's own scroll
 * events: the offset, the content's and the list's heights and the bottom inset the keyboard's list keeps (the
 * keyboard and the dock), all from the same event, so they always agree with the bounce the person sees. No React
 * state and nothing on the JS thread per frame. Only past the end and only from the person's pull (`nextPull`); off
 * (`enabled` false) nothing is listened to.
 *
 * iOS only: there the list bounces past its end and says so in its offset. Android's list stops at its end (the
 * stretch is drawn, never reported), so there is no pull to read.
 */
export function usePullPastEnd(scroll: AnimatedRef<Animated.ScrollView>, enabled: boolean): SharedValue<number> {
  const pull = useSharedValue(0);
  const dragging = useSharedValue(false);
  const keyboard = useReanimatedKeyboardAnimation();
  const handler = useEvent<NativeSyntheticEvent<NativeScrollEvent>>((e) => {
    "worklet";
    if (e.eventName.endsWith("onScrollBeginDrag")) dragging.set(true);
    else if (e.eventName.endsWith("onScrollEndDrag")) dragging.set(false);
    const past = pastEnd(
      e.contentOffset.y,
      e.contentSize.height,
      e.layoutMeasurement.height,
      e.contentInset.top,
      e.contentInset.bottom,
    );
    const next = nextPull(pull.get(), past, dragging.get(), keyboardAtRest(keyboard.progress.get()));
    if (next !== pull.get()) pull.set(next);
  }, PULL_EVENTS);
  useEffect(() => {
    const events = (handler as unknown as ViewEvents).workletEventHandler;
    if (!enabled || !events) return;
    return scroll.observe((tag) => {
      if (!tag) return;
      events.registerForEvents(tag);
      return () => events.unregisterFromEvents(tag);
    });
  }, [scroll, handler, enabled]);
  return pull;
}

/**
 * The conversation's agent peeking up from behind the dock as the person pulls past the last message, looking up at
 * them: it rises with the pull (transform and opacity only, straight from the scroll's offset), arrives with one light
 * tap as the pull reaches its line, and goes back down with the bounce on its own. It stands in the agents' face
 * column, over the dock's top edge and under everything in the dock, inside the room the pull opens below the last
 * message: it never covers a message or the composer, and never takes a touch. A still frame (a live agent redraws
 * itself 25 times a second, for a face that is out of sight almost always). Drawn again only for another agent: the
 * screen redraws for much else, and the pull never redraws it.
 *
 * `dock`: the composer box's height (its top edge is where the face comes up from).
 */
export const ChatPeek = memo(function ChatPeek({
  agentId,
  pull,
  dock,
}: {
  agentId: string;
  pull: SharedValue<number>;
  dock: SharedValue<number>;
}) {
  const reduced = useReducedMotion();
  const armed = useSharedValue(false);
  // On the frame the pull crosses the line, nothing else leaves the UI thread.
  useAnimatedReaction(
    () => pull.get(),
    (now) => {
      const was = armed.get();
      const next = armedAfter(was, now);
      if (next === was) return;
      armed.set(next);
      if (next) scheduleOnRN(tap);
    },
  );
  const edge = useAnimatedStyle(() => ({ transform: [{ translateY: -dock.get() }] }));
  const face = useAnimatedStyle(() => {
    const pose = peekPose(pull.get(), reduced);
    return { opacity: pose.opacity, transform: [{ translateY: pose.y }] };
  }, [reduced]);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.box, edge]}
    >
      <Animated.View style={face}>
        <AgentFace agentId={agentId} size={PEEK_SIZE} live={false} framed={false} gaze="up" />
      </Animated.View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  // At the dock's bottom, lifted by the box's height to its top edge; what is below the edge is cut, so the face
  // comes up from behind it. Centered on the column where the agents' faces stand in their messages.
  box: {
    position: "absolute",
    bottom: 0,
    left: MSG_INSET + (MSG_AVATAR - PEEK_SIZE) / 2,
    width: PEEK_SIZE,
    height: PEEK_SIZE,
    overflow: "hidden",
  },
});
