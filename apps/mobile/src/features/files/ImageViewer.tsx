import { useArtifact } from "@agenteschat/client";
import { mediaKindOfArtifact } from "@agenteschat/client/lib/files";
import { keepWhole } from "@agenteschat/client/lib/format";
import { LinearGradient } from "expo-linear-gradient";
import { useNavigation } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { VideoPlayer as Player } from "expo-video";
import { type MutableRefObject, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { haptics, Icon, type IconName, PressScale, padPastFold, SCREEN_X, Text, useFoldRoom, useTheme } from "@/ui";
import { useSettled } from "../chat/screen/opening";
import { useMediaPins, useOpenFileTalk, useTalkFocus } from "../live-files/talk/hooks";
import {
  commentSelection,
  draftPin,
  type Mark,
  type MediaPin,
  picturePins,
  pinUnder,
  pointMark,
} from "../live-files/talk/logic";
import { PicturePins } from "../live-files/talk/PicturePins";
import { takeReveal, useRevealFor, useTalkAbout } from "../live-files/talk/store";
import { FileTalkLine } from "../live-files/talk/TalkLine";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { savedAt, useFileActions, useSavedWhen } from "./actions";
import { decodeFileList, fileInfo, pageStep } from "./logic";
import { useRemoteFile } from "./source";
import { ViewerVideo } from "./VideoPlayer";
import { tellViewerPlace } from "./viewer-place";
import { PageWait, ZoomPicture } from "./ZoomPicture";
import { awaySpeed, type PictureTap, pullCloses, pullDirection, pulledPlacement, type Size } from "./zoom";

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
 * zooming in hides them. With reduced motion a closing picture fades instead of flying off. A picture or a video has
 * its conversation (ADR 0208), as a live file does: its line over the actions, and its open comments pinned on a
 * picture (a tap on one opens the conversation there). The conversation is pushed over the viewer, its back coming
 * back to the picture: the viewer is a screen of the stack (faded in, black), not a modal, so what is pushed from it
 * shows over it. A touch held on a picture marks that point: the conversation opens about it ("About point 4 of the
 * image" over the composer), the person's pin left on the spot while the comment is unsent. From a video that has
 * played, its line opens the conversation about the moment it is at. `focusId`: a message of the conversation to open
 * at (a link or a notice), once the viewer is up.
 */
export function ImageViewer({
  files: rawFiles,
  at,
  from,
  focusId = null,
}: {
  files: string | string[] | undefined;
  at: string | undefined;
  /** The stack it opened from, told where the person stops. */
  from?: string | undefined;
  focusId?: string | null;
}) {
  return (
    // Gestures get their own root in the modal (the app's sits under it). Toasts need none: the app's draw above any
    // screen, a modal included.
    <GestureHandlerRootView style={styles.screen}>
      <Viewer rawFiles={rawFiles} at={at} from={from} focusId={focusId} />
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
/** A video that has played past this (seconds): its line opens the conversation about that moment. */
const PLAYED_S = 0.5;

function Viewer({
  rawFiles,
  at,
  from,
  focusId,
}: {
  rawFiles: string | string[] | undefined;
  at: string | undefined;
  from: string | undefined;
  focusId: string | null;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const savedWhen = useSavedWhen();
  const insets = useSafeAreaInsets();
  const { reducedMotion } = useTheme();
  const { width, height } = useWindowDimensions();
  const screen = useMemo(() => ({ width, height }), [width, height]);
  // Folded like a book (ADR 0212), the bottom bar's line and actions and the Comment hint keep to the half past the
  // fold; the picture passes under it, the buttons at the screen's edges stay where they are.
  const foldSide = useFoldRoom();
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
  // The page it is on, kept in its route: a message's line about this picture, tapped in its conversation pushed over
  // it, comes back here rather than opening a second viewer (`fileUnder`).
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setParams({ at: String(index) } as never);
  }, [navigation, index]);

  // ── The file's conversation (ADR 0208) ────────────────────────────────────────────────────────────────────────
  // A picture or a video (a PDF opens on its own screen); its comments, numbered as the conversation has them.
  const media = mediaKindOfArtifact(detail);
  const talkFile = media ? detail : undefined;
  const pins = useMediaPins(talkFile);
  const openTalk = useOpenFileTalk(talkFile);
  // A link or a notice named one of its messages: the conversation is pushed at it once the viewer is in.
  const settled = useSettled(false);
  useTalkFocus(talkFile, settled ? focusId : null);
  // The comment being written about a point: the person's pin on the spot, the number it will take, until it is sent.
  const meId = useMeId();
  const about = useTalkAbout(talkFile?.conversation?.channelId ?? "");
  const draft = useMemo(
    () => (talkFile ? draftPin(about, talkFile.id, meId ? { type: "user", id: meId } : null) : null),
    [about, talkFile, meId],
  );
  const openPin = useCallback((messageId: string) => openTalk({ messageId, selection: null }), [openTalk]);
  // A touch held on the picture marks the spot: the conversation opens about it, "About point 4 of the image".
  const markHere = useCallback(
    (where: { mark: Mark; time?: number }) => {
      if (!talkFile) return;
      haptics.medium();
      openTalk({ selection: commentSelection(pins, where, talkFile.shownVersion) });
    },
    [talkFile, pins, openTalk],
  );
  // The moment the video in sight is at (its page tells it): a played one's line opens the conversation about it.
  const videoClock = useRef<(() => number) | null>(null);
  const openLine = useCallback(() => {
    const time = media === "video" ? (videoClock.current?.() ?? 0) : 0;
    if (talkFile && time > PLAYED_S) openTalk({ selection: commentSelection(pins, { time }, talkFile.shownVersion) });
    else openTalk({ selection: null });
  }, [media, talkFile, pins, openTalk]);

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

  const info = detail ? fileInfo(detail) : null;
  const author = detail ? dir.nameOf(detail.createdBy) : "";
  const place = files.length > 1 ? t("mobile.files.place", { index: index + 1, count: files.length }) : "";
  const sub = detail
    ? [place, author, savedWhen(savedAt(detail))].filter(Boolean).map(keepWhole).join(" · ")
    : keepWhole(place);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" hidden={!chrome} animated />
      {/* Black under the pages: a screen of the stack, nothing of the one under it shows through as it is pulled. */}
      <View style={[StyleSheet.absoluteFill, styles.black]} />
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
                draft={i === index ? draft : null}
                videoClock={videoClock}
                onTap={onTap}
                onZoom={onZoom}
                onVideo={showChrome}
                onClose={close}
                onPin={openPin}
                onMark={markHere}
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
        {/* A space as wide as the ×, so the title stands in the screen's middle: the conversation's one way in is its
            line at the bottom (ADR 0208). */}
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
        style={[styles.bottom, { paddingBottom: insets.bottom + 14 }, foldSide ? padPastFold(foldSide, 0) : {}]}
        onHeight={(bottom) => setBars((b) => (b.bottom === bottom ? b : { ...b, bottom }))}
      >
        <LinearGradient pointerEvents="none" colors={SHADE_UP} locations={SHADE_STOPS} style={styles.shadeBottom} />
        {/* The file's conversation over its actions, as under a live file: a tap pushes it over the viewer. */}
        {talkFile ? <FileTalkLine file={talkFile} bare onOpen={openLine} /> : null}
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
 * speed it was let go at. A picture's open comments are pinned on it (ADR 0208): a tap on a pin opens its message,
 * a touch held on the picture marks that point (`onMark`, the draft's pin on it), any other tap shows or hides the bars.
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
  draft,
  videoClock,
  onTap,
  onZoom,
  onVideo,
  onClose,
  onPin,
  onMark,
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
  /** The comment being written about a point of this page's picture: its pin, on the page in sight. */
  draft: MediaPin | null;
  /** Where the page in sight tells the moment its video is at. */
  videoClock: MutableRefObject<(() => number) | null>;
  onTap: () => void;
  onZoom: (zoomed: boolean) => void;
  onVideo: () => void;
  onClose: () => void;
  onPin: (messageId: string) => void;
  onMark: (where: { mark: Mark; time?: number }) => void;
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
  // Its open comments' pins, on a picture (ADR 0208).
  const pins = useMediaPins(mediaKindOfArtifact(artifact.data) === "image" ? artifact.data : undefined);
  const shownPins = useMemo(() => picturePins(pins), [pins]);
  const tapped = useCallback(
    (at: PictureTap) => {
      // A pin under the finger opens its message; anywhere else the bars come and go.
      const pin = pinUnder(shownPins, at);
      if (pin) onPin(pin.messageId);
      else onTap();
    },
    [shownPins, onPin, onTap],
  );
  const held = useCallback(
    (at: PictureTap) => {
      const mark = pointMark(at);
      if (mark) onMark({ mark });
    },
    [onMark],
  );
  // A comment's line about a moment of this video opened it: it starts there, once.
  const waiting = useRevealFor(id);
  const [startAt, setStartAt] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!waiting || video === null) return;
    if (video && waiting.selection.time !== undefined) setStartAt(waiting.selection.time);
    takeReveal(id);
  }, [waiting, video, id]);
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
              startAt={startAt}
              videoClock={videoClock}
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
          onTap={tapped}
          onLongPress={active ? held : undefined}
          onZoom={zoomChanged}
          onRetry={() => void link.refetch()}
          overlay={
            shownPins.length > 0 || draft
              ? (zoom) => <PicturePins pins={shownPins} zoom={zoom} draft={draft} />
              : undefined
          }
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
 * play says so (it can still be sent, shared or opened in the Drive below). The frame is the system's player's whole
 * (its taps are its controls'); in sight, it tells the viewer the moment it is at (`videoClock`), which the line of its
 * conversation opens about once it has played (ADR 0208).
 */
function PageVideo({
  id,
  version,
  name,
  active,
  bars,
  startAt,
  videoClock,
}: {
  id: string;
  version?: number;
  name: string;
  active: boolean;
  bars: { top: number; bottom: number };
  /** The moment it starts from (a comment's). */
  startAt: number | undefined;
  videoClock: MutableRefObject<(() => number) | null>;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const link = useRemoteFile(orgId, id, version, { once: true });
  // Its player: the moment it is at, read when its conversation opens.
  const player = useRef<Player | null>(null);
  const ownPlayer = useCallback((p: Player | null) => {
    player.current = p;
  }, []);
  useEffect(() => {
    if (!active) return;
    const read = () => {
      try {
        return player.current?.currentTime ?? 0;
      } catch {
        // Released with its page.
        return 0;
      }
    };
    videoClock.current = read;
    return () => {
      if (videoClock.current === read) videoClock.current = null;
    };
  }, [active, videoClock]);
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
          startAt={startAt}
          onPlayer={ownPlayer}
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

/** A round button over the picture, on its light plate. */
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
