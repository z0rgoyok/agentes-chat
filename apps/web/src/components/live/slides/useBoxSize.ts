import { type RefCallback, useCallback, useEffect, useRef, useState } from "react";

/** An element's size in page pixels, kept up to date (0×0 until measured, and where nothing is laid out). */
export function useBoxSize<T extends HTMLElement>(): [RefCallback<T>, { w: number; h: number }] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const last = useRef(size);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === last.current.w && h === last.current.h) return;
      last.current = { w, h };
      setSize({ w, h });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  const ref = useCallback((node: T | null) => setEl(node), []);
  return [ref, size];
}
