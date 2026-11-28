import { type ArtifactDetail, type LivePresent, type LiveRoom, useLivePeers } from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import type { Peer } from "@agenteschat/live/awareness";
import { richText } from "@agenteschat/live/rich";
import {
  addElement,
  arrange,
  deleteElements,
  deleteSlides,
  duplicateSlide,
  type ElementView,
  moveSlide,
  SLIDE_H,
  SLIDE_W,
  type SlideView as SlideData,
  setHidden,
  setNotes,
  slideNotes,
  type ThemeId,
  updateElement,
} from "@agenteschat/live/slides";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import PagerView from "react-native-pager-view";
import type * as Y from "yjs";
import { type HeaderMenuItem, type IconName, SCREEN_X, Text, useReducedMotion, useTheme, useToast } from "@/ui";
import { goBack, router } from "@/ui/navigation";
import { Face } from "../../shared/Face";
import { errorHaptic } from "../../shared/parts";
import { TextArea } from "../../shared/TextArea";
import { setFollowing, useFollowing } from "../shared/follow";
import { PresentFaces } from "../shared/HereFaces";
import { LiveBar } from "../shared/LiveBar";
import { usePeerLook } from "../shared/peers";
import { Tool, ToolBar } from "../shared/Tools";
import type { LiveDoc } from "../shared/useLiveDoc";
import { useAskAgent } from "../talk/hooks";
import { FileTalkLine } from "../talk/TalkLine";
import { HereIsland } from "./Island";
import {
  elementFrame,
  holdsText,
  moveTarget,
  partOf,
  peerSelections,
  peersBySlide,
  presenterOf,
  slideHeight,
  slideScale,
  touchSlop,
} from "./logic";
import { chooseSlideAction, confirmDelete } from "./menus";
import { usePhotoPick } from "./photos";
import { useFilePictures } from "./pictures";
import { slideLayoutRoute, slideShowRoute, textRoute } from "./routes";
import { type PictureOf, SlideFontsContext, SlideView } from "./SlideView";
import { useDeck } from "./useDeck";

/**
 * A slide opened large on the phone (ADR 0196 §9): the presentation's slides side by side on the system's pager, from
 * the one tapped, each at the screen's width with its number, who is on it and its speaker notes under it. A tap on a
 * text box (or a shape's label) opens its words on a screen of their own; on a picture, its choices (another photo, how
 * it fills its box); a long press, an element's menu (front, back, delete). The bar's "…" has the slide's own menu, and
 * the tools under it add a text box or a photo, change the layout, or present from here. Everyone else's chosen
 * elements show outlined in their color with their face.
 */
