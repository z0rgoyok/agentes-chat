import { Image } from "expo-image";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, type ScrollViewInstance, StyleSheet, View } from "react-native";
import {
  GestureDetector,
  type PanGesture,
  useExclusiveGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Button, Icon, type IconName, Text, useReducedMotion } from "@/ui";
import {
  clamp,
  dragWithin,
  fitted,
  maxZoom,
  panRoom,
  pinchRest,
  resistedZoom,
  rubberClamp,
  type Size,
  zoomInAt,
  zoomInRect,
} from "./zoom";

export interface ZoomPictureProps {
  source: { uri: string; headers?: Record<string, string> | undefined };
  /** Which picture and version: its cache entry, and what a recycled view shows. */
  cacheKey: string;
  screen: Size;
  /** The viewer's pull to close: first in line for a touch, and only offered at 1×. */
  pull: PanGesture;
  /** Off while the pages slide: a touch then is the pager's. */
  enabled: boolean;
  /** The page in sight: zoomed in, it shows the picture's own pixels; the pages beside it a copy the screen's size. */
  active: boolean;
  /** A single tap (after a double tap's wait): the viewer shows or hides its bars. */
  onTap: () => void;
  /** Zoomed in, or back at 1×. */
  onZoom: (zoomed: boolean) => void;
  /** "Try again" on a picture that couldn't load: its link is read again. */
  onRetry: () => void;
}

/**
 * One picture in the viewer, whole on the screen, that zooms. On iOS the system zooms it (a scroll view's own pinch,
 * with its momentum, its edges and its bounce past the limits) and a double tap zooms in at the tapped spot through
 * the same scroll view, so it feels as the phone's photos do. Android has no zooming view, so there the pinch is ours,
 * with the same feel: around the fingers, giving a little past 1× and past the most it zooms and springing back, a
 * zoomed picture dragged with one finger resisting past the screen's edges and flung to glide, bouncing off an edge it
 * hits, and a double tap springs in at the spot or back out. Up to twice the picture's own pixels (`maxZoom`), shown at
 * those pixels once zoomed (a copy the screen's size would only be magnified). With reduced motion the zoom jumps.
 */
export function ZoomPicture({
  source,
  cacheKey,
  screen,
  pull,
  enabled,
  active,
  onTap,
  onZoom,
  onRetry,
}: ZoomPictureProps) {
  const reduced = useReducedMotion();
  const [pixels, setPixels] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  // Each "Try again" loads the picture again from the start.
  const [tries, setTries] = useState(0);
  // Zoomed in while in sight: the full picture, not one downscaled to the screen; the copy again once out of sight.
  const [sharp, setSharp] = useState(false);
  useEffect(() => {
    if (!active) setSharp(false);
  }, [active]);
  const zoomChanged = useCallback(
    (now: boolean) => {
      if (now) setSharp(true);
      onZoom(now);
    },
    [onZoom],
  );
  const retry = () => {
    setFailed(false);
    setTries((n) => n + 1);
    onRetry();
  };
  const picture = fitted(pixels ? pixels.width / pixels.height : null, screen);
  const max = maxZoom(pixels?.width, screen.width);
  const image = (
    <Image
      key={tries}
      source={{ uri: source.uri, ...(source.headers ? { headers: source.headers } : {}), cacheKey }}
      recyclingKey={cacheKey}
      contentFit="contain"
      allowDownscaling={!(active && sharp)}
      transition={160}
      onLoad={(e) => {
        if (e.source.width > 0 && e.source.height > 0) setPixels({ width: e.source.width, height: e.source.height });
      }}
      onError={() => setFailed(true)}
      style={StyleSheet.absoluteFill}
      accessible={false}
    />
  );
  const zoom = { picture, screen, max, pull, enabled, reduced, onTap, onZoom: zoomChanged, children: image };
  return (
    <View style={screen}>
      {Platform.OS === "ios" ? <SystemZoom {...zoom} /> : <OwnZoom {...zoom} />}
      {pixels ? null : <PageWait failed={failed} onRetry={retry} />}
    </View>
  );
}

const WHITE = "#fff";
const DIM = "rgba(255,255,255,0.6)";
/** A double tap's zoom, in or out, and a pinch springing back inside its limits: settles without overshooting. */
const ZOOM_SPRING = { dampingRatio: 1, duration: 360 };

/**
 * A viewer's page on its way (a spinner), or one that couldn't load: the words and "Try again", with its spinner
 * while the link is read again (`retrying`). Only the button takes a touch: the rest of the page keeps the pull to
 * close, so a page that never loads can still be swiped away.
 */
