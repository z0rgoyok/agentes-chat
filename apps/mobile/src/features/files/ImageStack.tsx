import type { ArtifactDetail } from "@agenteschat/client";
import { Image } from "expo-image";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AccessibilityActionEvent, StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { haptics, Icon, motion, Text, useReducedMotion, useTheme } from "@/ui";
import { useMessageCardCorners } from "../chat/look";
import { useColors, useOrgId } from "../shared/hooks";
import { DECK_DRAG, DECK_RISE, deckCard, deckIndex, deckTarget, wrapPlace } from "./deck";
import type { FileRef } from "./logic";
import type { MessageFile } from "./MessageFiles";
import { openFile } from "./open";
import { pictureDrawn, pictureFade, useRemoteFile } from "./source";
import { listenViewerPlace } from "./viewer-place";

export interface StackImage {
  file: MessageFile;
  detail: ArtifactDetail | undefined;
}

/** The cards keep inside the block when they lean out from behind. */
const SIDE = 7;
/** More pictures than this say "3 de 7" instead of dots. */
const MAX_DOTS = 5;
/** A deck let go of: back into place keeping the finger's speed (the app's snap; a plain object the worklet reads). */
const SETTLE = { ...motion.snap };

/**
 * Two or more pictures in a message: a deck to swipe through, its dots under it. A tap opens the viewer at the
 * picture on top, and closing it brings the deck back on the one the person stopped at.
 */
export function ImageStack({
  images,
  width,
  openable = true,
  siblings,
}: {
  images: StackImage[];
  width: number;
  /** False while the pictures are still on their way up: the deck swipes, a tap opens nothing yet. */
  openable?: boolean;
  /** The message's pictures and videos in the order they show, the deck's among them: the viewer pages through all. */
  siblings?: readonly FileRef[];
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  const key = useId();
  const count = images.length;
  const size = width - SIDE * 2;
  const per = size * DECK_DRAG;
  const place = useSharedValue(0);
  const from = useSharedValue(0);
  const [active, setActive] = useState(0);

  useAnimatedReaction(
    () => deckIndex(place.value, count),
    (now, before) => {
      if (before !== null && now !== before) scheduleOnRN(setActive, now);
    },
    [count],
  );
  // The viewer says which file the person stopped at: one of the deck's comes on top, a video beside them changes nothing.
  const ids = images.map((i) => i.file.id).join(",");
  useEffect(
    () =>
      listenViewerPlace(key, (id) => {
        const at = ids.split(",").indexOf(id);
        if (at < 0) return;
        place.value = at;
        setActive(at);
      }),
    [key, place, ids],
  );

  // Opening the pictures is plain navigation: no haptic (a swipe through the stack has its own).
  const open = (at: number) => {
    if (!openable) return;
    const deck = images.map(
      ({ file, detail }): FileRef => ({ id: file.id, version: file.version, title: file.title, detail }),
    );
    const tapped = deck[at];
    if (tapped) openFile(tapped, siblings ?? deck, { from: key });
  };

  const settle = (target: number, velocity: number) => {
    "worklet";
    place.value = reduced
      ? wrapPlace(target, count)
      : withSpring(target, { ...SETTLE, velocity }, (done) => {
          if (done) place.value = wrapPlace(target, count);
        });
  };

  const pan = usePanGesture({
    // Sideways only: a vertical drag stays the conversation's scroll.
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    maxPointers: 1,
    onActivate: () => {
      "worklet";
      cancelAnimation(place);
      from.value = place.value;
    },
    onUpdate: (e) => {
      "worklet";
      place.value = from.value - e.translationX / per;
    },
    onDeactivate: (e) => {
      "worklet";
      const target = deckTarget(from.value, place.value, e.velocityX);
      if (target !== Math.round(from.value)) scheduleOnRN(haptics.selection);
      settle(target, -e.velocityX / per);
    },
  });
  const tap = useTapGesture({
    onDeactivate: (e) => {
      "worklet";
      if (!e.canceled) scheduleOnRN(open, deckIndex(place.value, count));
    },
  });
  const gesture = useExclusiveGestures(pan, tap);

  const turn = (by: number) => {
    const target = Math.round(place.get()) + by;
    place.set(wrapPlace(target, count));
    setActive(wrapPlace(target, count));
  };
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "increment") turn(1);
    else if (e.nativeEvent.actionName === "decrement") turn(-1);
    else if (e.nativeEvent.actionName === "activate") open(active);
  };

  const label = t("mobile.files.imageOf", { index: active + 1, count });
  return (
    <View style={[styles.block, { width }]}>
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[styles.stage, { width, height: size + DECK_RISE }]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={images[active]?.detail?.title || images[active]?.file.title || label}
          accessibilityValue={{ text: label }}
          accessibilityHint={t("mobile.files.openImage")}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }, { name: "activate" }]}
          onAccessibilityAction={onAction}
        >
          {images.map((item, i) => (
            <StackCard
              key={item.file.id}
              item={item}
              index={i}
              count={count}
              size={size}
              place={place}
              // The pictures in sight, or the next to come into it.
              near={wrapPlace(i - active, count) <= 3 || wrapPlace(active - i, count) <= 1}
            />
          ))}
        </Animated.View>
      </GestureDetector>
      <View style={styles.dots} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {count > MAX_DOTS ? (
          <Text variant="caption" tone="muted" style={styles.count}>
            {t("mobile.files.place", { index: active + 1, count })}
          </Text>
        ) : (
          images.map((item, i) => <Dot key={item.file.id} index={i} count={count} place={place} color={c.ink} />)
        )}
      </View>
    </View>
  );
}

