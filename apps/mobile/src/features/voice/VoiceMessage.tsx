import type { Message } from "@agenteschat/client";
import { voiceAudioGone, voiceAudioUrl, voiceClock, voiceExpired, voiceOf } from "@agenteschat/client/lib/voice";
import { Skia } from "@shopify/react-native-skia";
import type { AudioSource } from "expo-audio";
import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { appHeaders, authedFetch, lastCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { Icon, PressScale, Text, TOUCH } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { BAR_HANDLE, BAR_WAVE_H, nextSpeed, spokenWords, waveAt } from "./logic";
import {
  lengthOf,
  placeOf,
  playingId,
  seekPlayback,
  setPlaybackSpeed,
  startingId,
  startPlayback,
  stopPlayback,
  subscribePlace,
  subscribePlayback,
} from "./playback";
import { setVoiceSpeed, subscribeVoiceSpeed, voiceSpeed } from "./speed";
import { BarWave, barWave } from "./VoiceBars";

/** The speed chip, as the web's: one width for 1×, 1,5× and 2×, so nothing beside it moves as the speed goes round. */
const SPEED_H = 22;
const SPEED_W = 36;
/** The play button: big enough to hit at a glance, its glyph filled. */
const PLAY = 36;
/** Between the play button, the wave, the clock and the speed. */
const ROW_GAP = 12;
/** Past this many characters the first line is cut, so "Ver tudo" is offered without measuring the text. */
const ONE_LINE = 40;
/** The list recycles rows: what a message had open lives outside them (where a clip stands: `placeOf`). */
const opened = new Set<string>();
const expired = new Set<string>();

/**
 * A voice message: the audio is the message, with one line of its words under the wave, in the same card, and nowhere
 * else; a tap opens the rest there. A recording the server no longer keeps stays as a dimmed wave with its words.
 */
export const VoiceMessage = memo(function VoiceMessage({ message }: { message: Message }) {
  const orgId = useOrgId();
  const voice = voiceOf(message.meta);
  const words = useMemo(() => spokenWords(message), [message]);
  if (!voice) return null;
  const url = voiceAudioUrl(orgId, voice.clipId, serverUrl());
  return (
    <VoiceClip
      clipId={voice.clipId}
      rowKey={message.id}
      // Read at the press: the session's cookie as it is then.
      source={() => ({ uri: url, headers: appHeaders(lastCookie()) })}
      peaks={voice.peaks}
      durationMs={voice.durationMs}
      words={words}
      sending={Boolean(message.local)}
      expiredAtStart={voiceExpired(voice)}
      isGone={() => voiceAudioGone(url, authedFetch as typeof fetch)}
    />
  );
});

/**
 * The player of a sound, as a voice message draws it: play, the wave (a tap or a drag moves through it), the clock and
 * the speed every voice shares, with its words under it when it has some. An audio file plays in it too (`FileVoice`).
 */
export function VoiceClip({
  clipId,
  rowKey,
  source,
  peaks,
  durationMs: givenMs,
  words = null,
  sending = false,
  expiredAtStart = false,
  isGone,
  onFailed,
}: {
  /** The playback's id: one sound plays at a time, and each keeps its place. */
  clipId: string;
  /** What its words' open state is kept under, as the list recycles rows. */
  rowKey: string;
  source: () => AudioSource;
  peaks: readonly number[];
  /** 0 when not known yet: the player's own, once it has loaded. */
  durationMs: number;
  words?: string | null;
  sending?: boolean;
  expiredAtStart?: boolean;
  /** Asked when it fails: true when the server no longer keeps it (it dims). */
  isGone?: () => Promise<boolean>;
  /** Given: a sound that can't play hands its place back instead of offering to try again. */
  onFailed?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const learnt = useSyncExternalStore(subscribePlayback, () => lengthOf(clipId));
  const durationMs = givenMs > 0 ? givenMs : learnt;
  const playing = useSyncExternalStore(subscribePlayback, playingId) === clipId;
  // Asked to play and not moving yet: the button spins from the tap on.
  const starting = useSyncExternalStore(subscribePlayback, startingId) === clipId;
  const progress = useSharedValue(placeOf(clipId));
  // A finger on the wave: what the player says meanwhile doesn't move it (the two fought over the handle).
  const scrubbing = useSharedValue(false);
  const wave = useSharedValue(Skia.Path.Make());
  const [width, setWidth] = useState(0);
  // The clock, from the clip's place read whole once a second: its length while it has no place.
  const second = useSyncExternalStore(subscribePlace, () => {
    const at = placeOf(clipId);
    return at > 0 ? Math.floor((at * durationMs) / 1000) : -1;
  });
  const time = second < 0 ? durationMs : second * 1000;
  const rate = useSyncExternalStore(subscribeVoiceSpeed, voiceSpeed);
  const [gone, setGone] = useState(() => expired.has(clipId) || expiredAtStart);
  const [open, setOpen] = useState(() => opened.has(rowKey));
  const [broken, setBroken] = useState(false);

  // A recycled row takes on another message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the row shows another recording
  useEffect(() => {
    setGone(expired.has(clipId) || expiredAtStart);
    setOpen(opened.has(rowKey));
    setBroken(false);
  }, [clipId, rowKey]);
  // The wave follows its clip's place on every tick without a render (the UI thread draws it), from wherever it stands
  // as the row is drawn (a clip that kept playing while its row was away included); never under a scrubbing finger.
  useEffect(() => {
    progress.value = placeOf(clipId);
    return subscribePlace((id) => {
      if (id !== clipId || scrubbing.value) return;
      progress.value = placeOf(clipId);
    });
  }, [clipId, progress, scrubbing]);
  // A speed picked on any row, or while this one was still starting, reaches it where it plays.
  useEffect(() => {
    if (playing) setPlaybackSpeed(clipId, rate);
  }, [playing, rate, clipId]);
  useEffect(() => {
    if (width <= 0) return;
    wave.value = barWave(peaks, width, BAR_WAVE_H);
  }, [width, peaks, wave]);

  const lose = () => {
    expired.add(clipId);
    setGone(true);
    seekPlayback(clipId, 0);
  };
  const toggle = () => {
    // Playing, or still starting: a tap stops it.
    if (playing || starting) {
      stopPlayback();
      return;
    }
    setBroken(false);
    // It plays at once; only a player that failed asks the server why (a player says nothing of it): a recording the
    // server no longer keeps dims, anything else offers to try again (or hands its place back, `onFailed`).
    const failed = () => {
      if (onFailed) {
        onFailed();
        return;
      }
      void (isGone?.() ?? Promise.resolve(false)).then((yes) => (yes ? lose() : setBroken(true)));
    };
    void startPlayback({
      id: clipId,
      source: source(),
      durationMs,
      from: placeOf(clipId),
      speed: voiceSpeed(),
      onError: failed,
    }).catch(failed);
  };
  const seek = (at: number) => seekPlayback(clipId, at);
  // The finger let go (`at`: where, null when the scrub was taken away): the player goes there, then the wave follows
  // the player again.
  const endScrub = (at: number | null) => {
    if (at !== null) seekPlayback(clipId, at);
    scrubbing.value = false;
    if (at === null) progress.value = placeOf(clipId);
  };
  const cycle = () => setVoiceSpeed(nextSpeed(rate));
  const flip = () => {
    if (open) opened.delete(rowKey);
    else opened.add(rowKey);
    setOpen(!open);
  };

  const canPlay = !sending && !gone;
  const pan = usePanGesture({
    enabled: canPlay,
    // Sideways, and only once the finger clearly means it: a move up or down first fails it and the list scrolls.
    activeOffsetX: [-10, 10],
    failOffsetY: [-6, 6],
    onActivate: (e) => {
      "worklet";
      scrubbing.value = true;
      if (width > 0) progress.value = waveAt(e.x, width, BAR_HANDLE);
    },
    onUpdate: (e) => {
      "worklet";
      if (width > 0) progress.value = waveAt(e.x, width, BAR_HANDLE);
    },
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) {
        scheduleOnRN(endScrub, null);
        return;
      }
      // Where the finger let go, not the last frame drawn before it.
      const at = width > 0 ? waveAt(e.x, width, BAR_HANDLE) : progress.value;
      progress.value = at;
      scheduleOnRN(endScrub, at);
    },
  });
  const tap = useTapGesture({
    enabled: canPlay,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled || width <= 0) return;
      const at = waveAt(e.x, width, BAR_HANDLE);
      progress.value = at;
      scheduleOnRN(seek, at);
    },
  });
  const scrub = useExclusiveGestures(pan, tap);

  // The speed as the language writes it ("1,5×" in Portuguese).
  const speedFormat = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }),
    [i18n.language],
  );
  const more = words && !open && (words.length > ONE_LINE || words.includes("\n"));
  return (
    <View style={styles.box}>
      <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line }]}>
        <View style={styles.player}>
          {gone ? null : (
            <PressScale
              to={0.92}
              disabled={!canPlay}
              onPress={toggle}
              accessibilityRole="button"
              accessibilityLabel={playing || starting ? t("voice.stop") : t("voice.play")}
              accessibilityState={{ busy: starting }}
              // 36 drawn, the 44 a finger needs.
              hitSlop={(TOUCH - PLAY) / 2}
              style={[styles.play, { backgroundColor: canPlay ? c.ink : c.sunken }]}
            >
              <View style={styles.center}>
                {starting ? (
                  <ActivityIndicator size="small" color={c.bg} />
                ) : (
                  // The filled glyphs (a line one read thin); play a touch right, where its weight sits.
                  <View style={playing ? null : styles.playNudge}>
                    <Icon name={playing ? "pause" : "play"} size={17} filled color={canPlay ? c.bg : c.muted} />
                  </View>
                )}
              </View>
            </PressScale>
          )}
          <GestureDetector gesture={scrub}>
            <View style={[styles.wave, gone && styles.dim]} accessible={false}>
              <BarWave
                path={wave}
                progress={progress}
                on={c.ink}
                off={gone ? c.line2 : c.faint}
                onWidth={setWidth}
                height={BAR_WAVE_H}
                handle={!gone}
              />
            </View>
          </GestureDetector>
          {gone ? (
            <Text variant="caption" tone="faint" numberOfLines={1}>
              {t("voice.expired")}
            </Text>
          ) : (
            <Text variant="footnote" tone="muted" style={styles.time}>
              {voiceClock(time)}
            </Text>
          )}
          {canPlay ? (
            // The kit's press, as the play button beside it: the chip eases down under the finger.
            <PressScale
              to={0.92}
              onPress={cycle}
              accessibilityRole="button"
              accessibilityLabel={t("voice.speed")}
              accessibilityValue={{ text: `${speedFormat.format(rate)}×` }}
              // 22 drawn, the 44 a finger needs.
              hitSlop={(TOUCH - SPEED_H) / 2}
              style={[styles.speed, { backgroundColor: c.plate }]}
              contentStyle={styles.speedIn}
            >
              <Text variant="caption" tone="muted" style={styles.speedText}>
                {`${speedFormat.format(rate)}×`}
              </Text>
            </PressScale>
          ) : null}
        </View>
        {words ? (
          <Pressable
            onPress={flip}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={open ? t("voice.hideText") : t("voice.showText")}
            hitSlop={8}
            style={styles.words}
          >
            <Text variant="small" tone="muted" numberOfLines={open ? undefined : 1} selectable={open}>
              {words}
            </Text>
            {more ? (
              <Text variant="footnote" tone="faint" numberOfLines={1}>
                {t("mobile.voice.seeAll")}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
      </View>
      {broken ? (
        // Like a message that didn't go (MessageRow): why, then the way out.
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          hitSlop={14}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text variant="caption" tone="danger">
            {t("voice.cantPlay")}
          </Text>
          <Text variant="caption" tone="ink" style={styles.retry}>
            {t("common.retry")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6, maxWidth: 320 },
  // The web's voice card: 16 round, the corner cut at the bottom left.
  card: {
    gap: 6,
    paddingVertical: 8,
    paddingLeft: 10,
    paddingRight: 14,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  player: { flexDirection: "row", alignItems: "center", gap: ROW_GAP, minHeight: PLAY },
  play: { width: PLAY, height: PLAY, borderRadius: PLAY / 2 },
  playNudge: { marginLeft: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  wave: { flex: 1, minWidth: 0, height: BAR_WAVE_H, flexDirection: "row" },
  dim: { opacity: 0.5, marginLeft: 6 },
  time: { minWidth: 30, textAlign: "right", fontVariant: ["tabular-nums"] },
  speed: { width: SPEED_W, height: SPEED_H, borderRadius: 6 },
  speedIn: { alignItems: "center", justifyContent: "center" },
  speedText: { fontVariant: ["tabular-nums"], fontWeight: "700" },
  pressed: { opacity: 0.6 },
  retry: { fontWeight: "600", textDecorationLine: "underline" },
  // Under the wave, past the play button and the row's gap; "Ver tudo" on its own line below the words.
  words: { paddingLeft: PLAY + ROW_GAP, paddingBottom: 2, gap: 2 },
});
