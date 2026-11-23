import { useArtifact } from "@agenteschat/client";
import { keepWhole } from "@agenteschat/client/lib/format";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, type LayoutChangeEvent, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureDetector, GestureHandlerRootView, usePanGesture } from "react-native-gesture-handler";
import PagerView from "react-native-pager-view";
import Animated, {
  cancelAnimation,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { Icon, type IconName, PressScale, SCREEN_X, Text, useTheme } from "@/ui";
import { useDirectory, useOrgId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { savedAt, useFileActions, useSavedWhen } from "./actions";
import { decodeFileList, fileInfo, pageStep } from "./logic";
import { useRemoteFile } from "./source";
import { ViewerVideo } from "./VideoPlayer";
import { tellViewerPlace } from "./viewer-place";
import { PageWait, ZoomPicture } from "./ZoomPicture";
import { awaySpeed, pullCloses, pullDirection, pulledPlacement, pullProgress, type Size } from "./zoom";

/**
 * Pictures and videos, full screen, as the phone's own photos: one viewer for both, wherever they open from (a
 * message, the Drive, a file's link). Black, the name, "2 de 4" and who sent it on top; pinch to zoom, double tap to
 * zoom in at that spot or back out (`ZoomPicture`: the system's own zoom on iOS); a video plays in the system's player
 * between the bars, while it is the one in sight; swipe between them on the system's pager, a little black between
 * them as they slide, or ‹ › on the sides; pull down (or up) to close, the picture or video under the finger, smaller
 * as it goes, as the black fades, and let go where it would carry on far enough (a flick or a long pull) it leaves at
 * its own speed as the viewer closes, else it springs back from that speed; and Compartilhar, Enviar cópia, Salvar em
 * Fotos, Ver no Drive at the bottom (the file screen's words and icons for the same actions), the file's only actions
 * (no "…" repeating them). A tap on a picture hides and shows the bars;
 * zooming in hides them. With reduced motion a closing picture fades instead of flying off.
 */
export function ImageViewer({
  files: rawFiles,
  at,
  from,
}: {
  files: string | string[] | undefined;
  at: string | undefined;
  /** The stack it opened from, told where the person stops. */
  from?: string | undefined;
}) {
  return (
    // Gestures get their own root in the modal (the app's sits under it). Toasts need none: the app's draw above any
    // screen, a modal included.
    <GestureHandlerRootView style={styles.screen}>
      <Viewer rawFiles={rawFiles} at={at} from={from} />
    </GestureHandlerRootView>
  );
}

const WHITE = "#fff";
const DIM = "rgba(255,255,255,0.6)";
const PLATE = "rgba(255,255,255,0.14)";
/** ‹ and ›'s plate: they sit on the picture itself, and a white chevron on a light plate vanishes on a light picture. */
const SCRIM = "rgba(0,0,0,0.45)";
/** The round buttons over the picture. */
const ROUND = 44;
/** The black between two pictures as they slide. */
const GAP = 20;
/** A pull let go short of closing: back fast from the speed it was let go at, with the slightest bounce (it was thrown). */
const BACK_SPRING = { stiffness: 700, damping: 50, mass: 1 };
/** A pull that closes: the picture carries on the way it was going, at the speed it left the finger. */
const AWAY_SPRING = { stiffness: 180, damping: 26, mass: 1, overshootClamping: true };
/**
 * A pull that closes with reduced motion: the picture fades where it was let go, as the screen does. An opacity
 * change, kept with reduced motion (the system setting would otherwise skip it).
 */
const FADE_OUT = { duration: 180, reduceMotion: ReduceMotion.Never };

function Viewer({
  rawFiles,
  at,
  from,
}: {
  rawFiles: string | string[] | undefined;
  at: string | undefined;
  from: string | undefined;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const savedWhen = useSavedWhen();
  const insets = useSafeAreaInsets();
  const { reducedMotion } = useTheme();
  const { width, height } = useWindowDimensions();
  const screen = useMemo(() => ({ width, height }), [width, height]);
  const pager = useRef<PagerView>(null);
  const files = decodeFileList(rawFiles);
  const first = Math.min(Math.max(Number(at) || 0, 0), Math.max(files.length - 1, 0));
  const [index, setIndex] = useState(first);
  const [zoomed, setZoomed] = useState(false);
  const [paging, setPaging] = useState(false);
  const [chrome, setChrome] = useState(true);
  // How tall the bars are: a video sits between them, its own controls clear of ours.
  const [bars, setBars] = useState({ top: 0, bottom: 0 });
  // The pull to close, in finger travel (the picture follows it exactly down and up, loosely sideways), and how far a
  // closing picture carried on.
  const pullX = useSharedValue(0);
  const pullY = useSharedValue(0);
  const away = useSharedValue(0);
  // Closing once: a closing picture takes no other pull, and the viewer is one step back, never two.
  const leaving = useSharedValue(false);
  const drag = useDerivedValue(() => pullY.value + away.value);
  const current = files[index];
  const detail = useArtifact(orgId, current?.id ?? null, current?.version).data;
  const actions = useFileActions(detail);
  const closed = useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    goBack();
  }, []);
  const currentId = current?.id;
  useEffect(() => {
    if (from && currentId) tellViewerPlace(from, currentId);
  }, [from, currentId]);

  // Zoomed in, the pager holds still (the fingers move the picture), the side buttons step aside and the bars go.
  const onZoom = useCallback((now: boolean) => {
    setZoomed(now);
    if (now) setChrome(false);
  }, []);
  const onTap = useCallback(() => setChrome((v) => !v), []);
  // A video's page keeps the bars: its taps are its own controls'.
  const showChrome = useCallback(() => setChrome(true), []);

  const prev = pageStep(index, -1, files.length);
  const next = pageStep(index, 1, files.length);
  // The side buttons: the pager slides there, as a swipe would.
  const turn = (to: number | null) => {
    if (to === null) return;
    if (reducedMotion) pager.current?.setPageWithoutAnimation(to);
    else pager.current?.setPage(to);
  };

  const backdrop = useAnimatedStyle(() => ({ opacity: 1 - pullProgress(drag.value, height) }));

  const info = detail ? fileInfo(detail) : null;
  const author = detail ? dir.nameOf(detail.createdBy) : "";
  const place = files.length > 1 ? t("mobile.files.place", { index: index + 1, count: files.length }) : "";
  const sub = detail
    ? [place, author, savedWhen(savedAt(detail))].filter(Boolean).map(keepWhole).join(" · ")
    : keepWhole(place);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" hidden={!chrome} animated />
      <Animated.View style={[StyleSheet.absoluteFill, styles.black, backdrop]} />
      <PagerView
        ref={pager}
        // As wide as the screen and the gap: each page holds its picture at the screen's width, the gap's black on
        // either side, seen only as they slide.
        style={[styles.pager, { width: width + GAP, marginLeft: -GAP / 2 }]}
        initialPage={first}
        scrollEnabled={!zoomed}
        overdrag
        offscreenPageLimit={1}
        onPageSelected={(e) => {
          setIndex(Math.round(e.nativeEvent.position));
          setZoomed(false);
        }}
        onPageScrollStateChanged={(e) => setPaging(e.nativeEvent.pageScrollState !== "idle")}
      >
        {files.map((f, i) => (
          <View key={`${f.id}@${f.version ?? ""}`} style={styles.page} collapsable={false}>
            {/* The one in sight and one each side: they load as they come near. */}
            {Math.abs(i - index) <= 1 ? (
              <Page
                id={f.id}
                {...(f.version !== undefined ? { version: f.version } : {})}
                screen={screen}
                bars={bars}
                active={i === index}
                paging={paging}
                pullX={pullX}
                pullY={pullY}
                away={away}
                leaving={leaving}
                onTap={onTap}
                onZoom={onZoom}
                onVideo={showChrome}
                onClose={close}
              />
            ) : null}
          </View>
        ))}
      </PagerView>

      <Chrome
        visible={chrome}
        drag={drag}
        style={[styles.top, { paddingTop: insets.top + 8 }]}
        onHeight={(top) => setBars((b) => (b.top === top ? b : { ...b, top }))}
      >
        {/* A shade behind the bar, fading into the picture past it: the name and × read over any picture, and the
            picture's edge melts into the black above it instead of meeting it in a line. */}
        <LinearGradient pointerEvents="none" colors={SHADE_DOWN} locations={SHADE_STOPS} style={styles.shadeTop} />
        {/* × on the left: the file's actions are the row at the bottom, never repeated in a "…" here. */}
        <Round icon="x" label={t("mobile.common.close")} onPress={close} />
        {/* The name and its line in the bar's middle, as a pushed screen's title and subtitle: one line each, a long
            name shortened in its middle so its end (the kind of file) stays. */}
        <View style={styles.title}>
          <Text variant="body" style={[styles.bold, { color: WHITE }]} numberOfLines={1} ellipsizeMode="middle">
            {info?.name ?? ""}
          </Text>
          {sub ? (
            <Text variant="footnote" style={[styles.titleLine, { color: DIM }]} numberOfLines={1}>
              {sub}
            </Text>
          ) : null}
        </View>
        {/* As wide as the ×, so the title stands in the screen's middle. */}
        <View pointerEvents="none" style={styles.round} />
      </Chrome>

      {/* Gone while zoomed, as the swipe is: the fingers move the picture then. */}
      {files.length > 1 ? (
        <Chrome visible={chrome && !zoomed} drag={drag} style={[styles.sides, { top: height / 2 - ROUND / 2 }]}>
          {prev !== null ? (
            <View style={[styles.side, { left: insets.left + 12 }]}>
              <Round icon="left" label={t("mobile.files.previous")} plate={SCRIM} onPress={() => turn(prev)} />
            </View>
          ) : null}
          {next !== null ? (
            <View style={[styles.side, { right: insets.right + 12 }]}>
              <Round icon="right" label={t("mobile.files.next")} plate={SCRIM} onPress={() => turn(next)} />
            </View>
          ) : null}
        </Chrome>
      ) : null}

      <Chrome
        visible={chrome}
        drag={drag}
        style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]}
        onHeight={(bottom) => setBars((b) => (b.bottom === bottom ? b : { ...b, bottom }))}
      >
        <LinearGradient pointerEvents="none" colors={SHADE_UP} locations={SHADE_STOPS} style={styles.shadeBottom} />
        <View style={styles.actions}>
          {detail?.inDrive !== false ? (
            <Action icon="person" label={t("share.button")} disabled={!detail} onPress={actions.shareSheet} />
          ) : null}
          <Action
            icon="share"
            label={t("mobile.files.sendCopy")}
            busy={actions.busy === "share"}
            disabled={!detail}
            onPress={actions.share}
          />
          <Action
            icon="photos"
            label={t("mobile.files.savePhotos")}
            busy={actions.busy === "photos"}
            disabled={!detail}
            onPress={actions.savePhotos}
          />
          <Action icon="drive" label={t("mobile.files.drive")} disabled={!detail} onPress={actions.drive} />
        </View>
      </Chrome>
    </View>
  );
}

