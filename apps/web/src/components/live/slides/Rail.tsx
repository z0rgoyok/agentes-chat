import type { Peer, PeerUser } from "@agenteschat/live/awareness";
import type { DeckView, SlideTheme } from "@agenteschat/live/slides";
import { Button, cx, Icon, Menu, MenuItem, MenuSeparator, useMatchMedia } from "@agenteschat/ui";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { type MenuEntry, openContextMenu } from "@/lib/context-menu";
import { PeerFace, type PeerLook, peerWorking } from "../peers";
import { SlideThumb } from "./SlideThumb";
import { useBoxSize } from "./useBoxSize";

/**
 * The slides of a presentation down the editor's left side (ADR 0196 §2), each drawn small and live (a slide an agent
 * writes changes here as it writes), numbered, the current one outlined in ink, hidden ones dimmed, with the faces of
 * who is on each. A drag moves a slide (Alt+↑/↓ too); ⋯ beside its number (never over the slide) and a right click
 * hold New slide, Duplicate, Hide, Present from here, Move and Delete. The thumbnails take the rail's width as it is
 * (a scrollbar's room taken out), so they are never cut. Under 760 px it is a strip under the slide.
 */

export interface RailProps {
  deck: DeckView;
  theme: SlideTheme;
  current: string | null;
  readOnly: boolean;
  /** Who else is on each slide. */
  peersBySlide: ReadonlyMap<string, Peer[]>;
  looks: (user: PeerUser) => PeerLook;
  onPick(id: string): void;
  onMove(id: string, to: number): void;
  onNewAfter(id: string): void;
  onDuplicate(id: string): void;
  onHide(id: string, hidden: boolean): void;
  onDelete(id: string): void;
  onPresentFrom(id: string): void;
}

/** A thumbnail's width in page pixels: beside the slide (at most; the rail's room decides), and in the strip under it. */
export const THUMB_W = 176;
export const THUMB_W_COMPACT = 112;
/** The number's column beside a thumbnail, and the list's right edge (the rail's CSS). */
const NUM_COL = 32;
const LIST_END = 8;
/** The narrowest a thumbnail gets beside the slide. */
const THUMB_MIN = 96;
/** A press that moves this far is a drag. */
const DRAG_SLOP = 4;
/** Faces shown on a thumbnail. */
const THUMB_FACES = 3;

interface Drag {
  id: string;
  from: number;
  /** Where it would land: the index among the other slides. */
  to: number;
  /** The drop line's offset in the list (px along it). */
  line: number;
}

