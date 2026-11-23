import type { LiveRoom } from "@agenteschat/client";
import { nextFrame } from "@agenteschat/client";
import { compareStack } from "@agenteschat/live";
import { readShape, type ShapeView, shapesMapOf } from "@agenteschat/live/canvas";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import * as Y from "yjs";

/**
 * A canvas's shapes as plain data, kept in step with the document by re-reading only the shapes a change touched
 * (ADR 0196 §2: a canvas holds up to 5,000 shapes, and an agent or a person moving one shouldn't re-read them all).
 * Each unchanged shape keeps its object, so the shapes drawn from it don't redraw. Redraws wait for the next frame,
 * so a burst of changes (a drag, an agent placing images) draws once a frame.
 */
export interface ShapesSnapshot {
  /** In drawing order: frames first, then the rest, each by stacking key. */
  list: readonly ShapeView[];
  byId: ReadonlyMap<string, ShapeView>;
  version: number;
}

const byDrawing = (a: ShapeView, b: ShapeView) =>
  Number(b.type === "frame") - Number(a.type === "frame") || compareStack(a, b);

export class CanvasShapes {
  private readonly map: Y.Map<Y.Map<unknown>>;
  private views = new Map<string, ShapeView>();
  private snap: ShapesSnapshot;
  private readonly listeners = new Set<() => void>();
  private cancel: (() => void) | null = null;

  private attached = false;

  constructor(doc: Y.Doc) {
    this.map = shapesMapOf(doc);
    this.map.forEach((value, id) => {
      this.read(id, value);
    });
    this.snap = this.build(0);
  }

  /** Starts following the document (reading it again whole, in case it changed meanwhile). */
  attach() {
    if (this.attached) return;
    this.attached = true;
    this.views.clear();
    this.map.forEach((value, id) => {
      this.read(id, value);
    });
    this.snap = this.build(this.snap.version + 1);
    this.map.observeDeep(this.onChange);
    for (const l of [...this.listeners]) l();
  }

  /** Stops following it (the screen let go of it). */
  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.cancel?.();
    this.cancel = null;
    this.map.unobserveDeep(this.onChange);
  }

  private read(id: string, value: unknown) {
    const view = value instanceof Y.Map ? readShape(id, value as Y.Map<unknown>) : null;
    if (view) this.views.set(id, view);
    else this.views.delete(id);
  }

  private build(version: number): ShapesSnapshot {
    const list = [...this.views.values()].sort(byDrawing);
    return { list, byId: new Map(list.map((s) => [s.id, s])), version };
  }

  private readonly onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    const dirty = new Set<string>();
    for (const event of events) {
      if (event.target === this.map) {
        for (const key of event.changes.keys.keys()) dirty.add(key);
        continue;
      }
      const first = event.path[0];
      if (typeof first === "string") dirty.add(first);
    }
    for (const id of dirty) this.read(id, this.map.get(id));
    if (!dirty.size) return;
    this.cancel ??= nextFrame(() => {
      this.cancel = null;
      this.snap = this.build(this.snap.version + 1);
      for (const l of [...this.listeners]) l();
    });
  };

  /** The shapes now, as of the last frame. */
  readonly get = (): ShapesSnapshot => this.snap;

  /** The shapes right now, without waiting for the frame (after the person's own edit, to act on it at once). */
  now(): ShapesSnapshot {
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
      this.snap = this.build(this.snap.version + 1);
    }
    return this.snap;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/** The canvas's shapes for the room's document, redrawn once a frame when they change. */
export function useCanvasShapes(room: LiveRoom): { store: CanvasShapes; snapshot: ShapesSnapshot } {
  const store = useMemo(() => new CanvasShapes(room.doc), [room.doc]);
  useEffect(() => {
    store.attach();
    return () => store.detach();
  }, [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { store, snapshot };
}