/**
 * One page: a picture (`ZoomPicture`) or a video (`PageVideo`, between the bars, playing while in sight) and, on the
 * one in sight at 1×, the pull to close, there from the first frame: a page still loading, or one that couldn't, is
 * swiped away as a picture is. The picture stays under the finger (`pulledPlacement`) and can be caught again while it
 * springs back; let go, where it would come to rest decides (`pullCloses`), and it leaves or springs back from the
 * speed it was let go at.
 */
function Page({
  id,
  version,
  screen,
  bars,
  active,
  paging,
  pullX,
  pullY,
  away,
  leaving,
  onTap,
  onZoom,
  onVideo,
  onClose,
}: {
  id: string;
  version?: number;
  screen: Size;
  bars: { top: number; bottom: number };
  active: boolean;
  paging: boolean;
  pullX: SharedValue<number>;
  pullY: SharedValue<number>;
  away: SharedValue<number>;
  leaving: SharedValue<boolean>;
  onTap: () => void;
  onZoom: (zoomed: boolean) => void;
  onVideo: () => void;
  onClose: () => void;
}) {
  const orgId = useOrgId();
  const { reducedMotion } = useTheme();
  const artifact = useArtifact(orgId, id, version);
  const info = artifact.data ? fileInfo(artifact.data) : null;
  // Known once its details load (a picture when they can't).
  const video = info ? info.view === "video" : artifact.isError ? false : null;
  // A picture's link is the one the message or the Drive already holds, so it shows at once; a video reads its own.
  const link = useRemoteFile(orgId, video ? null : id, version);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (active && video) onVideo();
  }, [active, video, onVideo]);
  const zoomChanged = useCallback(
    (now: boolean) => {
      setZoomed(now);
      if (active) onZoom(now);
    },
    [active, onZoom],
  );
  // Where a pull caught mid-spring started from, so the picture stays under the finger; the spot the finger took, from
  // the picture's center, which the picture shrinks around; and how much of it shows (it fades out with reduced motion).
  const from = useSharedValue({ x: 0, y: 0 });
  const grab = useSharedValue({ x: 0, y: 0 });
  const shown = useSharedValue(1);
  const pull = usePanGesture({
    enabled: active && !zoomed && !paging,
    activeOffsetY: [-10, 10],
    failOffsetX: [-10, 10],
    maxPointers: 1,
    onActivate: (e) => {
      "worklet";
      const resting = Math.abs(pullX.value) < 0.5 && Math.abs(pullY.value) < 0.5;
      cancelAnimation(pullX);
      cancelAnimation(pullY);
      from.value = { x: pullX.value, y: pullY.value };
      // From rest, where the finger is (in the window, as the picture fills it). Caught mid-spring, the spot it took
      // before, so the picture doesn't jump.
      if (resting)
        grab.value = {
          x: e.absoluteX - e.translationX - screen.width / 2,
          y: e.absoluteY - e.translationY - screen.height / 2,
        };
    },
    onUpdate: (e) => {
      "worklet";
      if (leaving.value) return;
      pullX.value = from.value.x + e.translationX;
      pullY.value = from.value.y + e.translationY;
    },
    onDeactivate: (e) => {
      "worklet";
      if (leaving.value) return;
      const travel = from.value.y + e.translationY;
      if (pullCloses(travel, e.velocityY, screen.height)) {
        leaving.value = true;
        if (reducedMotion) shown.value = withTiming(0, FADE_OUT);
        else {
          const direction = pullDirection(travel, e.velocityY);
          // The picture follows the finger 1:1 up and down, so the finger's speed is its own.
          away.value = withSpring(direction * screen.height, {
            ...AWAY_SPRING,
            velocity: awaySpeed(direction, e.velocityY),
          });
        }
        scheduleOnRN(onClose);
        return;
      }
      pullX.value = withSpring(0, { ...BACK_SPRING, velocity: e.velocityX });
      pullY.value = withSpring(0, { ...BACK_SPRING, velocity: e.velocityY });
    },
  });
  const placed = useAnimatedStyle(() => {
    if (!active) return { opacity: 1, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] };
    const at = pulledPlacement(pullX.value, pullY.value, screen, grab.value);
    return {
      opacity: shown.value,
      transform: [{ translateX: at.x }, { translateY: at.y + away.value }, { scale: at.scale }],
    };
  });
  const key = `${id}@${version ?? "latest"}`;
  return (
    <Animated.View style={[screen, placed]}>
      {video ? (
        <GestureDetector gesture={pull}>
          <View style={screen} collapsable={false}>
            <PageVideo
              id={id}
              {...(version !== undefined ? { version } : {})}
              name={info?.name ?? ""}
              active={active}
              bars={bars}
            />
          </View>
        </GestureDetector>
      ) : video === false && link.data ? (
        <ZoomPicture
          source={link.data}
          cacheKey={key}
          screen={screen}
          pull={pull}
          enabled={!paging}
          active={active}
          onTap={onTap}
          onZoom={zoomChanged}
          onRetry={() => void link.refetch()}
        />
      ) : (
        <GestureDetector gesture={pull}>
          <View style={screen} collapsable={false}>
            <PageWait
              failed={link.isError}
              retrying={link.isFetching}
              onRetry={() => {
                void link.refetch();
                if (artifact.isError) void artifact.refetch();
              }}
            />
          </View>
        </GestureDetector>
      )}
    </Animated.View>
  );
}

