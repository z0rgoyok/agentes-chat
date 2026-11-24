import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

/** A size kept on this device (per person: localStorage), within its bounds. */
export function useStoredSize(key: string, min: number, max: number, start: number) {
  const read = () => {
    try {
      const v = Number(localStorage.getItem(key));
      return Number.isFinite(v) && v >= min && v <= max ? v : start;
    } catch {
      return start;
    }
  };
  const [size, setSize] = useState(read);
  const save = (s: number) => {
    try {
      localStorage.setItem(key, String(s));
    } catch {}
  };
  return { size, setSize, save, min, max, start };
}

/**
 * The drag between two of the Code page's surfaces (ADR 0215). Upright (`x`), it sets the width of the one on its
 * left; across (`y`), the height of the one under it (the terminal). Arrows move it by 24 px, double click puts it
 * back; the size is kept on this device.
 */
export function CodeGutter({
  label,
  size,
  axis = "x",
}: {
  label: string;
  size: ReturnType<typeof useStoredSize>;
  axis?: "x" | "y";
}) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const clamp = (s: number) => Math.round(Math.max(size.min, Math.min(size.max, s)));
  const at = (e: ReactPointerEvent<HTMLDivElement>) => (axis === "x" ? e.clientX : e.clientY);
  // Across, the pane is under it: dragging up makes it taller.
  const sign = axis === "x" ? 1 : -1;
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    start.current = { at: at(e), size: size.size };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    size.setSize(clamp(start.current.size + sign * (at(e) - start.current.at)));
  };
  const up = () => {
    if (start.current) size.save(size.size);
    start.current = null;
  };
  const keys = axis === "x" ? { less: "ArrowLeft", more: "ArrowRight" } : { less: "ArrowDown", more: "ArrowUp" };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable separator between two panes, as the live file's grip
    <div
      className={axis === "x" ? "code-gutter" : "code-gutter code-gutter--y"}
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={size.size}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => {
        size.setSize(size.start);
        size.save(size.start);
      }}
      onKeyDown={(e) => {
        if (e.key !== keys.less && e.key !== keys.more) return;
        e.preventDefault();
        const next = clamp(size.size + (e.key === keys.less ? -24 : 24));
        size.setSize(next);
        size.save(next);
      }}
    />
  );
}
