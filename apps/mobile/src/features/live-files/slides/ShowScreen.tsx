import { type LiveRoom, useLivePeers } from "@agenteschat/client";
import type { SlideView as SlideData } from "@agenteschat/live/slides";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import PagerView from "react-native-pager-view";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  Icon,
  type IconName,
  motion,
  PressScale,
  sidesPastFold,
  Text,
  useFoldRoom,
  useReducedMotion,
} from "@/ui";
import { goBack } from "@/ui/navigation";
import { useSideways } from "../../computer/useSideways";
import { liveClosed } from "../logic";
import { LiveUnavailable } from "../shared/LiveBar";
import { usePeerLook } from "../shared/peers";
import { useLiveDoc } from "../shared/useLiveDoc";
import { HereIsland } from "./Island";
import { fitSlide, shownSlides, showStart } from "./logic";
import { useFilePictures } from "./pictures";
import { SlideView } from "./SlideView";
import { useDeck } from "./useDeck";

/**
 * Presenting on the phone (ADR 0196 §9): the shown slides (hidden ones skipped) one at a time on black, fitted to the
 * screen, on the system's pager; the phone lies down for it (and stands up again with a button or when it ends). A tap
 * shows or hides the controls: ×, "3 / 12", ‹ ›, the slide's notes and turning the phone. While this person presents,
 * everyone in the file sees it ("Ada está apresentando · Seguir"); with `follow`, this screen goes with whoever
 * presents, until the person swipes themselves.
 */