/**
 * A video's page: the system's player between the bars, playing while in sight, from a link of its own read once
 * (`once`), so the app coming back to the front, or a new link anywhere, never starts it over. One this phone can't
 * play says so (it can still be sent, shared or opened in the Drive below).
 */
function PageVideo({
  id,
  version,
  name,
  active,
  bars,
}: {
  id: string;
  version?: number;
  name: string;
  active: boolean;
  bars: { top: number; bottom: number };
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const link = useRemoteFile(orgId, id, version, { once: true });
  const [unplayable, setUnplayable] = useState(false);
  const source = useMemo(() => (link.data ? { uri: link.data.uri, headers: link.data.headers } : null), [link.data]);
  return (
    <View style={[styles.videoFrame, { top: bars.top, bottom: bars.bottom }]}>
      {unplayable ? (
        <View style={[StyleSheet.absoluteFill, styles.center, styles.cantPlay]}>
          <Icon name="play" size={30} color={DIM} />
          <Text variant="footnote" style={[styles.cantPlayText, { color: DIM }]}>
            {t("mobile.files.video.cantPlay")}
          </Text>
        </View>
      ) : source ? (
        <ViewerVideo
          key={`${id}@${version ?? "latest"}`}
          source={source}
          name={name}
          active={active}
          onFailed={() => setUnplayable(true)}
        />
      ) : (
        <PageWait icon="play" failed={link.isError} retrying={link.isFetching} onRetry={() => void link.refetch()} />
      )}
    </View>
  );
}

/** The bars: fade with a tap, and while the picture is dragged away. `onHeight`: how tall the bar is. */
function Chrome({
  visible,
  drag,
  style,
  onHeight,
  children,
}: {
  visible: boolean;
  drag: Readonly<SharedValue<number>>;
  style: object[];
  onHeight?: (height: number) => void;
  children: ReactNode;
}) {
  const shown = useSharedValue(1);
  useEffect(() => {
    shown.value = withTiming(visible ? 1 : 0, { duration: 180 });
  }, [visible, shown]);
  const anim = useAnimatedStyle(() => ({
    opacity: shown.value * (1 - Math.min(Math.abs(drag.value) / 80, 1)),
  }));
  return (
    <Animated.View
      pointerEvents={visible ? "box-none" : "none"}
      style={[...style, anim]}
      {...(onHeight ? { onLayout: (e: LayoutChangeEvent) => onHeight(Math.round(e.nativeEvent.layout.height)) } : {})}
    >
      {children}
    </Animated.View>
  );
}

function Round({
  icon,
  label,
  onPress,
  disabled = false,
  plate = PLATE,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  plate?: string;
}) {
  return (
    <PressScale
      to={0.9}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={[styles.round, { backgroundColor: plate }]}
      contentStyle={styles.center}
    >
      <Icon name={icon} size={20} color={WHITE} />
    </PressScale>
  );
}

function Action({
  icon,
  label,
  onPress,
  busy = false,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <PressScale
      to={0.92}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled }}
      style={styles.action}
      contentStyle={styles.actionIn}
    >
      <View style={[styles.circle, { backgroundColor: PLATE }]}>
        {busy ? <ActivityIndicator color={WHITE} /> : <Icon name={icon} size={20} color={WHITE} />}
      </View>
      <Text variant="caption" style={[styles.bold, styles.actionLabel, { color: WHITE }]} numberOfLines={2}>
        {label}
      </Text>
    </PressScale>
  );
}

