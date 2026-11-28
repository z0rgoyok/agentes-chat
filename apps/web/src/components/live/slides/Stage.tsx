import type { LiveRoom } from "@agenteschat/client";
import { type Box, type Guide, groupMembersOf, outermostGroup, type Point } from "@agenteschat/live";
import type { Peer, PeerUser } from "@agenteschat/live/awareness";
import {
  type DeckView,
  type ElementPatch,
  type ElementView,
  elementTextFragment,
  type SlideTable,
  type SlideTheme,
  type SlideView,
} from "@agenteschat/live/slides";
import { cx, transferFiles } from "@agenteschat/ui";
import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { PeerCursors } from "../PeerCursor";
import { type PeerLook, PeerTag } from "../peers";
import { type CaretLook, type RichFormat, RichText, type RichTextHandle } from "../rich";
import { patchElements } from "./actions";
import {
  boundsOf,
  elementBounds,
  fitScale,
  HANDLES,
  type Handle,
  handleCursor,
  handleOffset,
  lineEnds,
  marqueeHits,
  moveLineEnd,
  rectFrom,
  resizeAll,
  resizeBox,
  rotationAt,
  roundBox,
  snapMove,
} from "./geometry";
import { Scaled, SlideBody, tableFontSize } from "./render";
import { useBoxSize } from "./useBoxSize";

/**
 * The slide being edited (ADR 0196 §2, §5), fitted in its room with a margin, its elements drawn as they are and
 * worked on in place: a press picks one (Shift or ⌘ adds), a drag moves the chosen ones with guides that snap them to
 * the slide's edges and middle and to the other elements' edges and middles (⌘ or Ctrl held: no snapping; Shift: along
 * one axis), the handles resize (Shift keeps the shape, as pictures always do) and the round one turns, a line's ends
 * move on their own, a drag on the empty slide draws a marquee. A double click (or a press on a text already chosen)
 * opens the text where it was pressed; a table's cells open the same way. What others chose shows in their color with
 * their name, and their pointers glide over the slide. Every change is written as it happens, so everyone sees a box
 * move while it moves; one drag is one step of the person's undo.
 */

/** What is being typed in: the element and where the caret starts. */
export interface EditTarget {
  id: string;
  at: Point | "end" | "all";
}

export interface StageProps {
  room: LiveRoom;
  deck: DeckView;
  slide: SlideView;
  theme: SlideTheme;
  readOnly: boolean;
  selected: readonly string[];
  onSelect(ids: string[]): void;
  editing: EditTarget | null;
  onEdit(target: EditTarget | null): void;
  /** The table whose cells are open. */
  tableEdit: string | null;
  onTableEdit(id: string | null): void;
  peers: Peer[];
  looks: (user: PeerUser) => PeerLook;
  /** The open text's handle (the toolbar runs its commands through it). */
  rich: RefObject<RichTextHandle | null>;
  onFormat(format: RichFormat): void;
  /** ⌘K in a text. */
  onLinkKey(): void;
  /** A double click on a chart (its data) or a picture (another one). */
  onOpen(el: ElementView): void;
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
  onCopy(e: ClipboardEvent<HTMLDivElement>): void;
  onCut(e: ClipboardEvent<HTMLDivElement>): void;
  onPaste(e: ClipboardEvent<HTMLDivElement>): void;
  onContextMenu(e: MouseEvent<HTMLDivElement>, id: string | null): void;
  /** Pictures dropped on the slide, and where (slide units). */
  onDropFiles(files: File[], at: Point): void;
  /** The words a screen reader hears for the slide ("Slide 3 de 12"). */
  label: string;
}

/** The room around the slide (page pixels): 32, and 16 on narrow screens. */
const MARGIN = 32;
const MARGIN_NARROW = 16;
/** Snapping reaches this far (page pixels). */
const SNAP_PX = 6;
/** A press that moves this far (page pixels) is a drag. */
const DRAG_SLOP = 3;
/** Where the turning handle sits above a box (page pixels). */
const ROTATE_GAP = 20;
/** The arrow keys' nudge in slide units; with Shift, ten times. */
export const NUDGE = 4;

type Gesture =
  | {
      kind: "press";
      id: string;
      client: Point;
      start: Point;
      wasSelected: boolean;
      additive: boolean;
      moving: boolean;
      boxes: Map<string, ElementView>;
    }
  | { kind: "resize"; handle: Handle; start: Point; boxes: Map<string, ElementView>; bounds: Box }
  | { kind: "rotate"; id: string; center: Point }
  | { kind: "line"; id: string; end: 0 | 1 }
  | { kind: "marquee"; start: Point; base: string[] };