function StackCard({
  item: { file },
  index,
  count,
  size,
  place,
  near,
}: {
  item: StackImage;
  index: number;
  count: number;
  size: number;
  place: SharedValue<number>;
  near: boolean;
}) {
  const cardCorners = useMessageCardCorners();
  const orgId = useOrgId();
  const c = useColors();
  const { shadows } = useTheme();
  // The message's own version, from the first frame (see `MessageFiles`' `InlineImage`).
  const version = file.version;
  const key = `${file.id}@${version ?? "latest"}`;
  const link = useRemoteFile(orgId, near ? file.id : null, version);
  const [failed, setFailed] = useState(false);
  const placed = useAnimatedStyle(() => {
    const s = deckCard(index, place.value, count, size);
    return {
      opacity: s.opacity,
      zIndex: s.z,
      transform: [{ translateX: s.x }, { translateY: s.y }, { rotate: `${s.rotate}deg` }, { scale: s.scale }],
    };
  });
  return (
    <Animated.View
      style={[
        styles.card,
        { width: size, height: size, backgroundColor: c.sunken, borderColor: c.line2, boxShadow: shadows.e2 },
        cardCorners,
        placed,
      ]}
    >
      <View style={[styles.clip, cardCorners]}>
        {link.data && !failed ? (
          <Image
            source={{ uri: link.data.uri, headers: link.data.headers, cacheKey: key }}
            recyclingKey={key}
            cachePolicy="memory-disk"
            contentFit="cover"
            transition={pictureFade(key)}
            onLoad={() => pictureDrawn(key)}
            style={StyleSheet.absoluteFill}
            onError={() => setFailed(true)}
            accessible={false}
          />
        ) : null}
        {failed || link.isError ? (
          <View style={styles.center}>
            <Icon name="image" size={22} color={c.faint} />
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

/** A dot that grows as its picture comes to the top, moving with the finger. */
function Dot({
  index,
  count,
  place,
  color,
}: {
  index: number;
  count: number;
  place: SharedValue<number>;
  color: string;
}) {
  const shape = useAnimatedStyle(() => {
    const away = wrapPlace(place.value - index, count);
    const near = Math.max(0, 1 - Math.min(away, count - away));
    return { width: 6 + 8 * near, opacity: 0.22 + 0.78 * near };
  });
  return <Animated.View style={[styles.dot, { backgroundColor: color }, shape]} />;
}

const styles = StyleSheet.create({
  block: { marginTop: 8 },
  stage: { position: "relative" },
  card: {
    position: "absolute",
    top: DECK_RISE,
    left: SIDE,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  clip: { flex: 1, borderRadius: 20, overflow: "hidden" },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  dots: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 20, marginTop: 8 },
  dot: { height: 6, borderRadius: 3 },
  count: { fontWeight: "600" },
});