export function SlideFocus({
  live,
  room,
  fileId,
  title,
  detail,
  slideId,
}: {
  live: LiveDoc;
  room: LiveRoom;
  fileId: string;
  title: string;
  detail: ArtifactDetail | undefined;
  slideId: string;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const toast = useToast();
  const reduced = useReducedMotion();
  const { width: screen } = useWindowDimensions();
  const deck = useDeck(room);
  const doc = room.doc;
  const edit = live.mode === "edit";
  const width = screen - SCREEN_X * 2;
  const picture = useFilePictures(room.orgId, fileId);
  const pager = useRef<PagerView>(null);

  // The slide in sight, by id: someone moving slides around keeps it in sight; one deleted gives way to its place.
  const [currentId, setCurrentId] = useState(slideId);
  const at = deck.slides.findIndex((s) => s.id === currentId);
  const [lastAt, setLastAt] = useState(Math.max(0, at));
  const index = at >= 0 ? at : Math.min(lastAt, deck.slides.length - 1);
  const current: SlideData | null = deck.slides[index] ?? null;
  const shownId = current?.id ?? null;
  useEffect(() => {
    if (at >= 0) setLastAt(at);
    else if (shownId) setCurrentId(shownId);
    else goBack();
  }, [at, shownId]);
  const shownPage = useRef(index);
  useEffect(() => {
    if (shownPage.current === index) return;
    shownPage.current = index;
    pager.current?.setPageWithoutAnimation(index);
  }, [index]);

  // ── Presence ───────────────────────────────────────────────────────────────────────────────────────────────────
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (!shownId) return;
    room.setLocal({
      mode: picked ? "editing" : "viewing",
      at: { slide: shownId },
      sel: picked ? { slide: [picked] } : undefined,
    });
  }, [room, shownId, picked]);
  const peers = useLivePeers(room);
  const bySlide = useMemo(() => peersBySlide(peers), [peers]);
  const presenter = presenterOf(peers);
  const look = usePeerLook();

  // Following someone: the pager goes to their slide, until the person swipes themselves.
  const followId = useFollowing(fileId);
  const followed = followId === null ? null : (peers.find((p) => p.clientId === followId && !p.self) ?? null);
  const gone = followId !== null && followed === null && live.status === "live";
  useEffect(() => {
    if (gone) setFollowing(fileId, null);
  }, [gone, fileId]);
  const theirSlide = followed?.state.presenting?.slide ?? followed?.state.at?.slide ?? null;
  const theirIndex = theirSlide ? deck.slides.findIndex((s) => s.id === theirSlide) : -1;
  const following = useRef(false);
  useEffect(() => {
    if (theirIndex < 0 || theirIndex === shownPage.current) return;
    following.current = true;
    shownPage.current = theirIndex;
    if (reduced) pager.current?.setPageWithoutAnimation(theirIndex);
    else pager.current?.setPage(theirIndex);
  }, [theirIndex, reduced]);
  const stopFollowing = useCallback(() => {
    if (followId !== null) setFollowing(fileId, null);
  }, [followId, fileId]);

  // ── Edits ──────────────────────────────────────────────────────────────────────────────────────────────────────
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
  const photos = usePhotoPick(room.orgId, fileId);
  /** A photo onto the slide: into its empty picture slot when it has one, else a new picture in its middle. */
  const addPhoto = async (slide: SlideData, into?: ElementView) => {
    const [asset] = await photos.pick(1);
    if (!asset) return;
    const slot = into ?? slide.elements.find((el) => el.type === "image" && !el.asset);
    attempt(() => {
      if (slot) updateElement(doc, slide.id, slot.id, { asset: asset.id }, LOCAL);
      else addElement(doc, slide.id, { type: "image", asset: asset.id, box: pictureBox(asset), fit: "cover" }, LOCAL);
    });
  };
  const addText = (slide: SlideData) => {
    try {
      const made = addElement(doc, slide.id, { type: "text" }, LOCAL);
      router.push(textRoute(fileId, { slide: slide.id, el: made }));
    } catch {
      errorHaptic();
      toast({ title: t("live.slides.errors.tooMany"), icon: "x" });
    }
  };

  const elementMenu = (slide: SlideData, el: ElementView) => {
    setPicked(el.id);
    chooseSlideAction(t(`mobile.live.slides.part.${partOf(el)}`), [
      ...(holdsText(el)
        ? [
            {
              label: t("live.slides.menu.editText"),
              icon: "pen" as IconName,
              onPress: () => router.push(textRoute(fileId, { slide: slide.id, el: el.id })),
            },
          ]
        : []),
      ...(el.type === "image"
        ? [
            {
              label: el.asset ? t("live.slides.image.replace") : t("mobile.live.slides.pickPhoto"),
              icon: "photos" as IconName,
              onPress: () => void addPhoto(slide, el),
            },
            ...(el.asset
              ? [
                  {
                    label: el.fit === "contain" ? t("live.slides.image.cover") : t("live.slides.image.contain"),
                    icon: "expand" as IconName,
                    onPress: () =>
                      attempt(() =>
                        updateElement(doc, slide.id, el.id, { fit: el.fit === "contain" ? "cover" : "contain" }, LOCAL),
                      ),
                  },
                ]
              : []),
          ]
        : []),
      {
        label: t("live.slides.arrange.front"),
        icon: "up",
        onPress: () => attempt(() => arrange(doc, slide.id, [el.id], "front", LOCAL)),
      },
      {
        label: t("live.slides.arrange.back"),
        icon: "down",
        onPress: () => attempt(() => arrange(doc, slide.id, [el.id], "back", LOCAL)),
      },
      {
        label: t("live.slides.menu.delete"),
        icon: "trash",
        destructive: true,
        onPress: () => attempt(() => deleteElements(doc, slide.id, [el.id], LOCAL)),
      },
    ]);
  };
  // The menu gone, the outline goes with it a moment later (its action may still be running).
  useEffect(() => {
    if (!picked) return;
    const id = setTimeout(() => setPicked(null), 1500);
    return () => clearTimeout(id);
  }, [picked]);

  const tapElement = (slide: SlideData, el: ElementView) => {
    if (!edit) return;
    if (holdsText(el)) router.push(textRoute(fileId, { slide: slide.id, el: el.id }));
    else elementMenu(slide, el);
  };

  // The slide's own menu, in the bar's "…": "Ask Atlas" about it first (ADR 0199), for whoever reads the file.
  const count = deck.slides.length;
  const asking = useAskAgent(detail);
  const ask: HeaderMenuItem[] =
    current && asking.label
      ? [
          {
            icon: "sparkle",
            sf: "sparkles",
            label: asking.label,
            onPress: () => asking.ask({ label: t("live.slides.selection.slide", { n: index + 1 }), slide: current.id }),
          },
        ]
      : [];
  const edits: HeaderMenuItem[] =
    edit && current
      ? [
          {
            icon: "copy",
            sf: "plus.square.on.square",
            label: t("live.slides.rail.duplicate"),
            onPress: () =>
              attempt(() => {
                const copy = duplicateSlide(doc, current.id, LOCAL);
                setCurrentId(copy);
              }),
          },
          ...(moveTarget(index, count, -1) !== null
            ? [
                {
                  icon: "up" as const,
                  sf: "arrow.up" as const,
                  label: t("live.slides.rail.moveUp"),
                  onPress: () => attempt(() => moveSlide(doc, current.id, index - 1, LOCAL)),
                },
              ]
            : []),
          ...(moveTarget(index, count, 1) !== null
            ? [
                {
                  icon: "down" as const,
                  sf: "arrow.down" as const,
                  label: t("live.slides.rail.moveDown"),
                  onPress: () => attempt(() => moveSlide(doc, current.id, index + 1, LOCAL)),
                },
              ]
            : []),
          {
            icon: current.hidden ? "eye" : "eyeoff",
            sf: current.hidden ? "eye" : "eye.slash",
            label: current.hidden ? t("live.slides.rail.show") : t("live.slides.rail.hide"),
            onPress: () => attempt(() => setHidden(doc, current.id, !current.hidden, LOCAL)),
          },
          {
            icon: "trash",
            sf: "trash",
            label: t("live.slides.rail.delete"),
            destructive: true,
            onPress: () => confirmDelete(t, index + 1, () => attempt(() => deleteSlides(doc, [current.id], LOCAL))),
          },
        ]
      : [];
  const menu: HeaderMenuItem[] = [...ask, ...edits];

  return (
    <SlideFontsContext.Provider value={deck.fonts}>
      <LiveBar live={live} fileId={fileId} title={title} detail={detail} menu={menu} />
      <View style={[styles.fill, { backgroundColor: c.sunken }]}>
        <PagerView
          ref={pager}
          style={styles.fill}
          initialPage={Math.max(0, index)}
          offscreenPageLimit={1}
          onPageSelected={(e) => {
            const page = Math.round(e.nativeEvent.position);
            shownPage.current = page;
            const next = deck.slides[page];
            if (next) setCurrentId(next.id);
            setPicked(null);
            // A swipe of the person's own stops following; the pager going to the followed slide doesn't.
            if (following.current) following.current = false;
            else stopFollowing();
          }}
        >
          {deck.slides.map((slide, i) => (
            <View key={slide.id} style={styles.fill} collapsable={false}>
              {Math.abs(i - index) <= 1 ? (
                <SlidePage
                  slide={slide}
                  count={count}
                  theme={deck.theme}
                  width={width}
                  picture={picture}
                  doc={doc}
                  edit={edit}
                  here={bySlide.get(slide.id)}
                  peers={peers}
                  picked={slide.id === current?.id ? picked : null}
                  onTap={(el) => tapElement(slide, el)}
                  onHold={(el) => elementMenu(slide, el)}
                />
              ) : null}
            </View>
          ))}
        </PagerView>
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
      {current ? (
        <ToolBar>
          {edit ? (
            <>
              <Tool icon="textTool" label={t("mobile.live.slides.tools.text")} onPress={() => addText(current)} />
              <Tool
                icon="photos"
                label={photos.busy > 0 ? t("mobile.live.slides.tools.sending") : t("mobile.live.slides.tools.photo")}
                disabled={photos.busy > 0}
                onPress={() => void addPhoto(current)}
              />
              <Tool
                icon="slides"
                label={t("live.slides.tools.layout")}
                onPress={() => router.push(slideLayoutRoute(fileId, { slide: current.id }))}
              />
            </>
          ) : null}
          <Tool
            icon="present"
            label={t("live.shell.present")}
            disabled={current.hidden === true && deck.slides.every((s) => s.hidden)}
            onPress={() => router.push(slideShowRoute(fileId, { at: current.id }))}
          />
        </ToolBar>
      ) : null}
      <FileTalkLine file={detail} />
    </SlideFontsContext.Provider>
  );
}

