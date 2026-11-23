import {
  type ArtifactDetail,
  isLiveFileKind,
  type LivePresent,
  type LiveRoom,
  useArtifact,
  useLivePeers,
} from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import type { Peer } from "@agenteschat/live/awareness";
import {
  deleteSlides,
  duplicateSlide,
  moveSlide,
  type SlideView as SlideData,
  setHidden,
  setTheme,
  type ThemeId,
} from "@agenteschat/live/slides";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, type FlatListInstance, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated from "react-native-reanimated";
import {
  Button,
  EmptyState,
  type HeaderMenuItem,
  PressScale,
  SCREEN_X,
  Text,
  usePulse,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { errorHaptic } from "../../shared/parts";
import { liveClosed, liveRoute } from "../logic";
import { setFollowing, useFollowing } from "../shared/follow";
import { PresentFaces } from "../shared/HereFaces";
import { LiveBar, LiveUnavailable } from "../shared/LiveBar";
import { usePeerLook } from "../shared/peers";
import { Tool, ToolBar } from "../shared/Tools";
import { type LiveDoc, useLiveDoc } from "../shared/useLiveDoc";
import { useAskAgent, useRevealHere, useTalkFocus } from "../talk/hooks";
import { FileTalkLine } from "../talk/TalkLine";
import { HereIsland } from "./Island";
import { moveTarget, peersBySlide, presenterOf, shownSlides, slideHeight } from "./logic";
import { chooseSlideAction, confirmDelete, pickTheme } from "./menus";
import { useFilePictures } from "./pictures";
import { slideLayoutRoute, slideRoute, slideShowRoute } from "./routes";
import { SlideFocus } from "./SlideFocus";
import { SlideView } from "./SlideView";
import { useDeck } from "./useDeck";

/**
 * A presentation on the phone (ADR 0196 §9), pushed with the file's bar (`LiveBar`): its slides one under the other at
 * the screen's width, each with its number and the faces of whoever is on it; a tap opens the slide large (the same
 * screen with `slide`, its own push), a long press its menu (present from it, a new one after, duplicate, move, hide,
 * delete); "Novo slide" picks a layout on a screen of its own, "Apresentar" plays it sideways. Someone presenting shows
 * on top with "Seguir"; following someone (from the faces' list) keeps their slide in view.
 */
export function SlidesScreen({
  id,
  slide,
  focusId = null,
}: {
  id: string;
  slide: string | null;
  focusId?: string | null;
}) {
  const live = useLiveDoc(id, { kind: "slides" });
  const query = useArtifact(live.orgId, id);
  const detail = query.data;
  useTalkFocus(detail, focusId);
  const title = detail?.title ?? "";
  const closed = liveClosed(live);

  // A link that named the wrong screen (or a file that isn't a presentation) gives way to the right one.
  const docKind = live.room && live.loaded ? live.room.kind : null;
  const kind = detail?.kind ?? docKind;
  useEffect(() => {
    if (!kind || kind === "slides") return;
    if (isLiveFileKind(kind)) router.replace(liveRoute(kind, id));
    else router.replace({ pathname: "/file/[id]", params: { id } });
  }, [kind, id]);

  if (closed)
    return (
      <>
        <LiveBar live={live} fileId={id} title={title} detail={undefined} />
        <LiveUnavailable reason={closed} />
      </>
    );
  if (!live.room || !live.loaded || docKind !== "slides")
    return (
      <>
        <LiveBar live={live} fileId={id} title={title} detail={detail} />
        <SlidesBones />
      </>
    );
  if (slide)
    return <SlideFocus live={live} room={live.room} fileId={id} title={title} detail={detail} slideId={slide} />;
  return <SlideList live={live} room={live.room} fileId={id} title={title} detail={detail} />;
}

/** Space between two slides of the list, and their row's line (number, faces) over each. */
const GAP = 24;
const HEAD = 28;

function SlideList({
  live,
  room,
  fileId,
  title,
  detail,
}: {
  live: LiveDoc;
  room: LiveRoom;
  fileId: string;
  title: string;
  detail: ArtifactDetail | undefined;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const toast = useToast();
  const { width: screen } = useWindowDimensions();
  const deck = useDeck(room);
  const doc = room.doc;
  const edit = live.mode === "edit";
  const width = screen - SCREEN_X * 2;
  const rowH = HEAD + slideHeight(width, deck) + GAP;
  const picture = useFilePictures(room.orgId, fileId);
  const list = useRef<FlatListInstance>(null);

  // On the list, nobody is on any one slide.
  useEffect(() => {
    room.setLocal({ mode: "viewing", at: undefined, sel: undefined });
  }, [room]);

  const peers = useLivePeers(room);
  const bySlide = useMemo(() => peersBySlide(peers), [peers]);
  const presenter = presenterOf(peers);
  const look = usePeerLook();

  // Following someone: their slide stays in view, until the person scrolls the list themselves.
  const followId = useFollowing(fileId);
  const followed = followId === null ? null : (peers.find((p) => p.clientId === followId && !p.self) ?? null);
  const gone = followId !== null && followed === null && live.status === "live";
  useEffect(() => {
    if (gone) setFollowing(fileId, null);
  }, [gone, fileId]);
  const theirSlide = followed?.state.presenting?.slide ?? followed?.state.at?.slide ?? null;
  const theirIndex = theirSlide ? deck.slides.findIndex((s) => s.id === theirSlide) : -1;
  useEffect(() => {
    if (theirIndex >= 0) list.current?.scrollToIndex({ index: theirIndex, animated: true, viewPosition: 0.3 });
  }, [theirIndex]);
  const stopFollowing = useCallback(() => {
    if (followId !== null) setFollowing(fileId, null);
  }, [followId, fileId]);

  const attempt = useCallback(
    (run: () => void) => {
      try {
        run();
      } catch {
        errorHaptic();
        toast({ title: t("live.slides.errors.invalid"), icon: "x" });
      }
    },
    [toast, t],
  );

  const open = useCallback((slide: SlideData) => router.push(slideRoute(fileId, slide.id)), [fileId]);
  const present = useCallback(
    (from?: string) => router.push(slideShowRoute(fileId, from ? { at: from } : {})),
    [fileId],
  );

  // The file's conversation (ADR 0199): "Ask Atlas" about a slide; a message's line about one brings it in view.
  const asking = useAskAgent(detail);
  const { label: askLabel, ask } = asking;
  useRevealHere(fileId, deck.slides.length > 0, (sel) => {
    const at = sel.slide ? deck.slides.findIndex((s) => s.id === sel.slide) : -1;
    if (at < 0) return;
    stopFollowing();
    list.current?.scrollToIndex({ index: at, animated: true, viewPosition: 0.3 });
  });

  const hold = useCallback(
    (slide: SlideData) => {
      const n = slide.index + 1;
      const count = deck.slides.length;
      const up = moveTarget(slide.index, count, -1);
      const down = moveTarget(slide.index, count, 1);
      chooseSlideAction(t("live.slides.rail.slide", { n }), [
        ...(askLabel
          ? [
              {
                label: askLabel,
                icon: "sparkle" as const,
                onPress: () => ask({ label: t("live.slides.selection.slide", { n }), slide: slide.id }),
              },
            ]
          : []),
        ...(slide.hidden
          ? []
          : [
              {
                label: t("live.slides.rail.presentFrom"),
                icon: "present" as const,
                onPress: () => present(slide.id),
              },
            ]),
        ...(edit
          ? [
              {
                label: t("live.slides.rail.newAfter"),
                icon: "plus" as const,
                onPress: () => router.push(slideLayoutRoute(fileId, { at: slide.index + 1 })),
              },
              {
                label: t("live.slides.rail.duplicate"),
                icon: "copy" as const,
                onPress: () => attempt(() => duplicateSlide(doc, slide.id, LOCAL)),
              },
              ...(up !== null
                ? [
                    {
                      label: t("live.slides.rail.moveUp"),
                      icon: "up" as const,
                      onPress: () => attempt(() => moveSlide(doc, slide.id, up, LOCAL)),
                    },
                  ]
                : []),
              ...(down !== null
                ? [
                    {
                      label: t("live.slides.rail.moveDown"),
                      icon: "down" as const,
                      onPress: () => attempt(() => moveSlide(doc, slide.id, down, LOCAL)),
                    },
                  ]
                : []),
              {
                label: slide.hidden ? t("live.slides.rail.show") : t("live.slides.rail.hide"),
                icon: slide.hidden ? ("eye" as const) : ("eyeoff" as const),
                onPress: () => attempt(() => setHidden(doc, slide.id, !slide.hidden, LOCAL)),
              },
              {
                label: t("live.slides.rail.delete"),
                icon: "trash" as const,
                destructive: true,
                onPress: () => confirmDelete(t, n, () => attempt(() => deleteSlides(doc, [slide.id], LOCAL))),
              },
            ]
          : []),
      ]);
    },
    [deck.slides.length, edit, fileId, doc, attempt, t, present, askLabel, ask],
  );

  const menu: HeaderMenuItem[] = edit
    ? [
        {
          icon: "slides",
          sf: "paintpalette",
          label: t("live.slides.tools.theme"),
          onPress: () => void pickTheme(t, deck.theme, (theme) => attempt(() => setTheme(doc, theme, LOCAL))),
        },
      ]
    : [];
  const shown = shownSlides(deck.slides);

  return (
    <>
      <LiveBar live={live} fileId={fileId} title={title} detail={detail} menu={menu} />
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        {deck.slides.length === 0 ? (
          <View style={styles.middle}>
            <EmptyState
              size="page"
              icon="slides"
              title={t("live.slides.empty.title")}
              {...(edit ? { subtitle: t("live.slides.empty.body") } : {})}
              action={
                edit ? (
                  <Button
                    variant="secondary"
                    label={t("live.slides.empty.add")}
                    onPress={() => router.push(slideLayoutRoute(fileId, { at: 0 }))}
                  />
                ) : undefined
              }
            />
          </View>
        ) : (
          <FlatList
            ref={list}
            data={deck.slides}
            keyExtractor={(s) => s.id}
            contentContainerStyle={styles.list}
            initialNumToRender={4}
            windowSize={7}
            getItemLayout={(_, index) => ({ length: rowH, offset: 16 + rowH * index, index })}
            onScrollBeginDrag={stopFollowing}
            renderItem={({ item }) => (
              <SlideRow
                slide={item}
                theme={deck.theme}
                width={width}
                picture={picture}
                here={bySlide.get(item.id)}
                onOpen={open}
                onHold={hold}
              />
            )}
          />
        )}
        {followed ? (
          <HereIsland
            who={followed.user}
            words={t("mobile.live.here.followingName", { name: look(followed.user).name })}
            action={t("mobile.live.here.stop")}
            onAction={stopFollowing}
          />
        ) : presenter ? (
          <HereIsland
            who={presenter.user}
            words={t("live.slides.presenting.who", { name: look(presenter.user).name })}
            action={t("live.slides.presenting.follow")}
            onAction={() => router.push(slideShowRoute(fileId, { follow: presenter.clientId }))}
          />
        ) : null}
      </View>
      {/* The slide's own tools: its icon over its word under a hairline, as the slide's screen has them (two filled
          buttons stood heavy over the conversation's line). */}
      <ToolBar>
        {edit ? (
          <Tool
            icon="plus"
            label={t("live.slides.tools.newSlide")}
            onPress={() => router.push(slideLayoutRoute(fileId, { at: deck.slides.length }))}
          />
        ) : null}
        <Tool icon="present" label={t("live.shell.present")} disabled={shown.length === 0} onPress={() => present()} />
      </ToolBar>
      <FileTalkLine file={detail} />
    </>
  );
}

/** One slide of the list: its number (and "oculto"), the faces of who is on it, the slide. */
const SlideRow = memo(function SlideRow({
  slide,
  theme,
  width,
  picture,
  here,
  onOpen,
  onHold,
}: {
  slide: SlideData;
  theme: ThemeId;
  width: number;
  picture: ReturnType<typeof useFilePictures>;
  here: Peer[] | undefined;
  onOpen: (slide: SlideData) => void;
  onHold: (slide: SlideData) => void;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const n = slide.index + 1;
  const present = useMemo<LivePresent[]>(
    () => (here ?? []).map((p) => ({ kind: p.user.kind, id: p.user.id, mode: p.state.mode })),
    [here],
  );
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text variant="caption" tone="faint" style={styles.number}>
          {slide.hidden ? t("live.slides.deck.hiddenNumber", { n }) : t("live.slides.deck.number", { n })}
        </Text>
        <PresentFaces present={present} ring={c.bg} />
      </View>
      <PressScale
        haptic={false}
        to={0.98}
        onPress={() => onOpen(slide)}
        onLongPress={() => onHold(slide)}
        delayLongPress={400}
        accessibilityRole="button"
        accessibilityLabel={
          slide.hidden ? t("live.slides.rail.slideHidden", { n }) : t("live.slides.rail.slide", { n })
        }
        accessibilityHint={t("mobile.live.slides.openHint")}
        style={[styles.slide, { boxShadow: shadows.e1 }, slide.hidden && styles.hidden]}
      >
        <SlideView theme={theme} slide={slide} width={width} picture={picture} mode="thumb" />
      </PressScale>
    </View>
  );
});

/** The list's shape while the presentation opens: two slides' places. */
export function SlidesBones() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const { width } = useWindowDimensions();
  const pulse = usePulse();
  const w = width - SCREEN_X * 2;
  return (
    <Animated.View
      style={[styles.fill, styles.list, { backgroundColor: c.bg }, pulse]}
      accessible
      accessibilityLabel={t("mobile.common.loading")}
      accessibilityState={{ busy: true }}
    >
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.row}>
          <View style={styles.head}>
            <View style={[styles.boneNumber, { backgroundColor: c.plate }]} />
          </View>
          <View style={[styles.bone, { width: w, height: slideHeight(w), backgroundColor: c.plate }]} />
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: SCREEN_X },
  list: { paddingHorizontal: SCREEN_X, paddingTop: 16, paddingBottom: 24 },
  row: { paddingBottom: GAP },
  head: { height: HEAD, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  number: { fontVariant: ["tabular-nums"] },
  slide: { borderRadius: 6 },
  hidden: { opacity: 0.45 },
  boneNumber: { width: 48, height: 10, borderRadius: 3 },
  bone: { borderRadius: 6 },
});
