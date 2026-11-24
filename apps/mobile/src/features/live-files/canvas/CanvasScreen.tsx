import {
  type ArtifactDetail,
  isLiveFileKind,
  type LiveRoom,
  type LiveSelection,
  nextFrame,
  useArtifact,
  useLiveDocVersion,
  useLivePeers,
  useRetryImages,
} from "@agenteschat/client";
import { LOCAL } from "@agenteschat/live";
import type { PeerUser } from "@agenteschat/live/awareness";
import {
  type ArrowRoute,
  addShape,
  arrangeShapes,
  type CanvasShapeKind,
  deleteShapes,
  frameAt,
  NOTE_COLORS,
  type NoteColor,
  readShapes,
  type ShapeView,
  shapeBounds,
  shapeIndex,
  union,
  updateShape,
} from "@agenteschat/live/canvas";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import {
  besideFold,
  EmptyState,
  Glass,
  type HeaderMenuItem,
  haptics,
  Icon,
  type IconName,
  motion,
  PressScale,
  SCREEN_X,
  Text,
  useFoldRoom,
  usePulse,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { openFile } from "../../files/open";
import { Face } from "../../shared/Face";
import { useErrorToast } from "../../shared/hooks";
import { pickOne, showActionSheet } from "../../shared/PickerSheet";
import { errorHaptic } from "../../shared/parts";
import { liveClosed, liveRoute } from "../logic";
import { setFollowing, useFollowing } from "../shared/follow";
import { LiveBar, LiveUnavailable } from "../shared/LiveBar";
import { NOTE_TINTS } from "../shared/LiveCover";
import { usePeerLook } from "../shared/peers";
import { type LiveDoc, useLiveDoc } from "../shared/useLiveDoc";
import { HereIsland } from "../slides/Island";
import { usePhotoPick } from "../slides/photos";
import { textRoute } from "../slides/routes";
import { useAskAgent, useOpenFileTalk, useRevealHere, useTalkFocus, useTalkPins } from "../talk/hooks";
import { FileTalkLine, useTalkLineRoom } from "../talk/TalkLine";
import { CanvasPlane, type PlaneHandle, type PlaneTool } from "./CanvasPlane";
import { CropOverlay } from "./CropOverlay";
import type { PeerView, Pt, WBox } from "./camera";
import {
  type AddKind,
  canvasSelection,
  chosenPictures,
  croppedPicture,
  DEFAULT_PEN,
  holdsWords,
  isInk,
  newSize,
  PEN_INKS,
  PEN_SIZES,
  PEN_WIDTHS,
  type PenStyle,
  pictureSize,
  placeNear,
  retryable,
  shapeAt,
  strokeOf,
  strokeShape,
  thinPoints,
} from "./logic";

/**
 * A canvas on the phone (ADR 0196 §9), pushed with the file's bar (`LiveBar`): the plane with everything on it
 * (`CanvasPlane`), the tools in a glass dock over it (select, the pen, the shapes' menu, an arrow, text, a note, photos
 * from the library, a comment), and under them the file's conversation (`FileTalkLine`, ADR 0199). Pictures come from
 * the agents in the conversation ("Variations" and "Ask Atlas" on a chosen picture's glass bar). A long press asks
 * for a shape's menu (its words, its color, ask the agent, front and back, delete) or the plane's. Following someone
 * (from the faces' list) moves the view with theirs. `focusId`: a message of the conversation to open at.
 */
export function CanvasScreen({ id, focusId = null }: { id: string; focusId?: string | null }) {
  const live = useLiveDoc(id, { kind: "canvas" });
  const query = useArtifact(live.orgId, id);
  const detail = query.data;
  const title = detail?.title ?? "";
  const closed = liveClosed(live);
  useTalkFocus(detail, focusId);

  // A link that named the wrong screen (or a file that isn't a canvas) gives way to the right one.
  const docKind = live.room && live.loaded ? live.room.kind : null;
  const kind = detail?.kind ?? docKind;
  useEffect(() => {
    if (!kind || kind === "canvas") return;
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
  if (!live.room || !live.loaded || docKind !== "canvas")
    return (
      <>
        <LiveBar live={live} fileId={id} title={title} detail={detail} />
        <CanvasBones />
      </>
    );
  return <LiveCanvas live={live} room={live.room} fileId={id} title={title} detail={detail} />;
}

/** The shapes' menu, in the web's order: the five forms, then a line. */
const SHAPE_CHOICES: readonly (CanvasShapeKind | "line")[] = ["rect", "ellipse", "diamond", "triangle", "star", "line"];
const SHAPE_ICON: Record<CanvasShapeKind | "line", IconName> = {
  rect: "rect",
  ellipse: "ellipse",
  diamond: "diamond",
  triangle: "triangle",
  star: "star",
  line: "line",
};
/** A new form's size (world units): square for the round and pointed forms, wider for a rectangle. */
const shapeSize = (kind: CanvasShapeKind) => (kind === "rect" ? { w: 240, h: 160 } : { w: 200, h: 200 });
/** How long a new line is (world units). */
const LINE_W = 240;

function LiveCanvas({
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
  const { colors: c, shadows } = useTheme();
  const toast = useToast();
  const failed = useErrorToast();
  const reduced = useReducedMotion();
  const lineRoom = useTalkLineRoom();
  // Folded like a book (ADR 0212), the tools and the pen's bar over them stand beside the fold, together, instead of
  // in its middle.
  const foldSide = useFoldRoom();
  const beside = foldSide ? besideFold(foldSide) : null;
  const doc = room.doc;
  const readOnly = live.mode !== "edit";
  const plane = useRef<PlaneHandle>(null);
  // Who made what this phone adds: the apps' own changes carry no author, so each new shape names its person.
  const me: PeerUser | null = live.me;
  const by = useMemo(() => (me ? { by: me } : {}), [me]);

  const version = useLiveDocVersion(room, nextFrame);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after every change (`version`).
  const shapes = useMemo(() => readShapes(doc), [doc, version]);
  const byId = useMemo(() => shapeIndex(shapes), [shapes]);

  // ── The selection ──────────────────────────────────────────────────────────────────────────────────────────────
  const [chosen, setChosen] = useState<string[]>([]);
  // What someone else deleted leaves the selection.
  const selected = useMemo(() => chosen.filter((id) => byId.has(id)), [chosen, byId]);
  const selKey = selected.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per change of the chosen ids (`selKey`).
  useEffect(() => {
    room.setLocal({
      mode: selected.length > 0 && !readOnly ? "editing" : "viewing",
      sel: selected.length > 0 ? { canvas: selected } : undefined,
    });
  }, [room, selKey, readOnly]);
  useEffect(
    () => () => {
      if (!room.destroyed) room.setLocal({ cursor: undefined, sel: undefined, view: undefined, mode: "viewing" });
    },
    [room],
  );

  // ── The dock's tool: what one finger does on the plane until another is picked ─────────────────────────────────
  const [tool, setTool] = useState<PlaneTool>("select");
  // The pen as the person set it on its bar, and how the next arrow runs (the arrow tool's menu).
  const [pen, setPen] = useState<PenStyle>(DEFAULT_PEN);
  const [route, setRoute] = useState<ArrowRoute>("straight");
  // A picture being cropped: its id, and where it shows on screen as the crop starts.
  const [cropping, setCropping] = useState<{ id: string; box: WBox } | null>(null);
  const pick = (next: PlaneTool) => {
    haptics.selection();
    setTool(next);
    if (next !== "select") setChosen([]);
  };

  // ── Following someone ──────────────────────────────────────────────────────────────────────────────────────────
  const peers = useLivePeers(room);
  const look = usePeerLook();
  const followId = useFollowing(fileId);
  const followed = followId === null ? null : (peers.find((p) => p.clientId === followId && !p.self) ?? null);
  const gone = followId !== null && followed === null && live.status === "live";
  useEffect(() => {
    if (gone) setFollowing(fileId, null);
  }, [gone, fileId]);
  const theirView = (followed?.state.view as PeerView | undefined) ?? null;
  const stopFollowing = useCallback(() => {
    if (followId !== null) setFollowing(fileId, null);
  }, [followId, fileId]);

  // ── The file's conversation (ADR 0199) ─────────────────────────────────────────────────────────────────────────
  const asking = useAskAgent(detail);
  const openTalk = useOpenFileTalk(detail);
  const pins = useTalkPins(fileId, asking.messages);
  const selectionOf = useCallback(
    (ids: readonly string[]): LiveSelection | null =>
      canvasSelection(
        t,
        ids.flatMap((id) => {
          const s = byId.get(id);
          return s ? [s] : [];
        }),
      ),
    [t, byId],
  );
  // A message's line (or a pin) brings what it is about into view, chosen.
  useRevealHere(fileId, true, (sel) => {
    stopFollowing();
    const ids = (sel.shapes ?? []).filter((id) => byId.has(id));
    const box = union(ids.flatMap((id) => (byId.get(id) ? [shapeBounds(byId.get(id) as ShapeView, byId)] : [])));
    if (box) {
      setTool("select");
      setChosen(ids);
      plane.current?.reveal(box);
    } else if (sel.point) plane.current?.reveal({ x: sel.point.x - 120, y: sel.point.y - 120, w: 240, h: 240 });
  });

  // ── Adding ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const attempt = useCallback(
    (run: () => void) => {
      try {
        run();
      } catch {
        errorHaptic();
        toast({ title: t("live.canvas.errors.other"), icon: "x" });
      }
    },
    [toast, t],
  );
  const middle = (): Pt => plane.current?.center() ?? { x: 0, y: 0 };
  /** The new shape chosen and in view, the dock back on Select. */
  const showMade = (made: string) => {
    setTool("select");
    setChosen([made]);
    const shape = shapeIndex(readShapes(doc, { text: false })).get(made);
    if (shape) plane.current?.reveal(shapeBounds(shape, byId));
  };
  const addWords = (type: AddKind, at: Pt = middle()) => {
    try {
      const frame = frameAt(doc, at.x, at.y);
      const size = newSize(type);
      let made: string;
      if (frame) made = addShape(doc, { type, parent: frame, w: size.w, h: size.h, ...by }, LOCAL);
      else {
        const [box] = placeNear(doc, at, [size]);
        made = addShape(
          doc,
          { type, ...(box ?? { x: at.x - size.w / 2, y: at.y - size.h / 2, ...size }), ...by },
          LOCAL,
        );
      }
      showMade(made);
      router.push(textRoute(fileId, { shape: made }));
    } catch {
      errorHaptic();
      toast({ title: t("live.canvas.errors.tooMany"), icon: "x" });
    }
  };
  // A form from the shapes' menu (or a line), in free room near the middle of the view.
  const addForm = (kind: CanvasShapeKind | "line") =>
    attempt(() => {
      const at = middle();
      if (kind === "line") {
        const [box] = placeNear(doc, at, [{ w: LINE_W, h: 24 }]);
        const x = box?.x ?? at.x - LINE_W / 2;
        const y = (box?.y ?? at.y) + 12;
        const heads = { start: "none" as const, end: "none" as const };
        showMade(addShape(doc, { type: "arrow", from: { x, y }, to: { x: x + LINE_W, y }, heads, ...by }, LOCAL));
        return;
      }
      const size = shapeSize(kind);
      const [box] = placeNear(doc, at, [size]);
      const place = box ?? { x: at.x - size.w / 2, y: at.y - size.h / 2, ...size };
      showMade(addShape(doc, { type: "shape", kind, ...place, ...by }, LOCAL));
    });
  const chooseForm = () =>
    showActionSheet(
      t("mobile.live.canvas.tools.shapes"),
      SHAPE_CHOICES.map((kind) => ({
        label: t(`mobile.live.canvas.shapes.${kind}`),
        icon: SHAPE_ICON[kind],
        onPress: () => addForm(kind),
      })),
    );
  const photos = usePhotoPick(room.orgId, fileId);
  const addPhotos = async () => {
    const assets = await photos.pick(10);
    if (assets.length === 0) return;
    const at = middle();
    attempt(() => {
      const sizes = assets.map((a) => pictureSize(a.width, a.height));
      const boxes = placeNear(doc, at, sizes);
      const made = assets.map((a, i) => {
        const box = boxes[i] ?? { x: at.x, y: at.y, ...(sizes[i] ?? { w: 320, h: 320 }) };
        return addShape(
          doc,
          { type: "image", asset: a.id, nw: a.width ?? box.w, nh: a.height ?? box.h, ...box, ...by },
          LOCAL,
        );
      });
      setTool("select");
      setChosen(made);
      const all = union(boxes);
      if (all) plane.current?.reveal(all);
    });
  };
  // The pen: the stroke as few points as draw it (a screen point apart), in the bar's color, size and tool, written
  // once the finger lifts.
  const draw = (points: number[]) =>
    attempt(() => {
      const stroke = strokeShape(thinPoints(points, 1 / (plane.current?.zoom() ?? 1)));
      if (stroke) addShape(doc, { type: "draw", ...stroke, ...strokeOf(pen), ...by }, LOCAL);
    });
  // The arrow: from where the finger landed to where it lifted, each end bound to the shape there (if any).
  const drawArrow = (from: Pt, to: Pt) =>
    attempt(() => {
      const zoom = plane.current?.zoom() ?? 1;
      const endOf = (p: Pt) => {
        const id = shapeAt(shapes, byId, p, zoom);
        const shape = id ? byId.get(id) : undefined;
        return shape && shape.type !== "arrow" ? { shape: shape.id } : { x: p.x, y: p.y };
      };
      const how = route === "straight" ? {} : { route };
      showMade(addShape(doc, { type: "arrow", from: endOf(from), to: endOf(to), ...how, ...by }, LOCAL));
    });
  // The arrow tool: how the next arrows run first (straight, a curve, right angles), as the shapes' menu.
  const chooseRoute = () =>
    showActionSheet(
      t("mobile.live.canvas.tools.arrow"),
      ARROW_ROUTES.map((r) => ({
        label: t(`live.canvas.routes.${r}`),
        icon: ROUTE_ICON[r],
        checked: r === route,
        onPress: () => {
          setRoute(r);
          pick("arrow");
        },
      })),
    );
  // Cropping the one picture chosen: where it shows now, its part kept on Apply.
  const startCrop = (id: string) => {
    const shape = byId.get(id);
    const box = shape ? plane.current?.screenBox({ x: shape.x, y: shape.y, w: shape.w, h: shape.h }) : null;
    if (box) setCropping({ id, box });
  };
  const crop = (part: { x: number; y: number; w: number; h: number }) => {
    const id = cropping?.id;
    const shape = id ? byId.get(id) : undefined;
    setCropping(null);
    if (id && shape) attempt(() => updateShape(doc, id, croppedPicture(shape, part), LOCAL));
  };
  // A comment pinned where the finger tapped: the conversation opens with that spot over its composer.
  const comment = (at: Pt) => {
    setTool("select");
    const point = { x: Math.round(at.x), y: Math.round(at.y) };
    openTalk({ selection: { label: t("mobile.live.talk.comment"), point } });
  };

  // ── A shape's menu, the plane's menu ──────────────────────────────────────────────────────────────────────────
  const retry = useRetryImages(room.orgId, fileId);
  const retryShape = (shape: ShapeView) => {
    if (!retryable(shape) || !shape.request) return;
    retry.mutate(shape.request, { onError: failed });
  };
  const open = (shape: ShapeView) => {
    if (holdsWords(shape)) {
      if (!readOnly) router.push(textRoute(fileId, { shape: shape.id }));
      return;
    }
    if ((shape.type === "html" || shape.type === "file") && shape.artifact) openFile({ id: shape.artifact });
  };
  const pickColor = async (ids: readonly string[], current: NoteColor | undefined) => {
    const picked = await pickOne({
      title: t("live.canvas.bar.color"),
      value: current ?? null,
      options: NOTE_COLORS.map((color) => ({
        key: color,
        label: t(`live.canvas.colors.${color}`),
        leading: { kind: "node" as const, node: <NoteSwatch color={color} /> },
      })),
    });
    if (!picked) return;
    attempt(() => {
      for (const id of ids)
        if (byId.get(id)?.type === "note") updateShape(doc, id, { color: picked as NoteColor }, LOCAL);
    });
  };
  // "Variations" of a picture (ADR 0199): asked of the agent in the conversation, the picture over its composer.
  const variations = (ids: readonly string[]) => {
    const sel = selectionOf(ids);
    if (sel) asking.ask(sel, t("mobile.live.talk.variationsText"));
  };
  const askAbout = (ids: readonly string[]) => asking.ask(selectionOf(ids));
  const hold = (id: string | null, at: Pt) => {
    if (!id) {
      const actions: { label: string; icon: IconName; onPress: () => void }[] = [
        ...(readOnly
          ? []
          : [
              { label: t("live.canvas.actions.addNote"), icon: "note" as const, onPress: () => addWords("note", at) },
              {
                label: t("live.canvas.actions.addText"),
                icon: "textTool" as const,
                onPress: () => addWords("text", at),
              },
            ]),
        { label: t("mobile.live.canvas.tools.comment"), icon: "comment", onPress: () => comment(at) },
        { label: t("live.canvas.zoom.fitAll"), icon: "expand", onPress: () => plane.current?.fitAll() },
      ];
      showActionSheet(t("live.canvas.label"), actions);
      return;
    }
    const shape = byId.get(id);
    if (!shape) return;
    // A shape among the chosen ones: the menu acts on all of them; another one: on it alone, or adds it to them.
    const among = selected.includes(id);
    const targets = among ? selected : [id];
    if (!among) setChosen([id]);
    const pictures = chosenPictures(targets, byId);
    const notes = targets.filter((x) => byId.get(x)?.type === "note");
    const actions: { label: string; icon: IconName; destructive?: boolean; onPress: () => void }[] = [];
    if (asking.label) actions.push({ label: asking.label, icon: "sparkle", onPress: () => askAbout(targets) });
    if (pictures.length > 0 && asking.label)
      actions.push({
        label: t("live.canvas.inspector.variations"),
        icon: "sparkle",
        onPress: () => variations(pictures),
      });
    if (!among && selected.length > 0 && !readOnly)
      actions.push({
        label: t("mobile.live.canvas.addToSelection"),
        icon: "plus",
        onPress: () => setChosen([...selected, id]),
      });
    if (targets.length === 1 && holdsWords(shape) && !readOnly)
      actions.push({ label: t("live.canvas.actions.editText"), icon: "pen", onPress: () => open(shape) });
    if (targets.length === 1 && (shape.type === "html" || shape.type === "file"))
      actions.push({ label: t("live.canvas.actions.openFile"), icon: "file", onPress: () => open(shape) });
    if (retryable(shape) && !readOnly)
      actions.push({ label: t("live.images.retry"), icon: "replay", onPress: () => retryShape(shape) });
    if (!readOnly) {
      if (notes.length > 0)
        actions.push({
          label: t("live.canvas.bar.color"),
          icon: "sparkle",
          onPress: () => void pickColor(notes, notes.length === 1 ? byId.get(notes[0] ?? "")?.color : undefined),
        });
      actions.push(
        {
          label: t("live.canvas.arrange.front"),
          icon: "up",
          onPress: () => attempt(() => arrangeShapes(doc, targets, "front", LOCAL)),
        },
        {
          label: t("live.canvas.arrange.back"),
          icon: "down",
          onPress: () => attempt(() => arrangeShapes(doc, targets, "back", LOCAL)),
        },
        {
          label: t("live.canvas.actions.delete"),
          icon: "trash",
          destructive: true,
          onPress: () =>
            attempt(() => {
              deleteShapes(doc, targets, LOCAL);
              setChosen([]);
            }),
        },
      );
    }
    if (actions.length > 0) showActionSheet(shapeTitle(t, shape, targets.length), actions);
  };

  const menu: HeaderMenuItem[] = [
    {
      icon: "expand",
      sf: "arrow.up.left.and.arrow.down.right",
      label: t("live.canvas.zoom.fitAll"),
      onPress: () => plane.current?.fitAll(),
    },
    {
      icon: "search",
      sf: "1.magnifyingglass",
      label: t("live.canvas.zoom.actual"),
      onPress: () => plane.current?.actualSize(),
    },
  ];

  // One picture chosen: its glass bar (Variations, Ask Atlas, its menu); a drawing tool: what it does.
  const only = selected.length === 1 ? byId.get(selected[0] ?? "") : undefined;
  const onePicture = only?.type === "image" ? only.id : null;
  const hint =
    tool === "pen"
      ? t("mobile.live.canvas.penHint")
      : tool === "arrow"
        ? t("mobile.live.canvas.arrowHint")
        : tool === "comment"
          ? t("mobile.live.canvas.commentHint")
          : null;
  const fade = reduced ? {} : { entering: FadeIn.duration(motion.fast), exiting: FadeOut.duration(motion.fast) };
  const toggle = (next: PlaneTool) => pick(tool === next ? "select" : next);
  return (
    <>
      <LiveBar live={live} fileId={fileId} title={title} detail={detail} menu={menu} />
      <View style={styles.fill}>
        <CanvasPlane
          ref={plane}
          room={room}
          fileId={fileId}
          shapes={shapes}
          byId={byId}
          readOnly={readOnly}
          selected={selected}
          onSelect={setChosen}
          onOpen={open}
          onRetry={retryShape}
          onHold={hold}
          follow={theirView}
          onMoved={stopFollowing}
          tool={tool}
          onDraw={draw}
          pen={{ color: pen.color, width: PEN_WIDTHS[pen.tool][pen.size], marker: pen.tool === "marker" }}
          onArrow={drawArrow}
          onComment={comment}
          pins={pins}
          onPin={(pin) => openTalk({ messageId: pin.messageId, selection: null })}
        />
        {shapes.length === 0 && tool === "select" ? (
          <View style={[styles.empty, { paddingBottom: lineRoom + DOCK_H }]} pointerEvents="none">
            <EmptyState
              size="panel"
              icon="canvas"
              title={t("live.canvas.empty.title")}
              subtitle={readOnly ? t("live.canvas.empty.readOnly") : t("mobile.live.canvas.emptyText")}
            />
          </View>
        ) : null}
        {followed ? (
          <HereIsland
            who={followed.user}
            words={t("mobile.live.here.followingName", { name: look(followed.user).name })}
            action={t("mobile.live.here.stop")}
            onAction={stopFollowing}
          />
        ) : onePicture ? (
          <Animated.View {...fade} style={styles.barAt} pointerEvents="box-none">
            <GlassBar>
              {asking.label ? (
                <BarButton
                  icon="sparkle"
                  label={t("live.canvas.inspector.variations")}
                  onPress={() => variations([onePicture])}
                />
              ) : null}
              {asking.label && asking.agent ? (
                <BarButton face={asking.agent.id} label={asking.label} onPress={() => askAbout([onePicture])} />
              ) : null}
              {readOnly ? null : (
                <BarButton
                  icon="crop"
                  label={t("live.canvas.image.crop")}
                  iconOnly
                  onPress={() => startCrop(onePicture)}
                />
              )}
              <BarButton
                icon="more"
                label={t("mobile.files.more")}
                iconOnly
                onPress={() => hold(onePicture, middle())}
              />
            </GlassBar>
          </Animated.View>
        ) : hint ? (
          <Animated.View {...fade} style={styles.barAt} pointerEvents="none">
            <GlassBar>
              <Text variant="footnote" tone="ink2" style={styles.hint} numberOfLines={2}>
                {hint}
              </Text>
            </GlassBar>
          </Animated.View>
        ) : null}
        <View style={[styles.dockAt, { bottom: lineRoom }, beside]} pointerEvents="box-none">
          <View style={Platform.OS === "android" ? { borderRadius: DOCK_H / 2, boxShadow: shadows.e2 } : undefined}>
            <Glass liquid interactive={false} intensity={70} style={[styles.dock, { borderColor: c.line2 }]}>
              <View
                accessibilityRole="toolbar"
                accessibilityLabel={t("mobile.live.canvas.tools.label")}
                style={styles.dockRow}
              >
                <DockButton
                  icon="pointer"
                  label={t("mobile.live.canvas.tools.select")}
                  on={tool === "select"}
                  onPress={() => pick("select")}
                />
                {readOnly ? null : (
                  <>
                    <DockButton
                      icon="pen"
                      label={t("mobile.live.canvas.tools.pen")}
                      on={tool === "pen"}
                      onPress={() => toggle("pen")}
                    />
                    <DockButton icon="rect" label={t("mobile.live.canvas.tools.shapes")} onPress={chooseForm} />
                    <DockButton
                      icon="arrowTool"
                      label={t("mobile.live.canvas.tools.arrow")}
                      on={tool === "arrow"}
                      onPress={() => (tool === "arrow" ? pick("select") : chooseRoute())}
                    />
                    <DockButton
                      icon="textTool"
                      label={t("mobile.live.canvas.tools.text")}
                      onPress={() => addWords("text")}
                    />
                    <DockButton
                      icon="note"
                      label={t("mobile.live.canvas.tools.note")}
                      onPress={() => addWords("note")}
                    />
                    <DockButton
                      icon="photos"
                      label={
                        photos.busy > 0 ? t("mobile.live.slides.tools.sending") : t("mobile.live.canvas.tools.photo")
                      }
                      disabled={photos.busy > 0}
                      onPress={() => void addPhotos()}
                    />
                  </>
                )}
                <DockButton
                  icon="comment"
                  label={t("mobile.live.canvas.tools.comment")}
                  on={tool === "comment"}
                  onPress={() => toggle("comment")}
                />
              </View>
            </Glass>
          </View>
        </View>
        {tool === "pen" && !readOnly ? (
          <Animated.View
            {...fade}
            style={[styles.dockAt, { bottom: lineRoom + DOCK_H + 8 }, beside]}
            pointerEvents="box-none"
          >
            <PenBar pen={pen} onPen={setPen} />
          </Animated.View>
        ) : null}
        <FileTalkLine file={detail} floating />
        {cropping ? <CropOverlay box={cropping.box} onApply={crop} onCancel={() => setCropping(null)} /> : null}
      </View>
    </>
  );
}

/** The arrow tool's routes, in the web's order, with their marks. */
const ARROW_ROUTES: readonly ArrowRoute[] = ["straight", "curve", "elbow"];
const ROUTE_ICON: Record<ArrowRoute, IconName> = { straight: "line", curve: "curve", elbow: "elbow" };

/**
 * The pen's bar over the dock while drawing (the web's): the pen or the highlighter, the five colors, and three sizes
 * (F, M, G). What it sets is what the next strokes take.
 */
function PenBar({ pen, onPen }: { pen: PenStyle; onPen: (next: PenStyle) => void }) {
  const { t } = useTranslation();
  const { colors: c, scheme } = useTheme();
  return (
    <GlassBar>
      <View accessibilityRole="toolbar" accessibilityLabel={t("live.canvas.pen.label")} style={styles.penRow}>
        {(["pen", "marker"] as const).map((tool) => (
          <PressScale
            key={tool}
            haptic={false}
            onPress={() => onPen({ ...pen, tool })}
            accessibilityRole="button"
            accessibilityLabel={t(`live.canvas.pen.${tool}`)}
            accessibilityState={{ selected: pen.tool === tool }}
            style={[styles.penTool, pen.tool === tool && { backgroundColor: c.plate }]}
            contentStyle={styles.penToolIn}
          >
            <Icon name={tool === "pen" ? "pen" : "marker"} size={20} color={c.ink} />
          </PressScale>
        ))}
        <View style={[styles.divider, { backgroundColor: c.line2 }]} />
        {PEN_INKS.map((ink) => {
          const on = pen.color.toLowerCase() === ink.color;
          const shown = scheme === "dark" && isInk(ink.color) ? c.ink : ink.color;
          return (
            <PressScale
              key={ink.key}
              haptic={false}
              onPress={() => onPen({ ...pen, color: ink.color })}
              accessibilityRole="radio"
              accessibilityLabel={t(`live.canvas.inks.${ink.key}`)}
              accessibilityState={{ checked: on }}
              style={styles.penSwatchAt}
              contentStyle={styles.penSwatchAtIn}
            >
              <View
                style={[styles.penSwatch, { backgroundColor: shown }, on && [styles.penOn, { borderColor: c.ink }]]}
              />
            </PressScale>
          );
        })}
        <View style={[styles.divider, { backgroundColor: c.line2 }]} />
        {PEN_SIZES.map((size) => (
          <PressScale
            key={size}
            haptic={false}
            onPress={() => onPen({ ...pen, size })}
            accessibilityRole="radio"
            accessibilityLabel={t(`live.canvas.pen.sizes.${size}`)}
            accessibilityState={{ checked: pen.size === size }}
            style={[styles.penSize, pen.size === size && { backgroundColor: c.plate }]}
            contentStyle={styles.penSizeIn}
          >
            <Text variant="footnote" style={styles.penSizeWord}>
              {t(`live.canvas.pen.short.${size}`)}
            </Text>
          </PressScale>
        ))}
      </View>
    </GlassBar>
  );
}

/** What a shape's menu is titled: what it is ("Nota", "Imagem"), or how many things it acts on. */
function shapeTitle(t: (key: string, o?: Record<string, unknown>) => string, shape: ShapeView, count: number): string {
  if (count > 1) return t("live.canvas.count.items", { count });
  switch (shape.type) {
    case "image":
    case "pending":
      return t("live.canvas.kinds.image");
    case "frame":
      return shape.name || t("live.canvas.kinds.frame");
    case "html":
      return t("live.canvas.kinds.html");
    case "note":
      return t("live.canvas.tools.note");
    case "text":
      return t("live.canvas.tools.text");
    case "shape":
      return t("live.canvas.tools.shape");
    case "arrow":
      return t("live.canvas.tools.arrow");
    default:
      return t("live.canvas.label");
  }
}

/** A note color's swatch in the color menu. */
function NoteSwatch({ color }: { color: NoteColor }) {
  const { colors: c, scheme } = useTheme();
  const tint = NOTE_TINTS[color];
  return (
    <View
      style={[styles.swatch, { backgroundColor: scheme === "dark" ? tint.dark : tint.light, borderColor: c.line2 }]}
    />
  );
}

/** The dock: its buttons (a finger's 44) and its padding. */
const DOCK_BUTTON = 44;
const DOCK_PAD = 4;
const DOCK_H = DOCK_BUTTON + DOCK_PAD * 2;

/** One of the dock's tools: its icon, the one in use in ink (the app's chosen look), its name for VoiceOver. */
function DockButton({
  icon,
  label,
  on = false,
  disabled = false,
  onPress,
}: {
  icon: IconName;
  label: string;
  on?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  return (
    <PressScale
      haptic={false}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on, disabled }}
      style={[styles.dockButton, on && { backgroundColor: c.ink }, disabled && styles.off]}
      contentStyle={styles.dockButtonIn}
    >
      <Icon name={icon} size={22} color={on ? c.bg : c.ink} />
    </PressScale>
  );
}

/** The glass bar over the plane's top: a chosen picture's actions, or what the tool in use does. */
function GlassBar({ children }: { children: ReactNode }) {
  const { colors: c, shadows } = useTheme();
  return (
    <View style={Platform.OS === "android" ? { borderRadius: 16, boxShadow: shadows.e2 } : undefined}>
      <Glass liquid interactive={false} intensity={70} style={[styles.bar, { borderColor: c.line2 }]}>
        {children}
      </Glass>
    </View>
  );
}

/** One of the glass bar's actions: an icon (or the agent's face) and its words; `iconOnly` for "…". */
function BarButton({
  icon,
  face,
  label,
  iconOnly = false,
  onPress,
}: {
  icon?: IconName;
  face?: string;
  label: string;
  iconOnly?: boolean;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  return (
    <PressScale
      haptic={false}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.barButton, iconOnly && styles.barIcon]}
      contentStyle={[styles.barButtonIn, iconOnly && styles.barIconIn]}
    >
      {face ? <Face who={{ type: "agent", id: face }} size={20} live={false} /> : null}
      {icon ? <Icon name={icon} size={18} color={c.ink} /> : null}
      {iconOnly ? null : (
        <Text variant="subhead" numberOfLines={1} style={styles.barWords}>
          {label}
        </Text>
      )}
    </PressScale>
  );
}

/** The plane's shape while the canvas opens: its dots, quiet. */
function CanvasBones() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const pulse = usePulse();
  return (
    <Animated.View
      style={[styles.fill, styles.bones, { backgroundColor: c.bg }, pulse]}
      accessible
      accessibilityLabel={t("live.canvas.loading")}
      accessibilityState={{ busy: true }}
    >
      {Array.from({ length: 12 }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
        <View key={row} style={styles.boneRow}>
          {Array.from({ length: 8 }, (_, col) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
            <View key={col} style={[styles.dot, { backgroundColor: c.line2 }]} />
          ))}
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  empty: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SCREEN_X,
  },
  dockAt: { position: "absolute", left: 0, right: 0, alignItems: "center", paddingBottom: 8 },
  dock: {
    height: DOCK_H,
    padding: DOCK_PAD,
    borderRadius: DOCK_H / 2,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  dockRow: { flexDirection: "row", alignItems: "center" },
  dockButton: { width: DOCK_BUTTON, height: DOCK_BUTTON, borderRadius: DOCK_BUTTON / 2 },
  dockButtonIn: { alignItems: "center", justifyContent: "center" },
  off: { opacity: 0.4 },
  barAt: { position: "absolute", top: 12, left: SCREEN_X, right: SCREEN_X, alignItems: "flex-start" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 48,
    padding: 4,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  barButton: { minHeight: 40, minWidth: 44, paddingHorizontal: 10, borderRadius: 12 },
  barButtonIn: { flexDirection: "row", alignItems: "center", gap: 6 },
  barIcon: { paddingHorizontal: 0 },
  barIconIn: { justifyContent: "center" },
  barWords: { fontWeight: "600" },
  hint: { paddingHorizontal: 10, paddingVertical: 8 },
  penRow: { flexDirection: "row", alignItems: "center" },
  penTool: { width: 40, height: 44, borderRadius: 12 },
  penToolIn: { alignItems: "center", justifyContent: "center" },
  penSwatchAt: { width: 30, height: 44 },
  penSwatchAtIn: { alignItems: "center", justifyContent: "center" },
  penSwatch: { width: 22, height: 22, borderRadius: 11 },
  penOn: { borderWidth: 2 },
  penSize: { width: 30, height: 44, borderRadius: 10 },
  penSizeIn: { alignItems: "center", justifyContent: "center" },
  penSizeWord: { fontWeight: "600" },
  divider: { width: StyleSheet.hairlineWidth, height: 24, marginHorizontal: 4 },
  swatch: { width: 24, height: 24, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  bones: { paddingTop: 24, gap: 24, alignItems: "center" },
  boneRow: { flexDirection: "row", gap: 40 },
  dot: { width: 3, height: 3, borderRadius: 1.5 },
});