export function PageWait({
  failed,
  retrying = false,
  icon = "image",
  onRetry,
}: {
  failed: boolean;
  retrying?: boolean;
  icon?: IconName;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (!failed)
    return (
      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
        <ActivityIndicator color={WHITE} />
      </View>
    );
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, styles.failed]} pointerEvents="box-none">
      <View style={[styles.center, styles.failedWords]} pointerEvents="none">
        <Icon name={icon} size={30} color={DIM} />
        <Text variant="footnote" style={[styles.failedText, { color: DIM }]}>
          {t("mobile.files.loadFailed")}
        </Text>
      </View>
      {/* A row of its own: the button keeps to its width, centred under the words. */}
      <View style={styles.retry}>
        <Button variant="secondary" size="sm" label={t("mobile.common.retry")} loading={retrying} onPress={onRetry} />
      </View>
    </View>
  );
}

interface ZoomProps {
  /** The picture's box at 1×, centered on the screen. */
  picture: Size;
  screen: Size;
  max: number;
  pull: PanGesture;
  enabled: boolean;
  /** Reduced motion: a double tap's zoom (and a pinch's way back inside its limits) is set at once. */
  reduced: boolean;
  onTap: () => void;
  onZoom: (zoomed: boolean) => void;
  children: ReactNode;
}

/** iOS: the scroll view zooms, pans and bounces; ours are only the taps and the pull before them. */
function SystemZoom({ picture, screen, max, pull, enabled, reduced, onTap, onZoom, children }: ZoomProps) {
  const scroll = useRef<ScrollViewInstance>(null);
  const zoomed = useSharedValue(false);
  // At 1× it doesn't bounce, so a vertical drag is the pull to close; zoomed, it does, as any scroll view.
  const [bounces, setBounces] = useState(false);
  const zoomChanged = useCallback(
    (now: boolean) => {
      setBounces(now);
      onZoom(now);
    },
    [onZoom],
  );
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      const now = (e.zoomScale ?? 1) > 1.01;
      if (now === zoomed.value) return;
      zoomed.value = now;
      scheduleOnRN(zoomChanged, now);
    },
  });
  const zoomTo = useCallback(
    (rect: { x: number; y: number; width: number; height: number }) => {
      scroll.current?.scrollResponderZoomTo({ ...rect, animated: !reduced });
    },
    [reduced],
  );
  const tap = useTapGesture({
    enabled,
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(onTap);
    },
  });
  const doubleTap = useTapGesture({
    enabled,
    numberOfTaps: 2,
    onDeactivate: (e) => {
      "worklet";
      // Zoomed: back to the whole picture. Else in at the spot, far enough to fill the screen.
      const rect = zoomed.value
        ? { x: 0, y: 0, width: picture.width, height: picture.height }
        : zoomInRect(picture, screen, { x: e.x, y: e.y }, max);
      scheduleOnRN(zoomTo, rect);
    },
  });
  const gesture = useExclusiveGestures(pull, doubleTap, tap);
  return (
    <GestureDetector gesture={gesture}>
      <Animated.ScrollView
        ref={scroll}
        style={screen}
        maximumZoomScale={max}
        minimumZoomScale={1}
        pinchGestureEnabled
        bouncesZoom
        bounces={bounces}
        centerContent
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
      >
        <View style={picture}>{children}</View>
      </Animated.ScrollView>
    </GestureDetector>
  );
}

/**
 * Android: pinch around the fingers, giving a little past the limits and springing back; a zoomed picture dragged
 * with one finger, resisting past the screen's edges, and flung to glide, bouncing off an edge it hits; double tap.
 */