/** A picture's box on a new slide: its proportions, as large as the slide's middle holds, centered. */
function pictureBox(asset: { width: number | null; height: number | null }) {
  const ratio = asset.width && asset.height ? asset.width / asset.height : 4 / 3;
  const maxW = SLIDE_W * 0.6;
  const maxH = SLIDE_H * 0.7;
  const w = Math.min(maxW, maxH * ratio);
  const h = w / ratio;
  return { x: (SLIDE_W - w) / 2, y: (SLIDE_H - h) / 2, w, h };
}

/** One page of the pager: the slide's line (number, who is on it), the slide with its elements to touch, its notes. */
const SlidePage = memo(function SlidePage({
  slide,
  count,
  theme,
  width,
  picture,
  doc,
  edit,
  here,
  peers,
  picked,
  onTap,
  onHold,
}: {
  slide: SlideData;
  count: number;
  theme: ThemeId;
  width: number;
  picture: PictureOf;
  doc: Y.Doc;
  edit: boolean;
  here: Peer[] | undefined;
  peers: readonly Peer[];
  picked: string | null;
  onTap: (el: ElementView) => void;
  onHold: (el: ElementView) => void;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const look = usePeerLook();
  const n = slide.index + 1;
  const k = slideScale(width);
  const height = slideHeight(width);
  const present = useMemo<LivePresent[]>(
    () => (here ?? []).map((p) => ({ kind: p.user.kind, id: p.user.id, mode: p.state.mode })),
    [here],
  );
  const outlines = useMemo(() => peerSelections(peers, slide.id), [peers, slide.id]);
  return (
    <KeyboardAwareScrollView
      style={styles.fill}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      bottomOffset={16}
    >
      <View style={styles.head}>
        <Text variant="footnote" tone="muted" style={styles.number}>
          {slide.hidden
            ? t("mobile.live.slides.placeHidden", { n, count })
            : t("mobile.live.slides.place", { n, count })}
        </Text>
        <PresentFaces present={present} ring={c.sunken} />
      </View>
      <View style={[styles.stage, { width, height, boxShadow: shadows.e2 }]}>
        <SlideView
          theme={theme}
          slide={slide}
          width={width}
          picture={picture}
          mode={edit ? "edit" : "thumb"}
          radius={8}
        />
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {slide.elements.map((el) => {
            const f = elementFrame(el, k);
            const hit = touchSlop(f);
            const words = el.text ? richText(el.text).trim() : "";
            const part = t(`mobile.live.slides.part.${partOf(el)}`);
            return (
              <Pressable
                key={el.id}
                onPress={() => onTap(el)}
                onLongPress={() => onHold(el)}
                delayLongPress={400}
                disabled={!edit}
                hitSlop={hit}
                accessibilityRole="button"
                accessibilityLabel={words ? `${part}: ${words}` : part}
                accessibilityHint={edit && holdsText(el) ? t("mobile.live.slides.editHint") : undefined}
                style={[
                  styles.abs,
                  { left: f.left, top: f.top, width: Math.max(1, f.width), height: Math.max(1, f.height) },
                  f.rot ? { transform: [{ rotate: `${f.rot}deg` }] } : null,
                  picked === el.id ? [styles.picked, { borderColor: c.ink }] : null,
                ]}
              />
            );
          })}
          {outlines.flatMap(({ peer, ids }) => {
            const tint = look(peer.user).tint;
            return ids.flatMap((id, j) => {
              const el = slide.elements.find((e) => e.id === id);
              if (!el) return [];
              const f = elementFrame(el, k);
              return [
                <View
                  key={`${peer.clientId}:${id}`}
                  pointerEvents="none"
                  style={[
                    styles.abs,
                    styles.peer,
                    { left: f.left - 2, top: f.top - 2, width: f.width + 4, height: f.height + 4, borderColor: tint },
                  ]}
                >
                  {j === 0 ? (
                    <View style={[styles.peerFace, { borderColor: tint }]}>
                      <Face
                        who={{ type: peer.user.kind === "agent" ? "agent" : "person", id: peer.user.id }}
                        size={16}
                        live={false}
                      />
                    </View>
                  ) : null}
                </View>,
              ];
            });
          })}
        </View>
      </View>
      <Notes doc={doc} slideId={slide.id} edit={edit} />
    </KeyboardAwareScrollView>
  );
});

/** A slide's speaker notes, typed here as anyone else types them: only what changed goes into the file. */
function Notes({ doc, slideId, edit }: { doc: Y.Doc; slideId: string; edit: boolean }) {
  const { t } = useTranslation();
  const read = useCallback(() => slideNotes(doc, slideId)?.toString() ?? "", [doc, slideId]);
  const [text, setText] = useState(read);
  const focused = useRef(false);
  const typedAt = useRef(0);
  // Someone else's change shows at once unless the person is in the middle of typing (it would move their caret).
  useEffect(() => {
    const notes = slideNotes(doc, slideId);
    if (!notes) return;
    const sync = (_: unknown, tr: Y.Transaction) => {
      if (tr.origin === LOCAL) return;
      if (focused.current && Date.now() - typedAt.current < 1200) return;
      setText(read());
    };
    notes.observe(sync);
    return () => notes.unobserve(sync);
  }, [doc, slideId, read]);
  if (!edit && !text.trim()) return null;
  return (
    <View style={styles.notes}>
      <Text variant="footnote" tone="muted" style={styles.notesLabel}>
        {t("live.slides.notes.title")}
      </Text>
      {edit ? (
        <TextArea
          value={text}
          minHeight={88}
          placeholder={t("mobile.live.slides.notesPlaceholder")}
          accessibilityLabel={t("live.slides.notes.title")}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            setText(read());
          }}
          onChangeText={(next) => {
            typedAt.current = Date.now();
            setText(next);
            try {
              setNotes(doc, slideId, next, LOCAL);
            } catch {
              // Past the notes' limit: the field keeps what was typed, the file what fits.
            }
          }}
        />
      ) : (
        <Text variant="body" tone="ink2" selectable>
          {text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { paddingHorizontal: SCREEN_X, paddingTop: 12, paddingBottom: 32 },
  head: { height: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  number: { fontVariant: ["tabular-nums"] },
  stage: { borderRadius: 8 },
  abs: { position: "absolute" },
  picked: { borderWidth: 1.5, borderRadius: 2 },
  peer: { borderWidth: 2, borderRadius: 3 },
  peerFace: { position: "absolute", right: -10, top: -10, borderWidth: 2, borderRadius: 10, overflow: "hidden" },
  notes: { marginTop: 24, gap: 8 },
  notesLabel: { fontWeight: "600" },
});
