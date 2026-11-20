import type { LiveRoom } from "@agenteschat/client";
import { nextFrame, useLiveDocVersion } from "@agenteschat/client";
import {
  type DeckView,
  deckTheme,
  readSlide,
  SLIDE_H,
  SLIDE_W,
  type SlideView,
  slideIdsOf,
} from "@agenteschat/live/slides";
import { useEffect, useMemo } from "react";
import type * as Y from "yjs";

/**
 * A presentation as plain data for drawing, read again only where it changed (ADR 0196 §2): a slide nobody touched
 * keeps the same `SlideView` object, so its thumbnail doesn't redraw while an agent writes a slide further down, and a
 * long deck stays quick to edit. While it isn't listening (before `attach`) every read reads everything.
 */
export class DeckReader {
  private readonly cache = new Map<string, SlideView>();
  private readonly dirty = new Set<string>();
  private readonly slides: Y.Map<Y.Map<unknown>>;
  private last: DeckView | null = null;
  private changed = true;
  private attached = false;

  constructor(private readonly doc: Y.Doc) {
    this.slides = doc.getMap<Y.Map<unknown>>("slides");
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    this.cache.clear();
    this.changed = true;
    this.slides.observeDeep(this.onChange);
    this.doc.getArray("slideOrder").observe(this.onOrder);
    this.doc.getMap("deck").observe(this.onOrder);
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.slides.unobserveDeep(this.onChange);
    this.doc.getArray("slideOrder").unobserve(this.onOrder);
    this.doc.getMap("deck").unobserve(this.onOrder);
  }

  private readonly onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    for (const event of events) {
      if (event.target === this.slides) {
        // The slides map itself: the keys are the slides added or deleted.
        for (const key of (event as Y.YMapEvent<unknown>).keysChanged) this.dirty.add(key);
      } else {
        const id = event.path[0];
        if (typeof id === "string") this.dirty.add(id);
      }
    }
    this.changed = true;
  };

  private readonly onOrder = () => {
    this.changed = true;
  };

  /** The deck now: unchanged slides are the same objects as last time. `_at`: the room's version asked for. */
  read(_at?: number): DeckView {
    if (this.attached && !this.changed && this.last) return this.last;
    if (!this.attached) this.cache.clear();
    const ids = slideIdsOf(this.doc);
    const slides: SlideView[] = [];
    ids.forEach((id, index) => {
      let view = this.dirty.has(id) ? undefined : this.cache.get(id);
      if (!view) {
        view = readSlide(this.doc, id) ?? undefined;
        if (!view) return;
      }
      if (view.index !== index) view = { ...view, index };
      this.cache.set(id, view);
      slides.push(view);
    });
    const kept = new Set(ids);
    for (const id of [...this.cache.keys()]) if (!kept.has(id)) this.cache.delete(id);
    this.dirty.clear();
    const deck = this.doc.getMap("deck");
    const w = deck.get("w");
    const h = deck.get("h");
    this.last = {
      theme: deckTheme(this.doc),
      w: typeof w === "number" && w > 0 ? w : SLIDE_W,
      h: typeof h === "number" && h > 0 ? h : SLIDE_H,
      slides,
    };
    this.changed = false;
    return this.last;
  }
}

/** The room's deck, redrawn at most once a frame. */
export function useDeck(room: LiveRoom): DeckView {
  const reader = useMemo(() => new DeckReader(room.doc), [room.doc]);
  useEffect(() => {
    reader.attach();
    return () => reader.detach();
  }, [reader]);
  const version = useLiveDocVersion(room, nextFrame);
  // `version` is read inside the memo, not only listed: the React Compiler keys a memo on what its body reads and drops
  // a dependency it doesn't, which kept the first deck on screen until a reload.
  return useMemo(() => reader.read(version), [reader, version]);
}
