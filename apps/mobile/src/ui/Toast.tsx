import { TrueSheetOverlay } from "@lodev09/react-native-true-sheet";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type AccessibilityActionEvent, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { type AgentLookInput, lookOf } from "@/agent/looks";
import { CodeWords } from "./CodeWords";
import { activeWindowFold, toastInsets } from "./fold-room";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { PRESS_DELAY } from "./PressScale";
import { type ToastTone, toastToneOf, toneColor } from "./palette";
import { Text } from "./Text";
import { useWindowFold } from "./TwoPane";
import { motion, useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export interface ToastInput {
  title: string;
  subtitle?: string;
  /** Default: a check (done). */
  icon?: IconName;
  /** The icon's color; by default from the icon (`toastToneOf`: a failure, done, anything else). */
  tone?: ToastTone;
  /** Show this agent's face instead of the icon (looks from `rememberAgentLooks`). */
  agentId?: string;
  /** Or pass the look directly. */
  agent?: AgentLookInput;
  /**
   * One word at the toast's end that acts on what it reports ("Desfazer" after "Feito"): the toast stays longer
   * (`ACTION_MS`) and tapping the word runs it and puts the toast away.
   */
  action?: { label: string; onPress: () => void };
}

type ToastFn = (input: ToastInput) => void;
type Shown = ToastInput & { key: number };

const ToastContext = createContext<ToastFn | null>(null);
/** How long a plain toast stays; one with an action waits for the hand. */
const SHOW_MS = 2600;
const ACTION_MS = 5000;
/** Held and let go, a toast near its end still stays this long: time to read it once the finger is off it. */
const RESUME_MS = 1000;
/** How long the toast takes to arrive, and to leave (faster: the reading is done). */
const ENTER_MS = 280;
const LEAVE_MS = 220;
/** Gone from the screen (faded out) by then: the next toast may come in. */
const GONE_MS = LEAVE_MS + 40;
/** The toast's corner and the room around its icon tile: the tile's corner is the toast's less that room (concentric). */
const TOAST_R = 22;
const TOAST_PAD = 10;
/** Where the toast rests off screen, above the top edge. */
const HIDDEN_Y = -160;
/** A swipe up this far, or a flick, puts it away. */
const DISMISS_Y = -28;
const FLICK = -600;
/** Back home after a swipe that didn't put it away, with the finger's speed (read from the UI thread). */
const SNAP_BACK = motion.snap;
/** The action's word takes a tap this far before it too (a finger's 44 around a short word). */
const ACTION_SLOP = 10;

const noop: ToastFn = () => {};

/** `const toast = useToast(); toast({ title, subtitle?, icon?, agentId?, action? })`: a glass note from the top. */
/** A toast's haptic by its tone (`toastToneOf`): the system's own failure, warning and success patterns, else a tap. */
export function toastHaptic(tone: ToastTone) {
  if (tone === "danger") haptics.error();
  else if (tone === "warning") haptics.warning();
  else if (tone === "success") haptics.success();
  else haptics.light();
}

export function useToast(): ToastFn {
  return useContext(ToastContext) ?? noop;
}

/**
 * Provides `useToast` and draws the toast above everything (place it once, near the root). One toast at a time: a new
 * one while another shows waits for it to leave, then comes in (only the latest waits).
 */
export function ToastHost({ children }: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<{ shown: Shown | null; next: Shown | null }>({ shown: null, next: null });
  const counter = useRef(0);
  const toast = useCallback<ToastFn>((input) => {
    counter.current += 1;
    const item = { ...input, key: counter.current };
    setToasts((now) => (now.shown ? { shown: now.shown, next: item } : { shown: item, next: null }));
  }, []);
  // Only the toast on screen can hand over to the next one.
  const gone = useCallback((key: number) => {
    setToasts((now) => (now.shown?.key === key ? { shown: now.next, next: null } : now));
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      {toasts.shown ? (
        <ToastLayer>
          <ToastView key={toasts.shown.key} item={toasts.shown} replaced={toasts.next !== null} onGone={gone} />
        </ToastLayer>
      ) : null}
    </ToastContext.Provider>
  );
}

/**
 * Where the toast is drawn: TrueSheet's overlay, a layer of its own that the library keeps above every sheet it
 * presents (the app's sheets are all TrueSheet) and that VoiceOver still reaches while a sheet is up. Mounted only
 * while a toast shows, so it is put on top of whatever is on screen then (a screen presented whole included); touches
 * that miss the toast go through to what is under it. Gestures need a root of their own there, as tall as the toast
 * alone: on Android a touch passes through only where no view of the layer is. The overlay fills the window, so the
 * window's fold applies as it is: folded like a book, the toast keeps to the half past the fold (ADR 0212).
 */
function ToastLayer({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const sides = toastInsets(width, activeWindowFold(useWindowFold()));
  return (
    <TrueSheetOverlay>
      {/* As wide as the screen (or the half past the fold), the capsule centered in it: only the capsule takes a
          touch, the sides let it through. */}
      <GestureHandlerRootView
        pointerEvents="box-none"
        style={[styles.layer, { top: insets.top + 6, left: sides.left, right: sides.right }]}
      >
        {children}
      </GestureHandlerRootView>
    </TrueSheetOverlay>
  );
}

/**
 * The toast: it drops in from the top on a strong ease-out (no bounce: nobody threw it) and leaves the way it came,
 * a little faster. It goes by itself after a while; a finger on it holds it there, and its time runs on once the
 * finger lifts. A tap puts it away; so does a swipe up, which follows the finger 1:1 (a pull down resists, the toast
 * lives above) and lets go on distance or on a flick, the spring seeded with the finger's speed. With an action, it
 * waits longer and the word at its end runs it. A newer toast makes it leave first.
 */
function ToastView({ item, replaced, onGone }: { item: Shown; replaced: boolean; onGone: (key: number) => void }) {
  const { colors, shadows, reducedMotion } = useTheme();
  const y = useSharedValue(reducedMotion ? 0 : HIDDEN_Y);
  const opacity = useSharedValue(0);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  // Gone once: the timer, a tap, a swipe, the action or a newer toast may each ask for it.
  const leaving = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When it hides by itself, and what was left of that when a finger took hold of it.
  const due = useRef(0);
  const left = useRef(0);

  const leave = useCallback(
    (velocity = 0) => {
      if (leaving.current) return;
      leaving.current = true;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = null;
      opacity.set(withTiming(0, { duration: LEAVE_MS, easing: motion.easeOut }));
      if (reducedMotion) y.set(0);
      else y.set(withSpring(HIDDEN_Y, { ...motion.settle, velocity, overshootClamping: true }));
      goneTimer.current = setTimeout(() => goneRef.current(item.key), GONE_MS);
    },
    [item.key, opacity, reducedMotion, y],
  );

  const arm = useCallback(
    (ms: number) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      due.current = Date.now() + ms;
      hideTimer.current = setTimeout(() => leave(), ms);
    },
    [leave],
  );
  // A finger on the toast stops its time; lifted, the rest of it runs (a beat at least).
  const hold = useCallback(() => {
    if (leaving.current || !hideTimer.current) return;
    clearTimeout(hideTimer.current);
    hideTimer.current = null;
    left.current = Math.max(0, due.current - Date.now());
  }, []);
  const release = useCallback(() => {
    if (leaving.current || hideTimer.current) return;
    arm(Math.max(RESUME_MS, left.current));
  }, [arm]);

  // Felt as it comes in, in the same frame, by what it says: a failure buzzes as one, a done thing as one, the rest a
  // light tap. Once per toast (a toast replaced before it shows still came).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the toast arrives
  useEffect(() => {
    toastHaptic(item.tone ?? toastToneOf(item.icon));
  }, []);

  useEffect(() => {
    if (leaving.current) return;
    y.set(reducedMotion ? 0 : withTiming(0, { duration: ENTER_MS, easing: motion.easeOut }));
    opacity.set(withTiming(1, { duration: reducedMotion ? LEAVE_MS : ENTER_MS, easing: motion.easeOut }));
    arm(item.action ? ACTION_MS : SHOW_MS);
  }, [y, opacity, reducedMotion, arm, item.action]);

  // A newer toast waits for this one: it leaves first, then the new one comes in.
  useEffect(() => {
    if (replaced) leave();
  }, [replaced, leave]);

  // No timer outlives the toast.
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (goneTimer.current) clearTimeout(goneTimer.current);
    },
    [],
  );

  const dismiss = useCallback(() => leave(), [leave]);
  const onAction = item.action?.onPress;
  const act = useCallback(() => {
    haptics.light();
    onAction?.();
    leave();
  }, [leave, onAction]);

  // Every touch on the toast is one of its two gestures, the same in any layer it is drawn in. The swipe: finger down,
  // the toast is held and it is the finger (up freely, down with resistance); finger up, distance or a flick
  // dismisses, else it springs home with the finger's speed, and its time runs on. The tap (a finger that didn't
  // move): on the action's word it runs the action, anywhere else it puts the toast away.
  const start = useSharedValue(0);
  // Where the action's word starts in the toast, its slop included (none: never).
  const actionFrom = useSharedValue(Number.POSITIVE_INFINITY);
  const actionDown = useSharedValue(0);
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activeOffsetY([-6, 6])
      .onBegin(() => {
        scheduleOnRN(hold);
      })
      .onStart(() => {
        start.set(y.get());
      })
      .onUpdate((e) => {
        const next = start.get() + e.translationY;
        y.set(next <= 0 ? next : rubberband(next));
      })
      .onEnd((e) => {
        if (y.get() < DISMISS_Y || e.velocityY < FLICK) {
          scheduleOnRN(leave, e.velocityY);
        } else {
          y.set(withSpring(0, { ...SNAP_BACK, velocity: e.velocityY }));
        }
      })
      .onFinalize(() => {
        scheduleOnRN(release);
      });
    const tap = Gesture.Tap()
      .maxDistance(10)
      .onBegin((e) => {
        // The word dims under the finger a beat late, as the kit's presses do: a swipe that starts on it never flashes.
        if (e.x >= actionFrom.get()) actionDown.set(withDelay(PRESS_DELAY, withTiming(1, { duration: 0 })));
      })
      .onEnd((e, success) => {
        if (!success) return;
        if (e.x >= actionFrom.get()) scheduleOnRN(act);
        else scheduleOnRN(dismiss);
      })
      .onFinalize(() => {
        actionDown.set(0);
      });
    // The swipe first: a tap counts only once the finger lifts without having moved.
    return Gesture.Exclusive(pan, tap);
  }, [act, actionDown, actionFrom, dismiss, hold, leave, release, start, y]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ translateY: y.get() }] }));
  const actionStyle = useAnimatedStyle(() => ({ opacity: 1 - 0.4 * actionDown.get() }));
  const look = item.agent ?? (item.agentId ? lookOf(item.agentId) : undefined);
  const tone = item.tone ?? toastToneOf(item.icon);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        // VoiceOver's escape (a two-finger scrub) puts it away, as a tap does.
        onAccessibilityEscape={dismiss}
        style={[styles.box, { boxShadow: shadows.e3 }, style]}
      >
        {/* A calm capsule on the screen's glass: the tone is the icon's color alone, no plate behind it and no tint. */}
        <Glass intensity={70} style={styles.glass}>
          {look ? (
            <AgentAvatar agent={look} size={24} />
          ) : (
            <Icon name={item.icon ?? "check"} size={18} color={toneColor(colors, tone)} />
          )}
          <View style={styles.words}>
            <Text variant="subhead" numberOfLines={1} style={styles.title}>
              <CodeWords text={item.title} />
            </Text>
            {item.subtitle ? (
              <Text variant="footnote" numberOfLines={2}>
                {item.subtitle}
              </Text>
            ) : null}
          </View>
          {item.action ? (
            // A button to screen readers (their double tap is its "activate"); the toast's tap runs it for a finger.
            <Animated.View
              accessible
              accessibilityRole="button"
              accessibilityLabel={item.action.label}
              accessibilityActions={ACTIVATE}
              onAccessibilityAction={(e: AccessibilityActionEvent) => {
                if (e.nativeEvent.actionName === "activate") act();
              }}
              onLayout={(e) => actionFrom.set(e.nativeEvent.layout.x - ACTION_SLOP)}
              style={[styles.action, actionStyle]}
            >
              <Text
                variant="subhead"
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={styles.actionText}
              >
                {item.action.label}
              </Text>
            </Animated.View>
          ) : null}
        </Glass>
      </Animated.View>
    </GestureDetector>
  );
}

const ACTIVATE = [{ name: "activate" as const }];

/** Pulled down past rest, the toast follows less the further it goes (it lives above, there is nothing below). */
function rubberband(overshoot: number, dimension = 80, constant = 0.55) {
  "worklet";
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

const styles = StyleSheet.create({
  // Under the status bar, 12 from the screen's sides (`toastInsets`); as tall as the toast.
  layer: { position: "absolute", alignItems: "center" },
  // As wide as its words (a one-line toast is a pill), up to the layer's width.
  box: { borderRadius: TOAST_R, maxWidth: "100%" },
  glass: {
    borderRadius: TOAST_R,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: TOAST_PAD,
    paddingLeft: 14,
    paddingRight: 18,
    minHeight: 2 * TOAST_R,
  },
  words: { flexShrink: 1, minWidth: 0 },
  title: { fontWeight: weights.semibold },
  // The word stands on its own at the end: no plate; the tap takes it from `ACTION_SLOP` before it to the toast's end.
  action: { paddingLeft: 4, minHeight: 34, justifyContent: "center" },
  actionText: { fontWeight: weights.semibold },
});
