import { useEventListener } from "expo";
import { type VideoPlayer as Player, useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet, View } from "react-native";
import { Icon, PressScale } from "@/ui";
import { useMessageCardCorners } from "../chat/look";
import { useColors } from "../shared/hooks";
import { videoClock, videoHeight } from "./logic";

/**
 * Android draws a video on a SurfaceView by default, a window of its own that ignores the rounded corners it sits in
 * and lags behind a moving or shrinking parent (the viewer's pull to close); a TextureView is drawn with the views
 * around it. iOS ignores the prop.
 */
const SURFACE = "textureView";

/** Only one video plays at a time: starting one pauses the one before. */
let current: Player | null = null;
function claim(player: Player) {
  if (current && current !== player) {
    try {
      current.pause();
    } catch {
      // That player was already released with its screen.
    }
  }
  current = player;
}

export interface VideoPlayerProps {
  /** Where it plays from, with the session when the link is ours. */
  source: { uri: string; headers?: Record<string, string> };
  name: string;
  /** Its width in the message (one shape, the video whole in it). */
  width?: number;
  /** An inline video's tap: opens it in the picture viewer, where it plays. */
  onOpen?: () => void;
  /** It can't play on this device (a format it lacks): the caller shows the file's card instead. */
  onFailed?: () => void;
}

/**
 * A video. In a message, its first frame in a picture's shape with a play key and its length in a small badge (no name
 * over it, as a picture has none); a tap opens it in the picture viewer (`ViewerVideo`), where the system's own player
 * plays it at once with the platform's controls (play, the timeline to drag, full screen and back out of it, AirPlay),
 * so it feels like every other video on the phone, with no controls of ours to get stuck behind.
 */
export function VideoPlayer({ source, name, width = 300, onOpen, onFailed }: VideoPlayerProps) {
  return <InlineVideo source={source} name={name} width={width} onOpen={onOpen} onFailed={onFailed} />;
}

/** In a message: the first frame, the play key and the length; nothing plays here. */
function InlineVideo({
  source,
  name,
  width,
  onOpen,
  onFailed,
}: {
  source: VideoPlayerProps["source"];
  name: string;
  width: number;
  onOpen?: (() => void) | undefined;
  onFailed?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const c = useColors();
  // In a message, the corners every card there has, as the picture's beside it (its loading frame had them).
  const cardCorners = useMessageCardCorners();
  // Silent and still: it is here only for its first frame and its length.
  const player = useVideoPlayer(source, (p) => {
    p.muted = true;
  });
  const [duration, setDuration] = useState(0);
  useEventListener(player, "sourceLoad", ({ duration: d }) => setDuration(d));
  useEventListener(player, "statusChange", ({ status }) => {
    if (status === "error") onFailed?.();
  });
  const length = duration > 0 ? videoClock(duration) : "";
  return (
    // Opening it is navigation, as opening a picture: the press shows it, no tap.
    <PressScale
      haptic={false}
      onPress={onOpen}
      disabled={!onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${t("mobile.files.video.play")}: ${name}${length ? `, ${length}` : ""}`}
      style={[
        styles.inline,
        { width, height: videoHeight(width), backgroundColor: c.sunken, borderColor: c.line2 },
        cardCorners,
      ]}
    >
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="contain"
        allowsPictureInPicture={false}
        surfaceType={SURFACE}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.center} pointerEvents="none">
        <View style={[styles.big, { backgroundColor: c.raised }]}>
          <Icon name="play" size={24} color={c.ink} />
        </View>
      </View>
      {length ? (
        // The length as a video on its way up shows it (`MessageFiles`): a play mark and the time on a dark pill.
        <View style={styles.length} pointerEvents="none">
          <Icon name="play" size={9} color="#fff" />
          <RNText style={styles.lengthText}>{length}</RNText>
        </View>
      ) : null}
    </PressScale>
  );
}

/**
 * A video in the picture viewer (`ImageViewer`), among the pictures: the system's player with the platform's controls
 * (the timeline, full screen and back out of it, AirPlay), playing while its page is the one in sight and paused when
 * the person swipes on. `onFailed`: this phone can't play it.
 */
export function ViewerVideo({
  source,
  name,
  active,
  onFailed,
}: {
  source: VideoPlayerProps["source"];
  name: string;
  active: boolean;
  onFailed: () => void;
}) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
  });
  useEffect(() => {
    try {
      if (active) player.play();
      else player.pause();
    } catch {
      // Released with its page.
    }
  }, [active, player]);
  useEventListener(player, "playingChange", ({ isPlaying }) => {
    if (isPlaying) claim(player);
  });
  useEventListener(player, "statusChange", ({ status }) => {
    if (status === "error") onFailed();
  });
  useEffect(
    () => () => {
      if (current === player) current = null;
    },
    [player],
  );
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
      allowsPictureInPicture={false}
      surfaceType={SURFACE}
      accessibilityLabel={name}
      style={StyleSheet.absoluteFill}
    />
  );
}

/** A video on the phone at its first frame (picked, or on its way up): a silent player that never plays, covering. */
export function VideoFirstFrame({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri }, (p) => {
    p.muted = true;
  });
  return (
    <VideoView
      player={player}
      nativeControls={false}
      contentFit="cover"
      allowsPictureInPicture={false}
      surfaceType={SURFACE}
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    />
  );
}

const styles = StyleSheet.create({
  // A picture's shape in a message (`MessageFiles`' `shot`): rounded, a hairline, its frame whole on the gray.
  inline: { borderRadius: 14, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  big: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 3,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  length: {
    position: "absolute",
    left: 8,
    bottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  lengthText: { color: "#fff", fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