export function ShowScreen({ id, at, follow }: { id: string; at: string | null; follow: number | null }) {
  const live = useLiveDoc(id, { kind: "slides" });
  const closed = liveClosed(live);
  const sideways = useSideways(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the screen opens.
  useEffect(() => {
    sideways.lieDown();
  }, []);
  if (closed)
    return (
      <View style={[styles.screen, styles.middle]}>
        <StatusBar hidden animated style="light" />
        <LiveUnavailable reason={closed} />
      </View>
    );
  return (
    <View style={styles.screen}>
      <StatusBar hidden animated style="light" />
      {live.room && live.loaded ? (
        <Show room={live.room} fileId={id} at={at} follow={follow} sideways={sideways} />
      ) : null}
    </View>
  );
}

const WHITE = "#ffffff";
const DIM = "rgba(255, 255, 255, 0.65)";
const SCRIM = "rgba(0, 0, 0, 0.5)";
const ROUND = 44;
/** The controls fade on the theme's base duration. */
const CHROME = { duration: motion.base, easing: motion.easeOut };

function Show({
  room,
  fileId,
  at,
  follow,
  sideways,
}: {
  room: LiveRoom;
  fileId: string;
  at: string | null;
  follow: number | null;
  sideways: ReturnType<typeof useSideways>;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  // Folded like a book (ADR 0212), ‹, the notes and › keep together to the half past the fold, out of its curve; the
  // top bar's buttons are at the screen's edges already.
  const bottomSides = sidesPastFold(insets, useFoldRoom());
  const { width, height } = useWindowDimensions();
  const deck = useDeck(room);
  const picture = useFilePictures(room.orgId, fileId);
  const look = usePeerLook();
  const pager = useRef<PagerView>(null);
  const shown = useMemo(() => shownSlides(deck.slides), [deck.slides]);

  // The slide in sight, by id (others may add, move or hide slides while this one plays).
  const [currentId, setCurrentId] = useState<string | null>(() => shown[showStart(deck.slides, at)]?.id ?? null);
  const found = shown.findIndex((s) => s.id === currentId);
  const index = found >= 0 ? found : Math.max(0, Math.min(shown.length - 1, showStart(deck.slides, currentId)));
  const current: SlideData | null = shown[index] ?? null;
  useEffect(() => {
    if (current && current.id !== currentId) setCurrentId(current.id);
  }, [current, currentId]);
  const page = useRef(index);
  const turn = useCallback(
    (to: number, animated = true) => {
      if (to < 0 || to >= shown.length || to === page.current) return;
      page.current = to;
      if (animated && !reduced) pager.current?.setPage(to);
      else pager.current?.setPageWithoutAnimation(to);
    },
    [shown.length, reduced],
  );
  useEffect(() => {
    turn(index, false);
  }, [index, turn]);

  // ── Following whoever presents ─────────────────────────────────────────────────────────────────────────────────
  const peers = useLivePeers(room);
  const [following, setFollowingOn] = useState(follow !== null);
  const presenter = following
    ? (peers.find((p) => !p.self && p.clientId === follow && p.state.presenting) ?? null)
    : null;
  const theirSlide = presenter?.state.presenting?.slide ?? null;
  const ours = useRef(false);
  useEffect(() => {
    if (!theirSlide) return;
    const to = shown.findIndex((s) => s.id === theirSlide);
    if (to < 0 || to === page.current) return;
    ours.current = true;
    setCurrentId(theirSlide);
    turn(to);
  }, [theirSlide, shown, turn]);
  // They stopped presenting (or left): following ends, this screen stays where it is.
  const ended = following && presenter === null && room.status === "live";
  useEffect(() => {
    if (ended) setFollowingOn(false);
  }, [ended]);

  // ── This person presenting ─────────────────────────────────────────────────────────────────────────────────────
  const presenting = follow === null;
  const since = useRef(Date.now());
  const shownId = current?.id ?? null;
  useEffect(() => {
    if (!shownId) return;
    room.setLocal(
      presenting
        ? { mode: "viewing", at: { slide: shownId }, presenting: { slide: shownId, since: since.current } }
        : { mode: "viewing", at: { slide: shownId } },
    );
  }, [room, shownId, presenting]);
  useEffect(
    () => () => {
      if (!room.destroyed) room.setLocal({ presenting: undefined });
    },
    [room],
  );

  // ── Controls ───────────────────────────────────────────────────────────────────────────────────────────────────
  const [chrome, setChrome] = useState(true);
  const [notes, setNotes] = useState(false);
  const fade = useSharedValue(1);
  useEffect(() => {
    fade.value = reduced ? (chrome ? 1 : 0) : withTiming(chrome ? 1 : 0, CHROME);
  }, [chrome, reduced, fade]);
  const chromeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  // The controls step aside after a while, as a player's do (counted again from each new slide).
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new slide (`index`) starts the wait again.
  useEffect(() => {
    if (!chrome || notes) return;
    const id = setTimeout(() => setChrome(false), 3500);
    return () => clearTimeout(id);
  }, [chrome, notes, index]);

  const box = { width: width - insets.left - insets.right, height: height - insets.top - insets.bottom };
  const fit = fitSlide(box, deck);

  if (shown.length === 0)
    return (
      <View style={[styles.fill, styles.middle]}>
        <Text variant="body" style={{ color: DIM }}>
          {t("mobile.live.show.nothing")}
        </Text>
        <Button variant="secondary" size="sm" label={t("live.slides.present.exit")} onPress={() => goBack()} />
      </View>
    );

  return (
    <View style={styles.fill}>
      <PagerView
        ref={pager}
        style={styles.fill}
        initialPage={index}
        offscreenPageLimit={1}
        onPageSelected={(e) => {
          const to = Math.round(e.nativeEvent.position);
          page.current = to;
          const next = shown[to];
          if (next) setCurrentId(next.id);
          // A swipe of the person's own while following: they go their own way.
          if (ours.current) ours.current = false;
          else if (following) setFollowingOn(false);
        }}
      >
        {shown.map((slide, i) => (
          <Pressable
            key={slide.id}
            // A pager's pages are real views (Android's pager needs them whole).
            collapsable={false}
            style={[styles.fill, styles.middle]}
            onPress={() => setChrome((v) => !v)}
            accessibilityRole="image"
            accessibilityLabel={t("live.slides.stage.label", { n: i + 1, total: shown.length })}
          >
            {Math.abs(i - index) <= 1 ? (
              <SlideView
                theme={deck.theme}
                slide={slide}
                width={fit.width}
                deck={deck}
                picture={picture}
                mode="show"
                radius={0}
              />
            ) : null}
          </Pressable>
        ))}
      </PagerView>

      {presenter ? (
        <HereIsland
          who={presenter.user}
          words={t("live.slides.present.following", { name: look(presenter.user).name })}
          action={t("mobile.live.here.stop")}
          onAction={() => setFollowingOn(false)}
          top={insets.top + 12}
        />
      ) : null}

      <Animated.View
        pointerEvents={chrome ? "box-none" : "none"}
        style={[StyleSheet.absoluteFill, chromeStyle]}
        accessibilityElementsHidden={!chrome}
      >
        <View
          style={[
            styles.top,
            { paddingTop: insets.top + 8, paddingLeft: insets.left + 12, paddingRight: insets.right + 12 },
          ]}
        >
          <Round icon="x" label={t("live.slides.present.exit")} onPress={() => goBack()} />
          <Text variant="subhead" style={styles.count}>
            {t("live.slides.present.count", { n: index + 1, total: shown.length })}
          </Text>
          <Round
            icon="swap"
            label={sideways.wide ? t("mobile.live.show.upright") : t("mobile.live.show.sideways")}
            onPress={sideways.wide ? sideways.standUp : sideways.lieDown}
          />
        </View>
        {notes && current ? (
          <View style={[styles.notes, { paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
            <ScrollView>
              <Text variant="body" style={{ color: current.notes.trim() ? WHITE : DIM }}>
                {current.notes.trim() || t("live.slides.present.noNotes")}
              </Text>
            </ScrollView>
          </View>
        ) : null}
        <View
          style={[
            styles.bottom,
            {
              paddingBottom: insets.bottom + 8,
              paddingLeft: bottomSides.left + 12,
              paddingRight: bottomSides.right + 12,
            },
          ]}
        >
          <Round
            icon="left"
            label={t("live.slides.present.previous")}
            disabled={index === 0}
            onPress={() => turn(index - 1)}
          />
          <PressScale
            onPress={() => setNotes((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ selected: notes }}
            accessibilityLabel={t("live.slides.notes.short")}
            style={[styles.notesButton, notes && styles.notesOn]}
            contentStyle={styles.notesButtonIn}
          >
            <Text variant="subhead" style={[styles.bold, { color: WHITE }]}>
              {t("live.slides.notes.short")}
            </Text>
          </PressScale>
          <Round
            icon="right"
            label={t("live.slides.present.nextSlide")}
            disabled={index >= shown.length - 1}
            onPress={() => turn(index + 1)}
          />
        </View>
      </Animated.View>
    </View>
  );
}

/** A round button over the slide, white on a dark plate. */
function Round({
  icon,
  label,
  onPress,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[styles.round, disabled && styles.off]}
      contentStyle={styles.roundIn}
    >
      <Icon name={icon} size={20} color={WHITE} />
    </PressScale>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  fill: { flex: 1 },
  middle: { alignItems: "center", justifyContent: "center", gap: 16 },
  top: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", alignItems: "center", gap: 12 },
  count: { flex: 1, textAlign: "center", color: WHITE, fontVariant: ["tabular-nums"] },
  bottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  notes: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 72,
    maxHeight: "40%",
    paddingVertical: 12,
    backgroundColor: SCRIM,
  },
  notesButton: { height: ROUND, paddingHorizontal: 16, borderRadius: ROUND / 2, backgroundColor: SCRIM },
  notesButtonIn: { justifyContent: "center" },
  notesOn: { backgroundColor: "rgba(255, 255, 255, 0.24)" },
  bold: { fontWeight: "600" },
  round: { width: ROUND, height: ROUND, borderRadius: ROUND / 2, backgroundColor: SCRIM },
  roundIn: { alignItems: "center", justifyContent: "center" },
  off: { opacity: 0.35 },
});