export function Rail(props: RailProps) {
  const { t } = useTranslation();
  const { deck, current, readOnly } = props;
  const compact = useMatchMedia("(max-width: 760px)");
  const list = useRef<HTMLOListElement>(null);
  // The list's inner width (without its scrollbar, which a mouse's system draws in the rail's own room).
  const [measure, box] = useBoxSize<HTMLOListElement>();
  const placeList = useCallback(
    (el: HTMLOListElement | null) => {
      list.current = el;
      measure(el);
    },
    [measure],
  );
  const width = compact
    ? THUMB_W_COMPACT
    : box.w > 0
      ? Math.max(THUMB_MIN, Math.min(THUMB_W, box.w - NUM_COL - LIST_END))
      : THUMB_W;
  const press = useRef<{ id: string; x: number; y: number; pointer: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  /** The click that ends a drag doesn't also pick the slide. */
  const swallow = useRef(false);
  const count = deck.slides.length;

  // The current slide stays in view (a new one, one picked from the keys or by following someone).
  useEffect(() => {
    if (!current) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(current)}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);

  /** Where a slide dragged to (x, y) lands: the slot whose middle the pointer passed. */
  const target = (id: string, x: number, y: number): Drag | null => {
    const host = list.current;
    if (!host) return null;
    const items = [...host.querySelectorAll<HTMLElement>("li[data-slide]")];
    const from = items.findIndex((el) => el.dataset.slide === id);
    if (from < 0) return null;
    const rects = items.map((el) => el.getBoundingClientRect());
    const box = host.getBoundingClientRect();
    const along = (r: DOMRect) => (compact ? r.left + r.width / 2 : r.top + r.height / 2);
    const at = compact ? x : y;
    let slot = rects.findIndex((r) => at < along(r));
    if (slot < 0) slot = rects.length;
    const edge = (i: number) => {
      const r = rects[i];
      const last = rects[rects.length - 1];
      if (r) return compact ? r.left - box.left - 4 + host.scrollLeft : r.top - box.top - 6 + host.scrollTop;
      if (!last) return 0;
      return compact ? last.right - box.left + 4 + host.scrollLeft : last.bottom - box.top + 6 + host.scrollTop;
    };
    // Its index among the others: past its own place, one less.
    const to = slot > from ? slot - 1 : slot;
    return { id, from, to, line: edge(slot) };
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (readOnly || e.button !== 0 || e.pointerType === "touch") return;
    press.current = { id, x: e.clientX, y: e.clientY, pointer: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.pointer !== e.pointerId) return;
    if (!dragRef.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
    if (!dragRef.current) e.currentTarget.setPointerCapture?.(e.pointerId);
    const next = target(p.id, e.clientX, e.clientY);
    if (next) setDrag(next);
    // Near the rail's ends it scrolls along.
    const host = list.current;
    if (host) {
      const box = host.getBoundingClientRect();
      const at = compact ? e.clientX - box.left : e.clientY - box.top;
      const size = compact ? box.width : box.height;
      const step = at < 32 ? -12 : at > size - 32 ? 12 : 0;
      if (step) host.scrollBy?.(compact ? { left: step } : { top: step });
    }
  };
  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    press.current = null;
    const done = dragRef.current;
    if (!p || !done) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDrag(null);
    swallow.current = true;
    if (done.to !== done.from) props.onMove(done.id, done.to);
  };
  const onPointerCancel = () => {
    press.current = null;
    setDrag(null);
  };

  const focusSlide = (id: string | undefined) => {
    if (!id) return;
    props.onPick(id);
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(id)}"] .sl-rail__thumb`)?.focus(),
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: string, index: number) => {
    const back = compact ? "ArrowLeft" : "ArrowUp";
    const forth = compact ? "ArrowRight" : "ArrowDown";
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === back || e.key === forth) && e.altKey && !readOnly) {
      e.preventDefault();
      const to = index + (e.key === back ? -1 : 1);
      if (to >= 0 && to < count) {
        props.onMove(id, to);
        requestAnimationFrame(() =>
          list.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(id)}"] .sl-rail__thumb`)?.focus(),
        );
      }
    } else if (e.key === back || e.key === forth) {
      e.preventDefault();
      focusSlide(deck.slides[index + (e.key === back ? -1 : 1)]?.id);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focusSlide(deck.slides[e.key === "Home" ? 0 : count - 1]?.id);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) {
      e.preventDefault();
      props.onDelete(id);
    } else if (mod && e.key.toLowerCase() === "d" && !readOnly) {
      e.preventDefault();
      props.onDuplicate(id);
    } else if (e.key === "Enter" && !mod && !readOnly) {
      e.preventDefault();
      props.onNewAfter(id);
    }
  };

  const entries = (id: string, index: number, hidden: boolean): MenuEntry[] => {
    const out: MenuEntry[] = [];
    if (!readOnly) {
      out.push({
        kind: "item",
        id: "new",
        label: t("live.slides.rail.newAfter"),
        icon: "plus",
        run: () => props.onNewAfter(id),
      });
      out.push({
        kind: "item",
        id: "dup",
        label: t("live.slides.rail.duplicate"),
        icon: "copy",
        run: () => props.onDuplicate(id),
      });
      out.push({
        kind: "item",
        id: "hide",
        label: hidden ? t("live.slides.rail.show") : t("live.slides.rail.hide"),
        icon: hidden ? "eye" : "eyeOff",
        run: () => props.onHide(id, !hidden),
      });
    }
    out.push({
      kind: "item",
      id: "present",
      label: t("live.slides.rail.presentFrom"),
      icon: "present",
      run: () => props.onPresentFrom(id),
    });
    if (!readOnly) {
      out.push({ kind: "separator" });
      out.push({
        kind: "item",
        id: "up",
        label: t("live.slides.rail.moveUp"),
        icon: "arrowUp",
        disabled: index === 0,
        run: () => props.onMove(id, index - 1),
      });
      out.push({
        kind: "item",
        id: "down",
        label: t("live.slides.rail.moveDown"),
        icon: "arrowDown",
        disabled: index >= count - 1,
        run: () => props.onMove(id, index + 1),
      });
      out.push({ kind: "separator" });
      out.push({
        kind: "item",
        id: "delete",
        label: t("live.slides.rail.delete"),
        icon: "trash",
        danger: true,
        run: () => props.onDelete(id),
      });
    }
    return out;
  };

  return (
    <nav className="sl-rail" aria-label={t("live.slides.rail.label")} data-dragging={drag ? "true" : undefined}>
      <ol ref={placeList} className="sl-rail__list">
        {deck.slides.map((slide, index) => {
          const here = props.peersBySlide.get(slide.id) ?? [];
          const isCurrent = slide.id === current;
          const label = slide.hidden
            ? t("live.slides.rail.slideHidden", { n: index + 1 })
            : t("live.slides.rail.slide", { n: index + 1 });
          return (
            <li
              key={slide.id}
              className={cx(
                "sl-rail__item",
                isCurrent && "is-current",
                slide.hidden && "is-hidden",
                drag?.id === slide.id && "is-dragged",
              )}
              data-slide={slide.id}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                props.onPick(slide.id);
                openContextMenu(e.clientX, e.clientY, entries(slide.id, index, !!slide.hidden), e.target);
              }}
            >
              <span className="sl-rail__side">
                <span className="sl-rail__num tabular" aria-hidden="true">
                  {index + 1}
                  {slide.hidden && <Icon name="eyeOff" size={14} className="sl-rail__hidden" />}
                </span>
                <Menu
                  label={t("live.slides.rail.more", { n: index + 1 })}
                  align="start"
                  trigger={
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon="more"
                      className="sl-rail__more"
                      aria-label={t("live.slides.rail.more", { n: index + 1 })}
                      title={t("live.slides.rail.more", { n: index + 1 })}
                      tabIndex={-1}
                    />
                  }
                >
                  {entries(slide.id, index, !!slide.hidden).map((entry, i) =>
                    entry.kind === "separator" ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: separators of one fixed menu
                      <MenuSeparator key={`sep${i}`} />
                    ) : entry.kind === "item" ? (
                      <MenuItem
                        key={entry.id}
                        icon={entry.icon}
                        danger={entry.danger}
                        disabled={entry.disabled}
                        onSelect={entry.run}
                      >
                        {entry.label}
                      </MenuItem>
                    ) : null,
                  )}
                </Menu>
              </span>
              <span className="sl-rail__frame">
                <button
                  type="button"
                  className="sl-rail__thumb"
                  aria-label={label}
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => {
                    if (swallow.current) {
                      swallow.current = false;
                      return;
                    }
                    props.onPick(slide.id);
                  }}
                  onKeyDown={(e) => onKeyDown(e, slide.id, index)}
                  onPointerDown={(e) => onPointerDown(e, slide.id)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancel}
                >
                  <SlideThumb slide={slide} theme={props.theme} width={width} deck={deck} />
                </button>
                {here.length > 0 && (
                  <span className="sl-rail__faces">
                    {here.slice(0, THUMB_FACES).map((p) => {
                      const look = props.looks(p.user);
                      return (
                        <PeerFace
                          key={p.clientId}
                          user={p.user}
                          name={look.name}
                          color={look.color}
                          size="xs"
                          working={peerWorking(p)}
                          ring
                          labelled
                        />
                      );
                    })}
                  </span>
                )}
              </span>
            </li>
          );
        })}
        {drag && (
          <li className="sl-rail__drop" aria-hidden="true" style={compact ? { left: drag.line } : { top: drag.line }} />
        )}
      </ol>
    </nav>
  );
}
