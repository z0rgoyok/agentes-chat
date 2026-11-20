import { useDms, useSetChatPrefs, useSetConversationWallpaper, useUploadWallpaperPhoto } from "@agenteschat/client";
import { chatLookOf, textSizeOf } from "@agenteschat/client/lib/chat-look";
import { dayLabel, formatPercent } from "@agenteschat/client/lib/format";
import { DEFAULT_PHOTO_DIM, MAX_PHOTO_DIM, type Wallpaper } from "@agenteschat/client/lib/wallpaper";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { WALLPAPER_PAGE, wallpaperStrength } from "@agenteschat/ui/sky/wallpaper";
import { Canvas, Fill, Image } from "@shopify/react-native-skia";
import { useIsFocused } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, {
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { useOrg } from "@/providers/org";
import { Button, Glass, haptics, Text, useTheme, useToast } from "@/ui";
import { goBack } from "@/ui/navigation";
import { dragFocus, photoOverflow } from "../chat/wallpaper-logic";
import {
  type PickedPhoto,
  pickedWallpaperPhoto,
  rememberWallpaperPhoto,
  setPickedWallpaperPhoto,
} from "../chat/wallpaper-photo";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader } from "../shared/parts";
import { ChatPreview, SAMPLE_HUE } from "./ChatLookPage";

/** The dim slider's thumb, as Text size's. */
const THUMB = 26;
/** The dim's label and a screen reader's step: 5 points of darkness. */
const DIM_STEPS = 20;

const clamp = (v: number, lo: number, hi: number) => {
  "worklet";
  return v < lo ? lo : v > hi ? hi : v;
};

/**
 * How dark the photo goes in the dark theme (0 to `MAX_PHOTO_DIM`), live under the finger: the thumb follows it one to
 * one on the UI thread, a tap jumps there; the percent beside the label moves in 5-point steps.
 */
function DimSlider({ dim }: { dim: SharedValue<number> }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const width = useSharedValue(0);
  const [measured, setMeasured] = useState(false);
  const [step, setStep] = useState(Math.round(DEFAULT_PHOTO_DIM * DIM_STEPS));
  useAnimatedReaction(
    () => Math.round(dim.get() * DIM_STEPS),
    (now, before) => {
      if (now !== before) scheduleOnRN(setStep, now);
    },
  );
  const follow = (px: number) => {
    "worklet";
    const room = Math.max(1, width.get() - THUMB);
    dim.set((clamp(px - THUMB / 2, 0, room) / room) * MAX_PHOTO_DIM);
  };
  const pan = usePanGesture({
    // Sideways only, as Text size's: a drag that goes up or down isn't the slider's.
    activeOffsetX: [-4, 4],
    failOffsetY: [-12, 12],
    maxPointers: 1,
    onActivate: (e) => {
      "worklet";
      follow(e.x);
    },
    onUpdate: (e) => {
      "worklet";
      follow(e.x);
    },
  });
  const tap = useTapGesture({
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      follow(e.x);
    },
  });
  const gesture = useExclusiveGestures(pan, tap);
  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: (dim.get() / MAX_PHOTO_DIM) * Math.max(0, width.get() - THUMB) }],
  }));
  // A bar with no children out of the flow: its width moves nothing else.
  const filled = useAnimatedStyle(() => ({ width: (dim.get() / MAX_PHOTO_DIM) * Math.max(0, width.get() - THUMB) }));
  const percent = formatPercent(i18n.language || "en", (step * 100) / DIM_STEPS);
  const nudge = (by: number) => dim.set(clamp(dim.get() + by / DIM_STEPS, 0, MAX_PHOTO_DIM));
  return (
    <View>
      <View style={styles.dimHead}>
        <Text variant="subhead" style={styles.semibold}>
          {t("settings.account.chat.wallpaper.dim")}
        </Text>
        <Text variant="subhead" tone="faint">
          {percent}
        </Text>
      </View>
      <GestureDetector gesture={gesture}>
        <View
          style={styles.track}
          onLayout={(e) => {
            width.set(e.nativeEvent.layout.width);
            setMeasured(true);
          }}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={t("settings.account.chat.wallpaper.dim")}
          accessibilityValue={{ text: percent }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? 1 : -1)}
        >
          <View style={[styles.rail, { backgroundColor: c.line2 }]} />
          {measured ? (
            <>
              <Animated.View style={[styles.railOn, { backgroundColor: c.ink }, filled]} />
              <Animated.View style={[styles.thumb, { borderColor: c.line2 }, thumb]} />
            </>
          ) : null}
        </View>
      </GestureDetector>
    </View>
  );
}