/** The bars' shade: dark under their words, gone past them (it fades with the bars). */
const SHADE_DOWN = ["rgba(0,0,0,0.72)", "rgba(0,0,0,0.4)", "rgba(0,0,0,0)"] as const;
const SHADE_UP = ["rgba(0,0,0,0)", "rgba(0,0,0,0.4)", "rgba(0,0,0,0.78)"] as const;
const SHADE_STOPS = [0, 0.55, 1] as const;
/** How far the shade runs past a bar into the picture. */
const SHADE_PAST = 56;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  black: { backgroundColor: "#000" },
  pager: { flex: 1 },
  page: { alignItems: "center", justifyContent: "center" },
  // A video between the bars, the screen's width.
  videoFrame: { position: "absolute", left: 0, right: 0 },
  cantPlay: { gap: 10, paddingHorizontal: 32 },
  cantPlayText: { textAlign: "center" },
  top: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  title: { flex: 1, minWidth: 0, alignItems: "center" },
  titleLine: { textAlign: "center" },
  shadeTop: { position: "absolute", top: 0, left: 0, right: 0, bottom: -SHADE_PAST },
  shadeBottom: { position: "absolute", top: -SHADE_PAST, left: 0, right: 0, bottom: 0 },
  bold: { fontWeight: "600" },
  round: { width: ROUND, height: ROUND, borderRadius: ROUND / 2 },
  center: { alignItems: "center", justifyContent: "center" },
  sides: { position: "absolute", left: 0, right: 0, height: ROUND },
  side: { position: "absolute", top: 0 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 6 },
  actions: { flexDirection: "row", gap: 8, paddingHorizontal: SCREEN_X, paddingTop: 10 },
  // Four actions share the row evenly, a long label on two lines under its circle (a 320-point screen included).
  action: { flex: 1 },
  actionIn: { alignItems: "center", gap: 6 },
  actionLabel: { textAlign: "center" },
  circle: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
});