function OwnZoom({ picture, screen, max, pull, enabled, reduced, onTap, onZoom, children }: ZoomProps) {
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  // Where the pinch started (its focal point from the screen's center), so each frame is worked out from there; and
  // where the fingers are now, the spot it settles around when let go.
  const start = useSharedValue({ scale: 1, x: 0, y: 0, fx: 0, fy: 0 });
  const focal = useSharedValue({ x: 0, y: 0 });
  const pinching = useSharedValue(false);
  const [zoomed, setZoomed] = useState(false);
  const zoomChanged = useCallback(
    (now: boolean) => {
      setZoomed(now);
      onZoom(now);
    },
    [onZoom],
  );
  useAnimatedReaction(
    () => scale.value > 1.01,
    (now, before) => {
      if (before !== null && now !== before) scheduleOnRN(zoomChanged, now);
    },
  );
  const stop = () => {
    "worklet";
    cancelAnimation(scale);
    cancelAnimation(x);
    cancelAnimation(y);
  };
  // To a zoom and a place: sprung, or set at once with reduced motion.
  const settle = (to: { scale: number; x: number; y: number }) => {
    "worklet";
    if (reduced) {
      scale.value = to.scale;
      x.value = to.x;
      y.value = to.y;
      return;
    }
    scale.value = withSpring(to.scale, ZOOM_SPRING);
    x.value = withSpring(to.x, ZOOM_SPRING);
    y.value = withSpring(to.y, ZOOM_SPRING);
  };
  // A one-finger fling on one axis: it glides to a stop, carried past an edge it reaches and sprung back to it (a
  // scroll view's bounce); with reduced motion it stays where the finger left it, back inside the edges.
  const glide = (from: number, velocity: number, room: number) => {
    "worklet";
    if (reduced || room <= 0) return clamp(from, -room, room);
    return withDecay({ velocity, clamp: [-room, room], rubberBandEffect: true });
  };

  const pinch = usePinchGesture({
    enabled,
    onActivate: (e) => {
      "worklet";
      stop();
      pinching.value = true;
      const fx = e.focalX - screen.width / 2;
      const fy = e.focalY - screen.height / 2;
      start.value = { scale: scale.value, x: x.value, y: y.value, fx, fy };
      focal.value = { x: fx, y: fy };
    },
    onUpdate: (e) => {
      "worklet";
      const from = start.value;
      const fx = e.focalX - screen.width / 2;
      const fy = e.focalY - screen.height / 2;
      // Past 1× or the most it zooms, it gives a little, resisting, and springs back when let go.
      const next = resistedZoom(from.scale * e.scale, 1, max);
      const grown = next / from.scale;
      // The spot that was under the fingers stays under them, wherever they go; past the screen's edges it resists.
      const room = panRoom(picture, next, screen);
      scale.value = next;
      x.value = rubberClamp(fx - grown * (from.fx - from.x), -room.x, room.x, screen.width);
      y.value = rubberClamp(fy - grown * (from.fy - from.y), -room.y, room.y, screen.height);
      focal.value = { x: fx, y: fy };
    },
    onDeactivate: () => {
      "worklet";
      settle(pinchRest(picture, screen, { scale: scale.value, x: x.value, y: y.value }, focal.value, max));
    },
    onFinalize: () => {
      "worklet";
      pinching.value = false;
    },
  });
  // One finger on a zoomed picture moves it, from where it is, and a fling glides.
  const pan = usePanGesture({
    enabled: enabled && zoomed,
    maxPointers: 1,
    onActivate: () => {
      "worklet";
      stop();
    },
    onUpdate: (e) => {
      "worklet";
      if (pinching.value) return;
      const room = panRoom(picture, scale.value, screen);
      x.value = dragWithin(x.value, e.changeX, -room.x, room.x, screen.width);
      y.value = dragWithin(y.value, e.changeY, -room.y, room.y, screen.height);
    },
    onDeactivate: (e) => {
      "worklet";
      if (pinching.value) return;
      // The edges where the zoom comes to rest (a pinch's spring back may still be on its way there).
      const room = panRoom(picture, clamp(scale.value, 1, max), screen);
      x.value = glide(x.value, e.velocityX, room.x);
      y.value = glide(y.value, e.velocityY, room.y);
    },
  });
  const tap = useTapGesture({
    enabled,
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(onTap);
    },
  });
  const doubleTap = useTapGesture({
    enabled,
    numberOfTaps: 2,
    onDeactivate: (e) => {
      "worklet";
      stop();
      settle(
        scale.value > 1.01
          ? { scale: 1, x: 0, y: 0 }
          : zoomInAt(picture, screen, { x: e.x - screen.width / 2, y: e.y - screen.height / 2 }, max),
      );
    },
  });
  const pinchAndPan = useSimultaneousGestures(pinch, pan);
  const gesture = useExclusiveGestures(pull, pinchAndPan, doubleTap, tap);
  const moved = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));
  return (
    <GestureDetector gesture={gesture}>
      <View style={[screen, styles.center]} collapsable={false}>
        <Animated.View style={[picture, moved]}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  retry: { flexDirection: "row" },
  failed: { gap: 16, paddingHorizontal: 32 },
  failedWords: { gap: 10 },
  failedText: { textAlign: "center" },
});