/**
 * A photo's preview, full screen (after the system's library): a conversation over it as it will look, the photo
 * dragged to choose the part that shows (its point of interest, kept on screen whatever the screen's size), and in the
 * dark theme how dark it goes. "Use this photo" sends it, saves it as the background and goes back to Background.
 */
function PhotoPreview({ photo }: { photo: PickedPhoto }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { colors, scheme } = useTheme();
  const dark = scheme === "dark";
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { orgId, org } = useOrg();
  const prefs = org?.chatPrefs;
  const upload = useUploadWallpaperPhoto(orgId);
  const setPrefs = useSetChatPrefs(orgId);
  const setOwn = useSetConversationWallpaper(orgId);
  const dir = useDirectory();
  const dms = useDms(orgId);
  const { target } = photo;
  const one = "channelId" in target ? target.channelId : null;
  const dmRow = one ? dms.data?.find((d) => d.channelId === one) : undefined;
  const dm = one ? Boolean(dmRow) : true;
  const agent = dmRow?.with.type === "agent" ? dir.agentById.get(dmRow.with.id) : undefined;
  const color: AgentColorName = agent ? agentLook(agent).color : SAMPLE_HUE;
  const { style, tone } = chatLookOf(prefs, dm, isPersonal(org), "phone");
  const strength = wallpaperStrength(style === "bubbles");
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [dockHeight, setDockHeight] = useState(0);
  const [sending, setSending] = useState(false);
  const cover = photoOverflow(photo.image.width(), photo.image.height(), box.width, box.height);
  // Where the photo's point of interest is (0–1 each way), how far it runs past the screen, and how dark it goes.
  const fx = useSharedValue(0.5);
  const fy = useSharedValue(0.5);
  const fromX = useSharedValue(0.5);
  const fromY = useSharedValue(0.5);
  const overX = useSharedValue(0);
  const overY = useSharedValue(0);
  const dim = useSharedValue(DEFAULT_PHOTO_DIM);
  useEffect(() => {
    overX.set(cover.x);
    overY.set(cover.y);
  }, [cover.x, cover.y, overX, overY]);
  const imageX = useDerivedValue(() => -overX.get() * fx.get());
  const imageY = useDerivedValue(() => -overY.get() * fy.get());
  const pan = usePanGesture({
    maxPointers: 1,
    // Clear of the screen's left edge: the system's swipe back starts there.
    hitSlop: { left: -24 },
    onActivate: () => {
      "worklet";
      fromX.set(fx.get());
      fromY.set(fy.get());
    },
    onUpdate: (e) => {
      "worklet";
      fx.set(dragFocus(fromX.get(), e.translationX, overX.get()));
      fy.set(dragFocus(fromY.get(), e.translationY, overY.get()));
    },
  });
  const onBox = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== box.width || height !== box.height) setBox({ width, height });
  };
  const page = WALLPAPER_PAGE[scheme];
  const unit = (v: number) => Math.round(clamp(v, 0, 1) * 1000) / 1000;

  const choose = async () => {
    if (sending) return;
    setSending(true);
    try {
      const { url } = await upload.mutateAsync({ imageBase64: photo.base64, contentType: photo.contentType });
      // The conversation draws it from this copy, without reading it back.
      rememberWallpaperPhoto(url, photo.image);
      const wallpaper: Wallpaper = { kind: "photo", url, dim: unit(dim.get()), x: unit(fx.get()), y: unit(fy.get()) };
      if (one) await setOwn.mutateAsync({ channelId: one, wallpaper });
      else await setPrefs.mutateAsync({ wallpaper });
      haptics.success();
      goBack();
    } catch {
      setSending(false);
      toast({ title: t("settings.account.chat.wallpaper.failed"), icon: "x" });
    }
  };

  const chooseLabel = sending
    ? t("settings.account.chat.wallpaper.sending")
    : t("settings.account.chat.wallpaper.usePhoto");
  return (
    <View style={[styles.fill, { backgroundColor: page }]}>
      {focused ? <StatusBar style="light" /> : null}
      <PushedHeader
        title={
          <Text variant="body" style={styles.title}>
            {t("settings.account.chat.wallpaper.preview")}
          </Text>
        }
        plate
      />
      <GestureDetector gesture={pan}>
        <View style={StyleSheet.absoluteFill} onLayout={onBox}>
          {box.width > 0 ? (
            <Canvas style={StyleSheet.absoluteFill}>
              <Image image={photo.image} x={imageX} y={imageY} width={cover.width} height={cover.height} fit="fill" />
              {dark ? <Fill color="black" opacity={dim} /> : null}
              {strength < 1 ? <Fill color={page} opacity={1 - strength} /> : null}
            </Canvas>
          ) : null}
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.rows, { top: headerHeight + 8, bottom: dockHeight + 16 }]}
          >
            <View style={[styles.day, { backgroundColor: colors.glass, borderColor: colors.line2 }]}>
              <Text variant="footnote" tone="muted" style={styles.semibold}>
                {dayLabel(t, i18n.language || "en", new Date().toISOString())}
              </Text>
            </View>
            <ChatPreview style={style} tone={tone} size={textSizeOf(prefs)} dm={dm} color={color} bare />
          </View>
        </View>
      </GestureDetector>
      <View
        style={[styles.dockAt, { bottom: Math.max(insets.bottom, 12) }]}
        onLayout={(e) => setDockHeight(e.nativeEvent.layout.height + Math.max(insets.bottom, 12))}
      >
        <Glass liquid interactive={false} style={styles.dock}>
          {dark ? <DimSlider dim={dim} /> : null}
          <Text variant="footnote" tone="muted" style={styles.hint}>
            {t("settings.account.chat.wallpaper.dragHint")}
          </Text>
          <Button variant="primary" wide label={chooseLabel} loading={sending} onPress={() => void choose()} />
        </Glass>
      </View>
    </View>
  );
}