const HEADLINE = new Set(["title", "number", "quote"]);

/** The element a pointer event is over (its `data-el`), or null. */
function elementAt(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest<HTMLElement>("[data-el]") : null;
  return el?.dataset.el ?? null;
}

/** Inside the text being typed (ProseMirror has the pointer and the keys there). */
function inText(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(".sl-el.is-editing .rt-editor, .sl-table__input");
}

export function Stage(props: StageProps) {
  const { t } = useTranslation();
  const { room, deck, slide, theme, readOnly, selected, editing, peers, looks } = props;
  const [measure, size] = useBoxSize<HTMLDivElement>();
  const wrap = useRef<HTMLDivElement | null>(null);
  const roomW = size.w || 960;
  const roomH = size.h || 540;
  const margin = roomW < 600 ? MARGIN_NARROW : MARGIN;
  const scale = fitScale(roomW, roomH, deck.w, deck.h, margin);
  const ox = (roomW - deck.w * scale) / 2;
  const oy = (roomH - deck.h * scale) / 2;
  const byId = useMemo(() => new Map(slide.elements.map((el) => [el.id, el])), [slide.elements]);
  const chosen = selected.map((id) => byId.get(id)).filter((el): el is ElementView => !!el);
  /** What a press on an element picks (ADR 0220 §3): the whole outermost group it sits in, or itself. */
  const pickOf = (id: string): string[] => {
    const group = byId.get(id)?.group;
    const groups = slide.groups ?? [];
    if (!group || !groups.some((g) => g.id === group)) return [id];
    const members = groupMembersOf(slide.elements, groups, outermostGroup(groups, group));
    return members.includes(id) ? [id, ...members.filter((m) => m !== id)] : [id];
  };
  const gesture = useRef<Gesture | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const pending = useRef<{ id: string; patch: ElementPatch }[] | null>(null);
  const frame = useRef(0);
  const savedTimeout = useRef<number | null>(null);
  const latest = useRef(props);
  latest.current = props;

  // ── Coordinates ────────────────────────────────────────────────────────────────────────────────────────────────

  const view = useRef({ scale, ox, oy });
  view.current = { scale, ox, oy };
  const toSlide = useCallback((clientX: number, clientY: number): Point => {
    const rect = wrap.current?.getBoundingClientRect();
    const v = view.current;
    return { x: (clientX - (rect?.left ?? 0) - v.ox) / v.scale, y: (clientY - (rect?.top ?? 0) - v.oy) / v.scale };
  }, []);
  const toScreen = useCallback((p: Point): Point => {
    const v = view.current;
    return { x: v.ox + p.x * v.scale, y: v.oy + p.y * v.scale };
  }, []);

  // ── Writing while dragging: one write a frame, one step of undo for the whole drag ─────────────────────────────

  const flush = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const patches = pending.current;
    pending.current = null;
    if (patches?.length) patchElements(room.doc, latest.current.slide.id, patches, { merge: true });
  }, [room]);
  const write = useCallback(
    (patches: { id: string; patch: ElementPatch }[]) => {
      pending.current = patches;
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    },
    [flush],
  );
  const beginStep = useCallback(() => {
    if (savedTimeout.current !== null) return;
    room.undo.stopCapturing();
    savedTimeout.current = room.undo.captureTimeout;
    room.undo.captureTimeout = Number.MAX_SAFE_INTEGER;
    setActive(true);
  }, [room]);
  const endStep = useCallback(() => {
    flush();
    if (savedTimeout.current === null) return;
    room.undo.captureTimeout = savedTimeout.current;
    savedTimeout.current = null;
    room.undo.stopCapturing();
    setActive(false);
  }, [room, flush]);
  useEffect(() => () => endStep(), [endStep]);

  // ── Presence: this person's pointer over the slide ─────────────────────────────────────────────────────────────

  const cursorFrame = useRef(0);
  const sendCursor = useCallback(
    (p: Point | null) => {
      cancelAnimationFrame(cursorFrame.current);
      cursorFrame.current = requestAnimationFrame(() => {
        if (room.destroyed) return;
        room.setLocal({ cursor: p ? { x: Math.round(p.x), y: Math.round(p.y), space: "slide" } : undefined });
      });
    },
    [room],
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(cursorFrame.current);
      if (!room.destroyed) room.setLocal({ cursor: undefined });
    },
    [room],
  );

  // ── Pointer ────────────────────────────────────────────────────────────────────────────────────────────────────

  const startOn = (e: PointerEvent<HTMLDivElement>, g: Gesture) => {
    gesture.current = g;
    wrap.current?.setPointerCapture?.(e.pointerId);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (inText(target)) return;
    wrap.current?.focus({ preventScroll: true });
    const p = toSlide(e.clientX, e.clientY);
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle;
    if (handle && !readOnly) {
      e.preventDefault();
      const boxes = new Map(chosen.map((el) => [el.id, el]));
      if (handle === "rotate" && chosen[0]) {
        const b = chosen[0];
        startOn(e, { kind: "rotate", id: b.id, center: { x: b.x + b.w / 2, y: b.y + b.h / 2 } });
      } else if ((handle === "end0" || handle === "end1") && chosen[0]) {
        startOn(e, { kind: "line", id: chosen[0].id, end: handle === "end0" ? 0 : 1 });
      } else {
        const bounds = chosen.length === 1 && chosen[0] ? chosen[0] : boundsOf(chosen);
        if (bounds) startOn(e, { kind: "resize", handle: handle as Handle, start: p, boxes, bounds });
      }
      return;
    }
    const id = elementAt(target);
    if (editing && id === editing.id) {
      // The open text's box, outside its words: the caret goes back into it.
      e.preventDefault();
      props.rich.current?.focus();
      return;
    }
    if (editing) props.onEdit(null);
    if (props.tableEdit && id !== props.tableEdit) props.onTableEdit(null);
    if (!id) {
      e.preventDefault();
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (!additive && selected.length) props.onSelect([]);
      if (!readOnly) startOn(e, { kind: "marquee", start: p, base: additive ? [...selected] : [] });
      return;
    }
    e.preventDefault();
    if (readOnly) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const wasSelected = selected.includes(id);
    // A press picks the element's group; a double click (or a press while it alone is chosen) goes inside it.
    const pick = pickOf(id);
    let next = [...selected];
    if (additive)
      next = wasSelected ? next.filter((s) => !pick.includes(s)) : [...next, ...pick.filter((p) => !next.includes(p))];
    else if (!wasSelected) next = pick;
    if (next.join() !== selected.join()) props.onSelect(next);
    const boxes = new Map(
      next
        .map((s) => byId.get(s))
        .filter((el): el is ElementView => !!el)
        .map((el) => [el.id, el]),
    );
    startOn(e, {
      kind: "press",
      id,
      client: { x: e.clientX, y: e.clientY },
      start: p,
      wasSelected,
      additive,
      moving: false,
      boxes,
    });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = toSlide(e.clientX, e.clientY);
    sendCursor(p);
    const g = gesture.current;
    if (!g) {
      const over = inText(e.target) ? null : elementAt(e.target);
      if (over !== hover) setHover(over);
      return;
    }
    const s = view.current.scale;
    if (g.kind === "press") {
      if (!g.moving) {
        if (Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < DRAG_SLOP) return;
        if (!g.boxes.size) return;
        g.moving = true;
        beginStep();
      }
      let dx = p.x - g.start.x;
      let dy = p.y - g.start.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const moving = [...g.boxes.values()];
      const bounds = boundsOf(moving);
      let found: Guide[] = [];
      if (bounds && !(e.metaKey || e.ctrlKey)) {
        const others = slide.elements.filter((el) => !g.boxes.has(el.id)).map(elementBounds);
        const snap = snapMove({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, others, deck, SNAP_PX / s);
        dx += e.shiftKey && dx === 0 ? 0 : snap.dx;
        dy += e.shiftKey && dy === 0 ? 0 : snap.dy;
        found = snap.guides;
      }
      setGuides(found);
      write(
        moving.map((el) => {
          const box = roundBox({ x: el.x + dx, y: el.y + dy, w: el.w, h: el.h });
          return { id: el.id, patch: { x: box.x, y: box.y } };
        }),
      );
      return;
    }
    if (g.kind === "resize") {
      beginStep();
      const delta = { x: p.x - g.start.x, y: p.y - g.start.y };
      const single = g.boxes.size === 1 ? [...g.boxes.values()][0] : null;
      if (single) {
        const ratio = e.shiftKey || single.type === "image" || single.type === "chart";
        const box = roundBox(resizeBox(single, single.rot ?? 0, g.handle, delta, ratio));
        write([{ id: single.id, patch: box }]);
      } else {
        const to = resizeBox(g.bounds, 0, g.handle, delta, e.shiftKey);
        const els = [...g.boxes.values()];
        const boxes = resizeAll(els.map(elementBounds), g.bounds, to);
        write(
          els.map((el, i) => {
            const b = boxes[i] ?? el;
            // A turned element keeps its turn: its box scales around its own middle.
            const bound = elementBounds(el);
            const sx = bound.w > 0 ? b.w / bound.w : 1;
            const sy = bound.h > 0 ? b.h / bound.h : 1;
            const w = el.w * sx;
            const h = el.h * sy;
            const box = roundBox({ x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h });
            return { id: el.id, patch: box };
          }),
        );
      }
      return;
    }
    if (g.kind === "rotate") {
      beginStep();
      const rot = rotationAt(g.center, p, e.shiftKey);
      write([{ id: g.id, patch: { rot: rot || null } }]);
      return;
    }
    if (g.kind === "line") {
      beginStep();
      const el = byId.get(g.id);
      if (el) write([{ id: g.id, patch: moveLineEnd(el, g.end, p, e.shiftKey) }]);
      return;
    }
    if (g.kind === "marquee") {
      const rect = rectFrom(g.start, p);
      setMarquee(rect);
      const hits = marqueeHits(slide.elements, rect);
      const next = [...new Set([...g.base, ...hits])];
      if (next.join() !== latest.current.selected.join()) props.onSelect(next);
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    wrap.current?.releasePointerCapture?.(e.pointerId);
    setGuides([]);
    setMarquee(null);
    endStep();
    if (g?.kind !== "press" || g.moving) return;
    // A press on a text already chosen, alone: the text opens where it was pressed.
    const el = byId.get(g.id);
    if (g.wasSelected && !g.additive && selected.length === 1 && (el?.type === "text" || el?.type === "shape")) {
      props.onEdit({ id: g.id, at: { x: e.clientX, y: e.clientY } });
    }
  };

  const onPointerCancel = () => {
    gesture.current = null;
    setGuides([]);
    setMarquee(null);
    endStep();
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (readOnly || inText(e.target)) return;
    const id = elementAt(e.target);
    const el = id ? byId.get(id) : undefined;
    if (!el) return;
    if (el.type === "text" || el.type === "shape") {
      props.onSelect([el.id]);
      props.onEdit({ id: el.id, at: { x: e.clientX, y: e.clientY } });
    } else if (el.type === "table") {
      props.onSelect([el.id]);
      props.onTableEdit(el.id);
    } else if (el.type === "chart" || el.type === "image") {
      props.onOpen(el);
    }
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (inText(e.target)) return;
    const id = elementAt(e.target);
    if (id && !selected.includes(id)) props.onSelect([id]);
    props.onContextMenu(e, id);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (readOnly || ![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const files = transferFiles(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    props.onDropFiles(files, toSlide(e.clientX, e.clientY));
  };

  // ── Texts: the one being typed in, and the ones others type in (their carets show) ────────────────────────────

  const caretLook = useCallback(
    (_clientId: number, user: PeerUser): CaretLook | null => {
      const look = looks(user);
      return { name: look.name, color: look.color };
    },
    [looks],
  );
  const placeholders = { title: t("live.slides.placeholder.title"), text: t("live.slides.placeholder.text") };
  /** Elements others have chosen on this slide, by id: whom. */
  const othersChose = useMemo(() => {
    const map = new Map<string, Peer[]>();
    for (const p of peers) {
      if (p.self || p.state.at?.slide !== slide.id) continue;
      for (const id of p.state.sel?.slide ?? []) map.set(id, [...(map.get(id) ?? []), p]);
    }
    return map;
  }, [peers, slide.id]);

  const slot = (el: ElementView): ReactNode | undefined => {
    if (el.type === "table" && props.tableEdit === el.id && el.table) {
      return (
        <TableCells
          room={room}
          slideId={slide.id}
          el={el}
          table={el.table}
          theme={theme}
          onClose={() => props.onTableEdit(null)}
        />
      );
    }
    if (el.type !== "text" && el.type !== "shape") return undefined;
    const mine = editing?.id === el.id && !readOnly;
    if (!mine && !othersChose.has(el.id)) return undefined;
    const fragment = elementTextFragment(room.doc, slide.id, el.id);
    if (!fragment) return undefined;
    return (
      <RichText
        key={mine ? `edit:${el.id}` : `peer:${el.id}`}
        ref={mine ? props.rich : undefined}
        fragment={fragment}
        label={el.type === "shape" ? t("live.slides.element.shapeText") : t("live.slides.element.text")}
        readOnly={!mine}
        awareness={room.awareness}
        look={caretLook}
        undoManager={room.undo}
        placeholder={
          mine && el.type === "text"
            ? el.role && HEADLINE.has(el.role)
              ? placeholders.title
              : placeholders.text
            : undefined
        }
        focusAt={mine ? editing?.at : null}
        onFormat={mine ? props.onFormat : undefined}
        onLink={mine ? props.onLinkKey : undefined}
        onEscape={mine ? () => props.onEdit(null) : undefined}
      />
    );
  };

  // ── Overlay (page pixels) ──────────────────────────────────────────────────────────────────────────────────────

  const place = (b: Box, rot = 0): CSSProperties => ({
    left: ox + b.x * scale,
    top: oy + b.y * scale,
    width: b.w * scale,
    height: b.h * scale,
    ...(rot ? { transform: `rotate(${rot}deg)` } : {}),
  });

  const single = chosen.length === 1 ? chosen[0] : null;
  const multiBounds = chosen.length > 1 ? boundsOf(chosen) : null;
  const hovered = hover && !selected.includes(hover) && !active ? byId.get(hover) : undefined;

  const handles = (w: number, h: number, rot: number) =>
    HANDLES.map((handle) => {
      const at = handleOffset(handle, w, h);
      return (
        <span
          key={handle}
          className="sl-handle"
          data-handle={handle}
          style={{ left: w / 2 + at.x, top: h / 2 + at.y, cursor: handleCursor(handle, rot) }}
        />
      );
    });

  return (
    <div
      ref={(el) => {
        wrap.current = el;
        measure(el);
      }}
      className="sl-stage"
      data-active={active ? "true" : undefined}
      role="application"
      aria-roledescription={t("live.slides.stage.role")}
      aria-label={props.label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the slide takes the keys (delete, arrows, copy and paste, undo)
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => {
        sendCursor(null);
        if (hover) setHover(null);
      }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={props.onKeyDown}
      onCopy={props.onCopy}
      onCut={props.onCut}
      onPaste={props.onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="sl-stage__slide" style={{ left: ox, top: oy }}>
        <Scaled scale={scale} w={deck.w} h={deck.h}>
          <SlideBody
            slide={slide}
            theme={theme}
            mode={readOnly ? "show" : "edit"}
            w={deck.w}
            h={deck.h}
            slot={slot}
            editing={editing?.id ?? null}
          />
        </Scaled>
      </div>
      <div className="sl-overlay" aria-hidden="true">
        {hovered && (
          <span
            className="sl-hover"
            style={place(
              hovered.type === "line" ? elementBounds(hovered) : hovered,
              hovered.type === "line" ? 0 : hovered.rot,
            )}
          />
        )}
        {[...othersChose.entries()].map(([id, who]) => {
          const el = byId.get(id);
          const first = who[0];
          if (!el || !first) return null;
          const look = looks(first.user);
          const box = el.type === "line" ? elementBounds(el) : el;
          return (
            <span
              key={`peer:${id}`}
              className="sl-peer"
              style={{ ...place(box, el.type === "line" ? 0 : el.rot), "--peer": look.color } as CSSProperties}
            >
              <PeerTag look={look} className="sl-peer__tag">
                {who.length > 1 ? t("live.slides.stage.peers", { name: look.name, count: who.length - 1 }) : look.name}
              </PeerTag>
            </span>
          );
        })}
        {chosen.length > 1 &&
          chosen.map((el) => (
            <span
              key={`sel:${el.id}`}
              className="sl-sel sl-sel--member"
              style={place(el.type === "line" ? elementBounds(el) : el, el.type === "line" ? 0 : el.rot)}
            />
          ))}
        {multiBounds && !readOnly && (
          <span className="sl-sel sl-sel--group" style={place(multiBounds)}>
            {!active && handles(multiBounds.w * scale, multiBounds.h * scale, 0)}
          </span>
        )}
        {single && single.type === "line" && !readOnly && <LineHandles el={single} toScreen={toScreen} />}
        {single && single.type !== "line" && (
          <span className={cx("sl-sel", editing?.id === single.id && "is-editing")} style={place(single, single.rot)}>
            {!readOnly && !(active && gesture.current?.kind === "press") && (
              <>
                {handles(single.w * scale, single.h * scale, single.rot ?? 0)}
                <span className="sl-rotate" data-handle="rotate" style={{ top: -ROTATE_GAP }} />
              </>
            )}
          </span>
        )}
        {guides.map((g, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the guides of one moment
            key={i}
            className={cx("sl-guide", g.axis === "x" ? "sl-guide--v" : "sl-guide--h")}
            style={
              g.axis === "x"
                ? { left: ox + g.at * scale, top: oy + g.from * scale, height: (g.to - g.from) * scale }
                : { top: oy + g.at * scale, left: ox + g.from * scale, width: (g.to - g.from) * scale }
            }
          />
        ))}
        {marquee && <span className="sl-marquee" style={place(marquee)} />}
      </div>
      <PeerCursors
        peers={peers}
        space="slide"
        toScreen={toScreen}
        where={(p) => p.state.at?.slide === slide.id && !p.state.presenting}
      />
    </div>
  );
}

/** A chosen line: its two ends, each moved on its own. */
function LineHandles({ el, toScreen }: { el: ElementView; toScreen: (p: Point) => Point }) {
  const [a, b] = lineEnds(el);
  const pa = toScreen(a);
  const pb = toScreen(b);
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  const angle = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
  return (
    <>
      <span
        className="sl-sel sl-sel--line"
        style={{ left: pa.x, top: pa.y, width: len, transform: `rotate(${angle}deg)` }}
      />
      <span className="sl-handle sl-handle--end" data-handle="end0" style={{ left: pa.x, top: pa.y }} />
      <span className="sl-handle sl-handle--end" data-handle="end1" style={{ left: pb.x, top: pb.y }} />
    </>
  );
}

/**
 * A table's cells open for typing. Each cell written is written alone into the table as it is now, so two people
 * typing in different cells of one table both keep their words; Tab and Enter move on, Esc closes.
 */
function TableCells({
  room,
  slideId,
  el,
  table,
  theme,
  onClose,
}: {
  room: LiveRoom;
  slideId: string;
  el: ElementView;
  table: SlideTable;
  theme: SlideTheme;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLTableElement>(null);
  const latest = useRef(table);
  latest.current = table;
  const [drafts, setDrafts] = useState<Map<string, string>>(() => new Map());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const commit = useCallback(() => {
    clearTimeout(timer.current);
    const changes = draftsRef.current;
    if (!changes.size) return;
    const rows = latest.current.rows.map((row) => [...row]);
    for (const [key, value] of changes) {
      const [r, c] = key.split(":").map(Number);
      const row = rows[r ?? -1];
      if (row && c !== undefined && c < row.length) row[c] = value;
    }
    patchElements(room.doc, slideId, [{ id: el.id, patch: { table: { rows, header: latest.current.header } } }]);
    setDrafts(new Map());
  }, [room, slideId, el.id]);

  useEffect(() => () => commit(), [commit]);
  useLayoutEffect(() => {
    host.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  const set = (r: number, c: number, value: string) => {
    setDrafts((d) => new Map(d).set(`${r}:${c}`, value));
    clearTimeout(timer.current);
    timer.current = setTimeout(commit, 300);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    const cols = latest.current.rows[0]?.length ?? 1;
    const rows = latest.current.rows.length;
    let next: [number, number] | null = null;
    if (e.key === "Tab")
      next = e.shiftKey ? (c > 0 ? [r, c - 1] : [r - 1, cols - 1]) : c < cols - 1 ? [r, c + 1] : [r + 1, 0];
    else if (e.key === "Enter") next = e.shiftKey ? [r - 1, c] : [r + 1, c];
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      commit();
      onClose();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    const [nr, nc] = next;
    if (nr < 0 || nr >= rows) {
      commit();
      return;
    }
    host.current?.querySelector<HTMLInputElement>(`input[data-cell="${nr}:${nc}"]`)?.focus();
  };

  return (
    <table ref={host} className="sl-table sl-table--edit" style={{ fontSize: tableFontSize(theme, el) }}>
      <tbody>
        {table.rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one table, in order
          <tr key={r} className={cx(table.header && r === 0 && "sl-table__head")}>
            {row.map((cell, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the cells of one row, in order
              <td key={c}>
                <input
                  className="sl-table__input"
                  data-cell={`${r}:${c}`}
                  value={drafts.get(`${r}:${c}`) ?? cell}
                  aria-label={t("live.slides.table.cell", { row: r + 1, col: c + 1 })}
                  maxLength={2000}
                  onChange={(e) => set(r, c, e.target.value)}
                  onKeyDown={(e) => onKeyDown(e, r, c)}
                  onBlur={commit}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
