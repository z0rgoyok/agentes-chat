import { useCallback, useEffect } from "react";
import { Keyboard, Platform } from "react-native";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import { Easing, type SharedValue, useAnimatedReaction, useSharedValue, withTiming } from "react-native-reanimated";
import { composerLift, listKeyboardRoom } from "./dock-height";

/** iOS, where the composer and the list hear the keyboard's height along different paths (`useListEnd`). */
const IOS = Platform.OS === "ios";
/**
 * How long after the system says the keyboard is gone the dock is put down if something still holds it up (ms): a
 * keyboard coming back at once (a tap on the field as it left) says so first.
 */
const HIDDEN_SETTLE_MS = 100;
/**
 * The list's end following the dock (who is working coming and going, a field growing a line): a short ease-out, so the
 * conversation slides with it instead of jumping (the keyboard list follows an animated room frame by frame).
 */
const END_FOLLOW = { duration: 200, easing: Easing.out(Easing.cubic) };

/** The keyboard library's values as `useReanimatedKeyboardAnimation` hands them (the height is negative while open). */
export interface KeyboardValues {
  height: SharedValue<number>;
  progress: SharedValue<number>;
}

export interface ListEnd {
  /** The list's `contentInsetEndAdjustment`: what it keeps under its last message besides its keyboard room. */
  end: SharedValue<number>;
  /** The person started dragging the list. */
  dragStarted: () => void;
  /** The list came to rest after a drag or a fling. */
  dragSettled: () => void;
}

/**
 * Where the conversation's list ends: always where the composer starts, whatever the keyboard did.
 *
 * Both follow the keyboard library, along two paths. The dock rides its values (`KeyboardStickyView`): a move's end
 * from the system's notification as the move starts, then every change from UIKit's keyboard layout guide, the keys'
 * real top (iOS 26 and later). The list's keyboard room (`KeyboardChatScrollView`) changes only on those
 * notifications. iOS changes the keyboard's height without one: the suggestion row leaves once a message is sent (40
 * points on an iPhone), the dock went down with the keys and the list kept the old room, its last 40 points under the
 * dock. The difference is added to the list's end (`box`, the dock's height, plus the gap), so the list ends where the
 * dock starts, and nothing else moves the dock: rewriting its values from the notifications' heights put it back 40
 * points over the keys.
 *
 * While the person drags the list the keys follow the finger and the list keeps its room, as the library does, until
 * the move that ends the drag; while the list is frozen (something covers it) nothing changes. Once the system says the
 * keyboard is gone nothing rides it: the dock rests and the list ends at it.
 */
export function useListEnd({
  keyboard,
  box,
  lift,
  freeze,
}: {
  keyboard: KeyboardValues;
  box: SharedValue<number>;
  lift: number;
  freeze: SharedValue<boolean>;
}): ListEnd {
  // The list's keyboard room as the library keeps it: the open keyboard's height taken while not frozen, and the height
  // and target it takes the room from once unfrozen (`useFrozenPadding`).
  const target = useSharedValue(0);
  const anyTarget = useSharedValue(0);
  const lastHeight = useSharedValue(0);
  const room = useSharedValue(0);
  // Where the dock rides less that room (iOS).
  const gap = useSharedValue(0);
  // The person's finger is on the list, and whether the keys followed it.
  const dragging = useSharedValue(false);
  const keysDragged = useSharedValue(false);
  useKeyboardHandler(
    {
      onStart: (e) => {
        "worklet";
        if (e.height > 0) anyTarget.set(e.height);
        if (freeze.get()) return;
        if (e.height > 0) target.set(e.height);
        // A move the system announced: the dock and the list take its height together.
        room.set(listKeyboardRoom(e.height, target.get(), lift));
        gap.set(0);
        dragging.set(false);
      },
      onMove: (e) => {
        "worklet";
        lastHeight.set(e.height);
      },
      onInteractive: (e) => {
        "worklet";
        if (dragging.get()) {
          keysDragged.set(true);
          return;
        }
        // The keys' top moved with no notification and no finger: the dock went with them, the list follows it.
        if (IOS && !freeze.get()) gap.set(composerLift(-e.height, e.progress, lift) - room.get());
      },
      onEnd: (e) => {
        "worklet";
        lastHeight.set(e.height);
        if (freeze.get()) return;
        room.set(listKeyboardRoom(e.height, target.get(), lift));
        gap.set(0);
        dragging.set(false);
      },
    },
    [lift],
  );
  // Unfrozen: the library takes its room from the last height it heard; the dock is where the keys are.
  useAnimatedReaction(
    () => freeze.get(),
    (frozen, was) => {
      if (frozen || was !== true) return;
      room.set(listKeyboardRoom(lastHeight.get(), anyTarget.get(), lift));
      gap.set(IOS ? composerLift(keyboard.height.get(), keyboard.progress.get(), lift) - room.get() : 0);
    },
    [lift],
  );
  // The system says the keyboard is gone: nothing rides it, whatever reading came last (iOS; on Android the library
  // ends every move itself). Unless it comes back at once, which the system says first.
  useEffect(() => {
    if (!IOS) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let back = false;
    const subscriptions = [
      Keyboard.addListener("keyboardWillShow", () => {
        back = true;
      }),
      Keyboard.addListener("keyboardDidHide", () => {
        back = false;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (back) return;
          if (keyboard.height.get() !== 0) keyboard.height.set(0);
          if (keyboard.progress.get() !== 0) keyboard.progress.set(0);
          dragging.set(false);
          if (!freeze.get()) gap.set(-room.get());
        }, HIDDEN_SETTLE_MS);
      }),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [keyboard, freeze, gap, room, dragging]);
  // A shared value of its own (the list's prop takes one, not a derived value), kept on the UI thread; the dock's opening
  // height from the start, so the list's first placement already ends above it.
  const end = useSharedValue(box.get());
  useAnimatedReaction(
    () => box.get() + gap.get(),
    (next, previous) => {
      end.set(previous === null ? next : withTiming(next, END_FOLLOW));
    },
  );
  const dragStarted = useCallback(() => {
    keysDragged.set(false);
    dragging.set(true);
  }, [dragging, keysDragged]);
  // A drag that never moved the keys holds nothing; one that did holds until the move that ends it.
  const dragSettled = useCallback(() => {
    if (!keysDragged.get()) dragging.set(false);
  }, [dragging, keysDragged]);
  return { end, dragStarted, dragSettled };
}
