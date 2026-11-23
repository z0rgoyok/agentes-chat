import { useLayoutEffect } from "react";
import { useKeyboardHandler, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

/**
 * An empty conversation's greeting (an agent's first day, a channel's hello) giving way to the keyboard as the composer
 * does, with nothing laid out while the keyboard moves: the greeting follows it with a translate, and once it settles
 * the same distance turns into top padding (one layout), so the greeting's top stays in the room above the keys and its
 * scroll reaches all of it. As the keyboard starts to close the padding goes at once and the translate brings the
 * greeting down with the keys. `lift`: how much of the composer's bottom padding hides behind the open keyboard.
 *
 * Two styles for the view, spread after its own: an animated style sends all of its props whenever one changes, so the
 * padding (a layout) lives apart from the translate that changes every frame.
 */
export function useKeyboardRoom(lift: number) {
  const keyboard = useReanimatedKeyboardAnimation();
  const settled = useSharedValue(0);
  // A keyboard already open when the greeting shows (the person typed while the conversation loaded): its room at once.
  useLayoutEffect(() => {
    settled.set(Math.max(0, -keyboard.height.get() - lift));
  }, [keyboard, lift, settled]);
  useKeyboardHandler(
    {
      onStart: (e) => {
        "worklet";
        if (e.height === 0) settled.set(0);
      },
      onEnd: (e) => {
        "worklet";
        settled.set(Math.max(0, e.height - lift));
      },
    },
    [lift],
  );
  const room = useAnimatedStyle(() => ({ paddingTop: settled.get() }));
  const follow = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, -keyboard.height.get() - lift) }],
  }));
  return [room, follow] as const;
}
