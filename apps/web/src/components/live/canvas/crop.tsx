import type { Box, ShapeView } from "@agenteschat/live/canvas";
import { type CSSProperties, type PointerEvent, useRef } from "react";
import { boxToScreen, type Camera } from "./camera";
import { dragCrop, fullImageBox, HANDLES, type Handle } from "./edit-math";

/**
 * Cropping a picture on the canvas (ADR 0196 §2): the whole picture shows faint around the window that keeps a part of
 * it; the window's handles and the window itself (dragged whole) move inside the picture, never past it. The plane
 * applies it (Enter, ✓, a press elsewhere) as the picture's new box and `crop`, or leaves it as it was (Esc).
 */
export function CropOverlay({
  shape,
  rect,
  cam,
  src,
  onChange,
}: {
  shape: ShapeView;
  /** The window, in world units. */
  rect: Box;
  cam: Camera;
  src: string;
  onChange(rect: Box): void;
}) {
  const drag = useRef<{ handle: Handle | "move"; base: Box; x: number; y: number; id: number } | null>(null);
  const full = fullImageBox(shape);
  const whole = boxToScreen(cam, full);
  const win = boxToScreen(cam, rect);
  const start = (handle: Handle | "move") => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { handle, base: rect, x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    e.stopPropagation();
    const delta = { x: (e.clientX - d.x) / cam.z, y: (e.clientY - d.y) / cam.z };
    onChange(dragCrop(d.base, full, d.handle, delta));
  };
  const end = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    e.stopPropagation();
    drag.current = null;
  };
  const box = (b: Box): CSSProperties => ({ left: b.x, top: b.y, width: b.w, height: b.h });
  return (
    <div className="cnv-crop">
      <img className="cnv-crop__ghost" src={src} alt="" draggable={false} style={box(whole)} />
      <div
        className="cnv-crop__window"
        data-crop-part="move"
        style={box(win)}
        onPointerDown={start("move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div className="cnv-crop__view">
          <img
            className="cnv-crop__picture"
            src={src}
            alt=""
            draggable={false}
            style={box({ x: whole.x - win.x, y: whole.y - win.y, w: whole.w, h: whole.h })}
          />
        </div>
        {HANDLES.map((h) => (
          <span
            key={h}
            className="cnv-over__handle cnv-crop__handle"
            data-crop-part={h}
            data-pos={h}
            onPointerDown={start(h)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        ))}
      </div>
    </div>
  );
}