/** The photo picked on Background (`pickWallpaperPhoto`); with none (the app came back to this screen), back to Background. */
export function WallpaperPhotoPage() {
  const [photo] = useState(pickedWallpaperPhoto);
  useEffect(() => {
    if (!photo) goBack();
    // Gone with the screen: a photo is a few megabytes.
    return () => setPickedWallpaperPhoto(null);
  }, [photo]);
  return photo ? <PhotoPreview photo={photo} /> : null;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // The system bar's own title weight, legible on any photo.
  title: { color: "#ffffff", fontWeight: "600", textShadowColor: "rgba(0, 0, 0, 0.35)", textShadowRadius: 10 },
  rows: { position: "absolute", left: 0, right: 0, justifyContent: "flex-end", gap: 14 },
  day: {
    alignSelf: "center",
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
  },
  semibold: { fontWeight: "600" },
  dockAt: { position: "absolute", left: 12, right: 12 },
  dock: { borderRadius: 28, padding: 16, gap: 14 },
  hint: { textAlign: "center" },
  dimHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 },
  track: { height: 36, justifyContent: "center" },
  rail: { position: "absolute", left: THUMB / 2, right: THUMB / 2, height: 3, borderRadius: 2 },
  railOn: { position: "absolute", left: THUMB / 2, height: 3, borderRadius: 2 },
  thumb: {
    position: "absolute",
    left: 0,
    width: THUMB,
    height: THUMB,
    borderTopLeftRadius: 9,
    borderTopRightRadius: 9,
    borderBottomRightRadius: 9,
    borderBottomLeftRadius: 3,
    backgroundColor: "#ffffff",
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: "0px 2px 6px 0px rgba(23, 23, 22, 0.22)",
  },
});
